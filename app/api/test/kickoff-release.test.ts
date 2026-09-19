/**
 * 킥오프권(추첨·재경기 교대·실점 팀 킥오프)과 패스 직후 재소유 유예 회귀 테스트.
 *
 * 고정 dt 틱과 고정 시드 난수만 쓴다. 각 판단마다 "그 규칙이 없으면 다르게 된다" 는
 * 대조군을 함께 둔다.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
  BALL,
  DRIBBLE,
  KICKOFF,
  MATCH,
  PASS,
  PITCH,
  PLAYER,
  ROLES,
  kickoffSpotFor,
  spawnFor,
  type Side,
} from "../src/game/constants.ts";
import { Match, neutralInput, type Player, type SimEvent } from "../src/game/sim.ts";
import type { InputState } from "../src/protocol.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const realRandom = Math.random;
beforeEach(() => {
  Math.random = mulberry32(20260919);
});
afterEach(() => {
  Math.random = realRandom;
});

const DT = 1 / MATCH.tickHz;
const SIDES: readonly Side[] = ["left", "right"];

function ticksFor(ms: number): number {
  return Math.ceil(ms / (DT * 1000));
}

function run(match: Match, ticks: number, onTick?: () => void): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i += 1) {
    onTick?.();
    events.push(...match.step(DT));
  }
  return events;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function other(side: Side): Side {
  return side === "left" ? "right" : "left";
}

/** 첫 경기 추첨 결과를 고정한다. `startMatch` 가 부르는 첫 Math.random 만 이 값을 받는다. */
function startWithDraw(match: Match, draw: number): void {
  const seeded = Math.random;
  Math.random = () => draw;
  try {
    match.startMatch();
  } finally {
    Math.random = seeded;
  }
}

/** 카운트다운을 넘기고 첫 소유자가 나올 때까지 돌린다. */
function firstOwnerAfterKickoff(match: Match): Player | null {
  run(match, ticksFor(MATCH.kickoffCountdownMs) + 1);
  assert.equal(match.phase, "playing");
  for (let i = 0; i < 180; i += 1) {
    match.step(DT);
    if (match.ball.ownerId) return match.byId.get(match.ball.ownerId) ?? null;
  }
  return null;
}

function assertKickoffFormation(match: Match): void {
  assert.equal(match.players.length, 6, "선수는 늘 6명");
  for (const side of SIDES) assert.equal(match.team(side).length, 3, `${side} 팀 3명`);
  for (const p of match.players) {
    const s = kickoffSpotFor(p.side, p.role, match.kickoffSide);
    assert.ok(dist(p, s) < 1e-9, `${p.id} 이 킥오프 자리에 있어야 한다`);
    assert.equal(p.vx, 0);
    assert.equal(p.vy, 0);
    assert.ok(p.x > 0 && p.x < PITCH.length && p.y > 0 && p.y < PITCH.width, `${p.id} 경기장 안`);
  }
  for (let i = 0; i < 6; i += 1) {
    for (let j = i + 1; j < 6; j += 1) {
      const a = match.players[i]!;
      const b = match.players[j]!;
      assert.ok(dist(a, b) >= PLAYER.radius * 2, `${a.id}-${b.id} 겹치지 않는다`);
    }
  }
  assert.equal(match.ball.x, PITCH.length / 2);
  assert.equal(match.ball.y, PITCH.width / 2);
  assert.equal(match.ball.ownerId, null);
  for (const p of match.players) {
    assert.ok(dist(p, match.ball) > PLAYER.radius + BALL.radius, `${p.id} 가 공과 겹치지 않는다`);
  }
}

// ---------------------------------------------------------------------------
// F2. 킥오프권
// ---------------------------------------------------------------------------

describe("킥오프권", () => {
  test("킥커 자리는 양 팀이 정확히 대칭이고, 나머지 다섯 명은 기본 대형 그대로다", () => {
    const lt = kickoffSpotFor("left", KICKOFF.takerRole, "left");
    const rt = kickoffSpotFor("right", KICKOFF.takerRole, "right");
    const center = { x: PITCH.length / 2, y: PITCH.width / 2 };
    assert.equal(dist(lt, center), dist(rt, center), "공까지 거리가 비트 단위로 같다");
    assert.equal(lt.x + rt.x, PITCH.length);
    assert.equal(lt.y, rt.y);
    assert.ok(lt.x < center.x && rt.x > center.x, "킥커는 자기 진영 쪽에 선다");
    assert.ok(KICKOFF.takerGap < DRIBBLE.range, "움직이기 시작하면 곧 드리블이 걸리는 거리");

    for (const kick of SIDES) {
      for (const side of SIDES) {
        for (const role of ROLES) {
          if (side === kick && role === KICKOFF.takerRole) continue;
          assert.deepEqual(kickoffSpotFor(side, role, kick), spawnFor(side, role), `${side}/${role}`);
        }
      }
      // 상대 공격수는 드리블 범위 밖, 킥커보다 확실히 멀다
      const opp = spawnFor(other(kick), KICKOFF.takerRole);
      assert.ok(dist(opp, center) > DRIBBLE.range);
      assert.ok(dist(opp, center) - KICKOFF.takerGap > 2);
    }
  });

  for (const [draw, expected] of [
    [0.1, "left"],
    [0.9, "right"],
  ] as const) {
    test(`첫 경기는 서버 추첨으로 정한다 (추첨 ${draw} → ${expected})`, () => {
      const match = new Match();
      startWithDraw(match, draw);
      assert.equal(match.kickoffSide, expected);
      assertKickoffFormation(match);
      const taker = match.team(expected).find((p) => p.role === KICKOFF.takerRole)!;
      assert.ok(Math.abs(dist(taker, match.ball) - KICKOFF.takerGap) < 1e-9);
    });
  }

  test("카운트다운 동안 킥오프 배치가 그대로 유지된다", () => {
    const match = new Match();
    match.humanSides.left = true;
    startWithDraw(match, 0.9);
    match.setInput("left", { ...neutralInput(), ax: 1, sprint: true, seq: 1 });
    const before = match.players.map((p) => `${p.id}:${p.x},${p.y}`);
    run(match, ticksFor(MATCH.kickoffCountdownMs - 100));
    assert.equal(match.phase, "countdown");
    assert.deepEqual(match.players.map((p) => `${p.id}:${p.x},${p.y}`), before);
  });

  for (const side of SIDES) {
    test(`AI 끼리: 킥오프권을 가진 ${side} 팀이 첫 소유를 가져간다`, () => {
      const match = new Match();
      startWithDraw(match, side === "left" ? 0.1 : 0.9);
      assert.equal(match.kickoffSide, side);
      const owner = firstOwnerAfterKickoff(match);
      assert.ok(owner, "누군가 공을 잡아야 한다");
      assert.equal(owner!.side, side);
      assert.equal(owner!.role, KICKOFF.takerRole);
    });
  }

  test("대조군: 킥오프권 배치가 없으면(양 팀 기본 대형) 늘 같은 팀이 이긴다", () => {
    const winners = new Set<Side>();
    for (const draw of [0.1, 0.9]) {
      const match = new Match();
      startWithDraw(match, draw);
      // 킥커 배치를 걷어 내 예전처럼 양 팀 공격수가 대칭 대형에서 경합하게 한다
      for (const p of match.players) p.resetToSpawn(spawnFor(p.side, p.role));
      const seeded = Math.random;
      Math.random = () => 0.5; // 흔들기 0: 완전 대칭 입력
      try {
        const owner = firstOwnerAfterKickoff(match);
        assert.ok(owner);
        winners.add(owner!.side);
      } finally {
        Math.random = seeded;
      }
    }
    assert.equal(winners.size, 1, "추첨과 무관하게 한쪽이 고정으로 이긴다(고치기 전 문제)");
  });

  test("완전 대칭 입력에서도 킥오프권이 첫 소유를 정한다", () => {
    for (const draw of [0.1, 0.9]) {
      const match = new Match();
      startWithDraw(match, draw);
      const seeded = Math.random;
      Math.random = () => 0.5;
      try {
        const owner = firstOwnerAfterKickoff(match);
        assert.equal(owner?.side, draw < 0.5 ? "left" : "right");
      } finally {
        Math.random = seeded;
      }
    }
  });

  for (const scorer of SIDES) {
    test(`${scorer} 팀이 넣으면 실점한 팀이 다음 킥오프를 차고 먼저 소유한다`, () => {
      const match = new Match();
      // 득점한 팀이 경기 첫 킥오프를 가졌던 경우: 득점 뒤에는 반대로 바뀌어야 한다
      startWithDraw(match, scorer === "left" ? 0.1 : 0.9);
      run(match, ticksFor(MATCH.kickoffCountdownMs) + 1);
      assert.equal(match.kickoffSide, scorer);

      for (const p of match.players) p.proneMs = 60_000; // 골 장면에 끼어들지 않게
      const goalX = scorer === "left" ? PITCH.length - 0.4 : 0.4;
      match.ball = {
        x: goalX,
        y: PITCH.width / 2,
        vx: scorer === "left" ? 12 : -12,
        vy: 0,
        spin: 0,
        ownerId: null,
      };
      const events = run(match, 10);
      assert.ok(events.some((e) => e.kind === "goal" && e.side === scorer));
      const conceded = other(scorer);
      assert.equal(match.kickoffSide, conceded);

      run(match, ticksFor(MATCH.goalCelebrationMs) + 2);
      assert.equal(match.phase, "countdown");
      assertKickoffFormation(match);
      const owner = firstOwnerAfterKickoff(match);
      assert.equal(owner?.side, conceded, "실점한 팀이 먼저 공을 잡는다");
    });
  }

  test("재경기의 첫 킥오프는 직전 경기 첫 킥오프와 번갈아 간다(마지막 실점 팀과 무관)", () => {
    const match = new Match();
    startWithDraw(match, 0.1);
    assert.equal(match.kickoffSide, "left");
    // 경기 중 오른쪽이 넣어 마지막 킥오프권이 왼쪽으로 돌아왔어도
    match.kickoffSide = "left";
    match.phase = "ended";
    // 재경기에서는 추첨 값과 상관없이 교대한다
    startWithDraw(match, 0.1);
    assert.equal(match.kickoffSide, "right");
    assertKickoffFormation(match);
    startWithDraw(match, 0.9);
    assert.equal(match.kickoffSide, "left");
    startWithDraw(match, 0.1);
    assert.equal(match.kickoffSide, "right");
  });

  test("새 Match(새 방)는 다시 추첨한다", () => {
    const seen = new Set<Side>();
    for (const draw of [0.1, 0.9]) {
      const match = new Match();
      startWithDraw(match, draw);
      seen.add(match.kickoffSide);
    }
    assert.equal(seen.size, 2);
  });
});

// ---------------------------------------------------------------------------
// F1. 패스 직후 재소유 유예
// ---------------------------------------------------------------------------

let seq = 1;
function press(match: Match, side: Side, patch: Partial<InputState>): void {
  match.setInput(side, { ...neutralInput(), ...patch, seq: seq++ });
}

function place(match: Match, id: string, x: number, y: number, vx = 0, vy = 0): Player {
  const p = match.byId.get(id)!;
  p.x = x;
  p.y = y;
  p.vx = vx;
  p.vy = vy;
  p.facing = Math.atan2(vy, vx || 1);
  return p;
}

/** 사람 L3 가 공을 몰고 오른쪽으로 뛰다가 앞의 L2 에게 패스하는 장면 */
function runningPassFixture(): Match {
  const match = new Match();
  match.humanSides.left = true;
  match.humanSides.right = true;
  startWithDraw(match, 0.1);
  run(match, ticksFor(MATCH.kickoffCountdownMs) + 1);
  place(match, "L3", 20, 17, 6, 0);
  place(match, "L2", 30, 17);
  place(match, "L1", 6, 30);
  place(match, "R1", 50, 3);
  place(match, "R2", 50, 31);
  place(match, "R3", 54, 17);
  match.controlled.left = "L3";
  match.ball = { x: 20.85, y: 17, vx: 6, vy: 0, spin: 0, ownerId: "L3" };
  return match;
}

/** 패스를 누른 틱부터 n 틱 동안 소유자 기록. 패스한 선수는 계속 같은 방향으로 달린다. */
function passAndTrace(match: Match, ticks: number): { owners: (string | null)[]; events: SimEvent[] } {
  const owners: (string | null)[] = [];
  const events: SimEvent[] = [];
  press(match, "left", { ax: 1, pass: true });
  events.push(...match.step(DT));
  owners.push(match.ball.ownerId);
  for (let i = 1; i < ticks; i += 1) {
    press(match, "left", { ax: 1 });
    events.push(...match.step(DT));
    owners.push(match.ball.ownerId);
  }
  return { owners, events };
}

describe("패스 직후 재소유 유예", () => {
  test("실제로 찬 패스 뒤 유예 동안 패스한 선수는 공을 다시 붙잡지 않는다", () => {
    const match = runningPassFixture();
    const { owners, events } = passAndTrace(match, ticksFor(PASS.releaseMs));
    assert.ok(events.some((e) => e.kind === "pass" && e.playerId === "L3" && e.targetId === "L2"));
    assert.ok(!owners.includes("L3"), `L3 가 다시 소유하면 안 된다: ${owners.join(",")}`);
    assert.equal(match.stats.left.passes, 1);
  });

  test("대조군: 유예가 0 이면 같은 장면에서 패스한 선수가 곧바로 공을 붙잡는다", () => {
    const mutable = PASS as { releaseMs: number };
    const saved = mutable.releaseMs;
    mutable.releaseMs = 0;
    try {
      const match = runningPassFixture();
      const { owners } = passAndTrace(match, ticksFor(saved));
      assert.equal(owners[0], "L3", "고치기 전: 패스한 틱에 다시 소유자가 된다");
    } finally {
      mutable.releaseMs = saved;
    }
  });

  test("받을 동료는 정상적으로 공을 잡고, 완료 패스와 조작 전환이 그대로 일어난다", () => {
    const match = runningPassFixture();
    passAndTrace(match, 1);
    let owner: string | null = null;
    for (let i = 0; i < 150 && owner !== "L2"; i += 1) {
      press(match, "left", {});
      match.step(DT);
      owner = match.ball.ownerId;
    }
    assert.equal(owner, "L2");
    assert.equal(match.stats.left.completedPasses, 1);
    assert.equal(match.controlled.left, "L2", "사람 조작이 받은 동료로 넘어간다");
  });

  test("상대는 유예 중에도 공을 가져갈 수 있다", () => {
    const match = runningPassFixture();
    // 패스 길 바로 앞에서 공 쪽으로 달려오는 상대
    place(match, "R3", 22.2, 17, -3, 0);
    const { owners } = passAndTrace(match, ticksFor(PASS.releaseMs));
    assert.ok(owners.includes("R3"), `상대가 공을 잡아야 한다: ${owners.join(",")}`);
    assert.ok(!owners.includes("L3"));
    assert.equal(match.pendingPass, null, "상대 터치로 완료 대기 취소");
  });

  test("헛발질(킥 사거리 밖)은 유예를 걸지 않아 곧바로 공을 몰 수 있다", () => {
    const match = runningPassFixture();
    const me = match.byId.get("L3")!;
    // 드리블 범위(1.5m) 안이지만 킥 사거리(0.42+0.11+0.55=1.08m) 밖
    match.ball = { x: 21.35, y: 17, vx: 0, vy: 0, spin: 0, ownerId: null };
    const { owners, events } = passAndTrace(match, 3);
    assert.ok(!events.some((e) => e.kind === "pass"), "공에 발이 닿지 않았다");
    assert.equal(match.stats.left.passes, 0);
    assert.ok(me.passCdMs > 0, "쿨다운은 걸린다");
    assert.equal(me.passReleaseMs, 0, "유예는 걸리지 않는다");
    assert.ok(owners.includes("L3"), `헛발질 뒤에도 드리블은 된다: ${owners.join(",")}`);
  });

  test("유예가 끝나면 패스한 선수도 다시 공을 소유할 수 있다", () => {
    const match = runningPassFixture();
    passAndTrace(match, 1);
    const me = match.byId.get("L3")!;
    run(match, ticksFor(PASS.releaseMs) + 1);
    assert.equal(me.passReleaseMs, 0);
    // 공을 발 앞에 다시 두면 곧바로 소유
    me.vx = 3;
    me.vy = 0;
    match.ball = { x: me.x + 0.85, y: me.y, vx: 0, vy: 0, spin: 0, ownerId: null };
    match.step(DT);
    assert.equal(match.ball.ownerId, "L3");
  });

  test("킥오프 리셋은 유예를 지운다", () => {
    const match = runningPassFixture();
    passAndTrace(match, 1);
    assert.ok(match.byId.get("L3")!.passReleaseMs > 0);
    match.resetPositions();
    for (const p of match.players) assert.equal(p.passReleaseMs, 0);
  });
});
