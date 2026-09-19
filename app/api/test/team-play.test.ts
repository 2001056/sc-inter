/**
 * 3대3 팀 플레이 회귀 테스트 (독립 검증 담당).
 *
 * 키 문자열이나 이벤트 이름만 보지 않고, 시뮬레이션을 실제 틱으로 굴려
 * "그래서 경기에서 무슨 일이 일어났는가" 를 좌표·속도·소유권으로 확인한다.
 * 모든 테스트는 고정 dt 의 결정론적 틱만 쓴다. sleep 도 타이머도 없다.
 *
 * 검증 대상(사용자 요구 기준):
 *  - 6명 로스터, 팀마다 사람 1명 + AI 동료 2명
 *  - AI 동료가 실제로 움직이고 역할대로 지원 위치를 잡는다
 *  - 방향키 이동 / S 패스 / D 충전슛 / E 달리기 / Shift+방향 개인기의 결과 차이
 *  - 패스를 받은 동료로 조작이 넘어가는 일관성
 *  - 골·리셋·시간 종료·재경기·접속 끊김에서 6인 상태
 */
import assert from "node:assert/strict";
import { beforeEach, afterEach, describe, test } from "node:test";

import {
  DRIBBLE,
  MATCH,
  PASS,
  PITCH,
  PLAYER,
  ROLES,
  SHOOT,
  SKILL,
  STAMINA,
  TEAM_SIZE,
  kickoffSpotFor,
  type Side,
} from "../src/game/constants.ts";
import { Match, neutralInput, type SimEvent } from "../src/game/sim.ts";
import { Room, PITCH_INFO, type ClientConn } from "../src/game/room.ts";
import type { InputState, ServerMessage } from "../src/protocol.ts";

// ---------------------------------------------------------------------------
// 결정론 장치
// ---------------------------------------------------------------------------

/** ai.ts 가 Math.random() 으로 흔들기를 넣으므로 테스트 동안만 고정 시드로 바꾼다. */
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
  Math.random = mulberry32(20260918);
});

afterEach(() => {
  Math.random = realRandom;
});

const DT = 1 / MATCH.tickHz;

function ticksFor(ms: number): number {
  return Math.ceil(ms / (DT * 1000));
}

/** n 틱 진행하고 그동안의 모든 사건을 모은다. */
function run(match: Match, ticks: number, onTick?: (i: number) => void): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i += 1) {
    onTick?.(i);
    events.push(...match.step(DT));
  }
  return events;
}

/** 특정 사건이 나올 때까지(최대 ticks) 굴린다. */
function runUntil(
  match: Match,
  ticks: number,
  done: (events: SimEvent[]) => boolean,
  onTick?: (i: number) => void,
): SimEvent[] {
  const all: SimEvent[] = [];
  for (let i = 0; i < ticks; i += 1) {
    onTick?.(i);
    all.push(...match.step(DT));
    if (done(all)) return all;
  }
  return all;
}

/** 사람이 앉은 팀을 정하고 킥오프 카운트다운을 흘려 보내 playing 상태로 만든다. */
function playingMatch(human: { left?: boolean; right?: boolean } = { left: true }): Match {
  const match = new Match();
  match.humanSides.left = human.left ?? false;
  match.humanSides.right = human.right ?? false;
  match.startMatch();
  run(match, ticksFor(MATCH.kickoffCountdownMs) + 1);
  assert.equal(match.phase, "playing", "카운트다운이 끝나면 playing 이어야 한다");
  return match;
}

/** 사람이 누르는 키를 흉내낸다. seq 는 서버 규약대로 단조 증가시킨다. */
class Pad {
  private seq = 1;
  private readonly match: Match;
  private readonly side: Side;

  constructor(match: Match, side: Side) {
    this.match = match;
    this.side = side;
  }

  press(patch: Partial<InputState>): void {
    this.match.setInput(this.side, { ...neutralInput(), ...patch, seq: this.seq++ });
  }

  release(): void {
    this.press({});
  }
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

function speed(v: { vx: number; vy: number }): number {
  return Math.hypot(v.vx, v.vy);
}

/** 선수를 원하는 자리에 세우는 픽스처. 치트 엔드포인트가 아니라 테스트 내부 배치다. */
function place(
  match: Match,
  id: string,
  at: { x: number; y: number; facing?: number; vx?: number; vy?: number },
): void {
  const p = match.byId.get(id);
  assert.ok(p, `${id} 선수가 있어야 한다`);
  p.x = at.x;
  p.y = at.y;
  p.vx = at.vx ?? 0;
  p.vy = at.vy ?? 0;
  if (at.facing !== undefined) p.facing = at.facing;
}

/** 상대 AI 를 멀리 치워 한 가지 메커닉만 남긴다(다른 메커닉과의 간섭 제거). */
function parkTeam(match: Match, side: Side, x: number): void {
  match.team(side).forEach((p, i) => {
    p.x = x;
    p.y = 3 + i * 4;
    p.vx = 0;
    p.vy = 0;
  });
}

// ---------------------------------------------------------------------------
// 1. 3대3 로스터
// ---------------------------------------------------------------------------

describe("3대3 로스터와 조작 배정", () => {
  test("양 팀 3명씩 6명이고 역할이 겹치지 않는다", () => {
    const match = new Match();
    assert.equal(TEAM_SIZE, 3);
    assert.equal(PITCH_INFO.teamSize, 3, "클라이언트에 내려가는 pitch 정보도 3이어야 한다");
    assert.equal(match.players.length, 6, "3대3 이면 총 6명");

    for (const side of ["left", "right"] as const) {
      const team = match.team(side);
      assert.equal(team.length, 3, `${side} 팀은 3명`);
      const roles = team.map((p) => p.role).sort();
      assert.deepEqual(roles, [...ROLES].sort(), `${side} 팀은 역할 3종을 하나씩 가진다`);
      const ids = team.map((p) => p.id);
      assert.deepEqual(ids, side === "left" ? ["L1", "L2", "L3"] : ["R1", "R2", "R3"]);
    }

    // 킥오프 대형은 자기 진영 쪽에서 시작하고 서로 겹치지 않는다
    for (const side of ["left", "right"] as const) {
      const team = match.team(side);
      for (let i = 0; i < team.length; i += 1) {
        for (let j = i + 1; j < team.length; j += 1) {
          const d = dist(team[i]!.x, team[i]!.y, team[j]!.x, team[j]!.y);
          assert.ok(d > PLAYER.radius * 2, `${team[i]!.id}/${team[j]!.id} 이 겹치면 안 된다`);
        }
      }
    }
  });

  test("팀마다 조작 선수는 정확히 한 명이고, 사람이 앉은 팀만 human 이다", () => {
    const match = playingMatch({ left: true, right: false });
    const snap = match.snapshot(0);

    assert.equal(snap.players.length, 6);
    for (const side of ["left", "right"] as const) {
      const controlledInTeam = snap.players.filter((p) => p.side === side && p.controlled);
      assert.equal(controlledInTeam.length, 1, `${side} 팀의 조작 선수는 1명`);
      assert.equal(controlledInTeam[0]!.id, snap.controlled[side]);
    }
    assert.ok(
      snap.players.filter((p) => p.side === "left").every((p) => p.human),
      "사람이 앉은 팀은 human=true",
    );
    assert.ok(
      snap.players.filter((p) => p.side === "right").every((p) => !p.human),
      "AI 팀은 human=false",
    );

    // 사람 팀에서 사람이 직접 움직이지 않는 동료는 2명
    const aiMates = snap.players.filter((p) => p.side === "left" && !p.controlled);
    assert.equal(aiMates.length, 2, "사람 1명 + AI 동료 2명");
  });
});

// ---------------------------------------------------------------------------
// 2. AI 동료가 실제로 움직이고 지원한다
// ---------------------------------------------------------------------------

describe("AI 동료의 실제 움직임", () => {
  test("사람이 공을 몰면 AI 동료 2명이 각자 다른 지원 위치로 움직인다", () => {
    const match = playingMatch({ left: true });
    const pad = new Pad(match, "left");

    // 조작 선수(L3)가 공을 잡은 상태로 시작한다
    const me = match.controlledPlayer("left");
    assert.equal(me.id, "L3");
    place(match, me.id, { x: 20, y: 17, facing: 0 });
    match.ball.x = 20 + DRIBBLE.leadDistance;
    match.ball.y = 17;
    match.ball.vx = 0;
    match.ball.vy = 0;
    parkTeam(match, "right", PITCH.length - 6);

    const mateIds = ["L1", "L2"];
    const before = mateIds.map((id) => {
      const p = match.byId.get(id)!;
      return { id, x: p.x, y: p.y };
    });

    pad.press({ ax: 1, ay: 0 });
    run(match, ticksFor(1500));

    assert.equal(match.ball.ownerId, "L3", "사람이 계속 공을 몰고 있어야 한다");

    for (const b of before) {
      const p = match.byId.get(b.id)!;
      const moved = dist(p.x, p.y, b.x, b.y);
      assert.ok(moved > 2, `${b.id} 이 실제로 움직여야 한다 (이동 ${moved.toFixed(2)}m)`);
    }

    const defender = match.team("left").find((p) => p.role === "defender")!;
    const mid = match.team("left").find((p) => p.role === "mid")!;
    assert.ok(
      defender.x < match.ball.x,
      `수비수는 공보다 뒤를 지켜야 한다 (defender ${defender.x.toFixed(1)} < ball ${match.ball.x.toFixed(1)})`,
    );
    assert.ok(
      mid.x > defender.x,
      "미드필더는 수비수보다 앞에 선다",
    );
    assert.ok(
      dist(defender.x, defender.y, mid.x, mid.y) > 3,
      "두 동료가 같은 자리에 겹쳐 서면 지원이 아니다",
    );
  });

  test("공이 흐르면 가장 가까운 동료가 쫓고 나머지는 자기 자리를 지킨다", () => {
    const match = playingMatch({ left: true });

    // 사람은 가만히 두고, 공만 왼쪽 팀 진영 구석으로 흘려 보낸다
    parkTeam(match, "right", PITCH.length - 6);
    place(match, "L3", { x: 30, y: 17 });
    place(match, "L2", { x: 18, y: 8 });
    place(match, "L1", { x: 10, y: 26 });
    match.ball.x = 16;
    match.ball.y = 7;
    match.ball.vx = 0;
    match.ball.vy = 0;

    const l2Start = dist(18, 8, match.ball.x, match.ball.y);
    const l1Start = dist(10, 26, match.ball.x, match.ball.y);
    assert.ok(l2Start < l1Start, "픽스처 전제: L2 가 공에 더 가깝다");

    run(match, ticksFor(900));

    const l2 = match.byId.get("L2")!;
    const l1 = match.byId.get("L1")!;
    assert.ok(
      dist(l2.x, l2.y, match.ball.x, match.ball.y) < l2Start,
      "가까운 동료는 공에 다가가야 한다",
    );
    // 대조군: 먼 동료는 공으로 달려들지 않는다(둘 다 공만 쫓으면 지원이 아니다)
    assert.ok(
      dist(l1.x, l1.y, match.ball.x, match.ball.y) > 6,
      "먼 동료까지 공에 몰려들면 안 된다",
    );
  });

  test("연습 모드(사람 없음)에서도 AI 팀이 스스로 경기를 진행한다", () => {
    const match = playingMatch({ left: false, right: false });
    const start = match.players.map((p) => ({ id: p.id, x: p.x, y: p.y }));
    const ballStart = { x: match.ball.x, y: match.ball.y };

    run(match, ticksFor(2000));

    const movers = start.filter((s) => {
      const p = match.byId.get(s.id)!;
      return dist(p.x, p.y, s.x, s.y) > 1;
    });
    assert.equal(movers.length, 6, "6명 전원이 스스로 움직여야 한다");
    assert.ok(
      dist(match.ball.x, match.ball.y, ballStart.x, ballStart.y) > 1,
      "공도 움직여야 한다 (아무도 공을 건드리지 않으면 AI 가 아니다)",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 패스 (S)
// ---------------------------------------------------------------------------

describe("땅볼 패스", () => {
  /** 패스 직전 상태를 만든다: L3 가 공을 발 앞에 두고, L2 가 앞쪽에 서 있다. */
  function passFixture(): { match: Match; pad: Pad } {
    const match = playingMatch({ left: true });
    parkTeam(match, "right", PITCH.length - 4);
    place(match, "L3", { x: 20, y: 17, facing: 0 });
    place(match, "L2", { x: 33, y: 17 });
    place(match, "L1", { x: 8, y: 17 });
    match.ball.x = 20 + PLAYER.radius + 0.3;
    match.ball.y = 17;
    match.ball.vx = 0;
    match.ball.vy = 0;
    return { match, pad: new Pad(match, "left") };
  }

  test("패스는 바라보는 쪽 동료를 겨냥하고, 공이 그 동료 쪽으로 굴러간다", () => {
    const { match, pad } = passFixture();
    const target = match.passTargetFor(match.byId.get("L3")!);
    assert.equal(target?.id, "L2", "앞쪽 동료가 패스 대상이어야 한다");
    assert.equal(match.snapshot(0).passTarget.left, "L2", "스냅샷의 passTarget 도 같아야 한다");

    pad.press({ pass: true });
    const events = run(match, 1);

    const passEvents = events.filter((e) => e.kind === "pass");
    assert.equal(passEvents.length, 1, "패스 이벤트가 정확히 한 번");
    assert.equal(passEvents[0]!.kind === "pass" && passEvents[0]!.playerId, "L3");
    assert.equal(passEvents[0]!.kind === "pass" && passEvents[0]!.targetId, "L2");

    // 공이 실제로 동료 방향(+x)으로 굴러야 한다
    assert.ok(match.ball.vx > PASS.minSpeed * 0.8, `공이 앞으로 굴러야 한다 (vx=${match.ball.vx})`);
    assert.ok(Math.abs(match.ball.vy) < 1.5, "옆으로 크게 새면 안 된다");
    assert.ok(speed(match.ball) <= PASS.maxSpeed + 0.01, "패스는 최대 속도를 넘지 않는다");
  });

  test("패스한 공을 상대가 아니라 같은 팀 동료가 받는다", () => {
    const { match, pad } = passFixture();
    pad.press({ pass: true });
    run(match, 1);
    pad.release();

    const events = runUntil(match, ticksFor(2500), () =>
      match.ball.ownerId !== null && match.ball.ownerId !== "L3",
    );

    const owner = match.ball.ownerId;
    assert.ok(owner !== null, "공을 아무도 못 받으면 패스가 아니다");
    assert.equal(owner!.startsWith("L"), true, `상대가 가로채면 안 된다 (owner=${owner})`);
    assert.notEqual(owner, "L3", "패스한 본인이 다시 잡으면 패스가 아니다");
    void events;
  });

  test("시야각 밖 동료는 패스 대상에서 빠진다 (대조군)", () => {
    const match = playingMatch({ left: true });
    parkTeam(match, "right", PITCH.length - 4);
    // 두 동료를 모두 등 뒤(-x)에 두고 앞을 본다
    place(match, "L3", { x: 30, y: 17, facing: 0 });
    place(match, "L2", { x: 8, y: 17 });
    place(match, "L1", { x: 6, y: 20 });

    const target = match.passTargetFor(match.byId.get("L3")!);
    assert.equal(target, null, `등 뒤 동료는 대상이 아니어야 한다 (maxAngle=${PASS.maxAngle})`);

    match.ball.x = 30 + PLAYER.radius + 0.3;
    match.ball.y = 17;
    match.ball.vx = 0;
    match.ball.vy = 0;
    new Pad(match, "left").press({ pass: true });
    const events = run(match, 1);
    const ev = events.find((e) => e.kind === "pass");
    assert.ok(ev, "대상이 없어도 패스 시도 자체는 기록된다");
    assert.equal(ev!.kind === "pass" && ev!.targetId, null);
    assert.ok(match.ball.vx > 0, "대상이 없으면 바라보는 방향으로 나간다");
  });

  test("공이 발에서 멀면 패스해도 공이 움직이지 않는다 (대조군)", () => {
    const { match, pad } = passFixture();
    match.ball.x = 20 + 6; // 사거리 밖
    const before = { vx: match.ball.vx, vy: match.ball.vy };
    pad.press({ pass: true });
    const events = run(match, 1);
    assert.equal(events.filter((e) => e.kind === "pass").length, 0, "헛발질은 패스 이벤트가 없다");
    assert.ok(
      Math.abs(match.ball.vx - before.vx) < 0.01 && Math.abs(match.ball.vy - before.vy) < 0.01,
      "닿지 않는 공은 움직이지 않는다",
    );
  });
});

// ---------------------------------------------------------------------------
// 4. 충전 슛 (D) 과 패스의 차이
// ---------------------------------------------------------------------------

describe("충전 슛", () => {
  /** chargeMs 만큼 누르고 뗀 뒤, 그 슛의 이벤트와 공 속도를 돌려준다. */
  function shootWith(chargeMs: number): { power: number; ballSpeed: number } {
    const match = playingMatch({ left: true });
    parkTeam(match, "right", PITCH.length - 3);
    place(match, "L3", { x: 30, y: 17, facing: 0 });
    place(match, "L2", { x: 12, y: 10 });
    place(match, "L1", { x: 8, y: 24 });
    match.ball.x = 30 + PLAYER.radius + 0.3;
    match.ball.y = 17;
    match.ball.vx = 0;
    match.ball.vy = 0;

    const pad = new Pad(match, "left");
    pad.press({ shoot: true });
    run(match, ticksFor(chargeMs));
    // 충전 게이지가 스냅샷에 보여야 한다
    const charge = match.snapshot(0).players.find((p) => p.id === "L3")!.charge;
    assert.ok(charge > 0 || chargeMs < DT * 1000, "누르고 있는 동안 charge 가 올라야 한다");

    pad.press({ shoot: false });
    const events = run(match, 1);
    const ev = events.find((e) => e.kind === "shoot");
    assert.ok(ev, `${chargeMs}ms 충전 후 슛이 나가야 한다`);
    return {
      power: ev!.kind === "shoot" ? ev!.power : 0,
      ballSpeed: speed(match.ball),
    };
  }

  test("충전 시간이 길수록 세게 찬다", () => {
    const light = shootWith(60);
    const half = shootWith(SHOOT.chargeMs / 2);
    const full = shootWith(SHOOT.chargeMs + 120);

    assert.ok(light.power < half.power, `짧은 충전(${light.power}) < 절반(${half.power})`);
    assert.ok(half.power < full.power, `절반(${half.power}) < 최대(${full.power})`);
    assert.ok(light.power >= SHOOT.minPower, "최소 파워 아래로 내려가지 않는다");
    assert.ok(full.power <= SHOOT.maxPower + 0.01, "최대 파워를 넘지 않는다");
    // 충전 상한: 더 오래 눌러도 최대치에서 멈춘다
    assert.ok(Math.abs(full.power - SHOOT.maxPower) < 0.5, "충전은 상한에서 포화한다");
  });

  test("충전 슛은 같은 자리에서 나간 패스보다 빠르다", () => {
    const full = shootWith(SHOOT.chargeMs + 120);

    const match = playingMatch({ left: true });
    parkTeam(match, "right", PITCH.length - 3);
    place(match, "L3", { x: 30, y: 17, facing: 0 });
    place(match, "L2", { x: 40, y: 17 });
    place(match, "L1", { x: 8, y: 24 });
    match.ball.x = 30 + PLAYER.radius + 0.3;
    match.ball.y = 17;
    match.ball.vx = 0;
    match.ball.vy = 0;
    new Pad(match, "left").press({ pass: true });
    run(match, 1);
    const passSpeed = speed(match.ball);

    assert.ok(
      full.ballSpeed > passSpeed * 1.3,
      `충전 슛(${full.ballSpeed.toFixed(1)}m/s)이 패스(${passSpeed.toFixed(1)}m/s)보다 확실히 빨라야 한다`,
    );
  });

  test("슛 쿨다운 동안에는 두 번째 슛이 나가지 않는다", () => {
    const match = playingMatch({ left: true });
    parkTeam(match, "right", PITCH.length - 3);
    place(match, "L3", { x: 30, y: 17, facing: 0 });
    match.ball.x = 30 + PLAYER.radius + 0.3;
    match.ball.y = 17;
    match.ball.vx = 0;
    match.ball.vy = 0;

    const pad = new Pad(match, "left");
    pad.press({ shoot: true });
    run(match, ticksFor(200));
    pad.press({ shoot: false });
    const first = run(match, 1).filter((e) => e.kind === "shoot");
    assert.equal(first.length, 1);

    // 쿨다운이 끝나기 전에 다시 누르고 뗀다
    match.ball.x = match.byId.get("L3")!.x + PLAYER.radius + 0.3;
    match.ball.vx = 0;
    pad.press({ shoot: true });
    run(match, 2);
    pad.press({ shoot: false });
    const second = run(match, 1).filter((e) => e.kind === "shoot");
    assert.equal(second.length, 0, `쿨다운(${SHOOT.cooldownMs}ms) 안에는 다시 못 찬다`);
  });
});

// ---------------------------------------------------------------------------
// 5. 패스 후 조작 선수 전환
// ---------------------------------------------------------------------------

describe("조작 선수 전환", () => {
  test("패스를 받은 동료로 조작이 넘어가고 control 이벤트가 한 번 나간다", () => {
    const match = playingMatch({ left: true });
    parkTeam(match, "right", PITCH.length - 4);
    place(match, "L3", { x: 20, y: 17, facing: 0 });
    place(match, "L2", { x: 31, y: 17 });
    place(match, "L1", { x: 8, y: 17 });
    match.ball.x = 20 + PLAYER.radius + 0.3;
    match.ball.y = 17;
    match.ball.vx = 0;
    match.ball.vy = 0;

    assert.equal(match.controlled.left, "L3");
    const pad = new Pad(match, "left");
    pad.press({ pass: true });
    run(match, 1);
    pad.release();

    // 공을 받은 동료가 실제로 소유권을 잡는 틱까지 굴린다
    const events = runUntil(
      match,
      ticksFor(2500),
      () => match.ball.ownerId !== null && match.ball.ownerId !== "L3",
    );

    const owner = match.ball.ownerId;
    assert.ok(owner !== null && owner.startsWith("L"), `동료가 공을 받아야 한다 (owner=${owner})`);
    assert.equal(
      match.controlled.left,
      owner,
      "공을 받은 동료가 같은 틱에 조작 대상이 되어야 한다 (조작이 공을 따라가야 한다)",
    );

    const controlEvents = events.filter(
      (e) => e.kind === "control" && e.side === "left" && e.playerId === owner,
    );
    assert.ok(controlEvents.length >= 1, "전환은 이벤트로 알려야 한다");
    // 대조군: 왼쪽 팀 전환이 오른쪽 팀 이벤트를 만들지 않는다
    assert.equal(
      events.filter((e) => e.kind === "control" && e.side === "right").length,
      0,
    );

    // 전환 뒤 이전 선수의 입력이 남아 있으면 유령 조작이 된다
    const previous = match.byId.get("L3")!;
    assert.equal(previous.input.ax, 0, "이전 조작 선수의 입력은 중립으로 초기화된다");
    assert.equal(previous.input.ay, 0);
    assert.equal(previous.chargeMs, 0, "이전 선수의 슛 충전도 비워진다");

    // 상대 팀 조작 선수는 영향을 받지 않는다 (대조군)
    assert.equal(match.controlled.right, "R3");
  });

  test("전환 후에는 사람 입력이 새 선수에게 간다", () => {
    const match = playingMatch({ left: true });
    parkTeam(match, "right", PITCH.length - 4);
    place(match, "L1", { x: 12, y: 17 });
    match.ball.x = 12.6;
    match.ball.y = 17;
    match.ball.vx = 0;
    match.ball.vy = 0;
    place(match, "L3", { x: 40, y: 17 });
    place(match, "L2", { x: 38, y: 24 });

    const pad = new Pad(match, "left");
    pad.press({ switchPlayer: true });
    assert.equal(match.controlled.left, "L1", "공에 가장 가까운 동료로 넘어간다");

    pad.press({ ax: 0, ay: 1 });
    const before = { x: match.byId.get("L1")!.x, y: match.byId.get("L1")!.y };
    run(match, ticksFor(400));
    const after = match.byId.get("L1")!;
    assert.ok(after.y - before.y > 1, "새 조작 선수가 내가 누른 방향으로 움직여야 한다");
    assert.ok(Math.abs(after.x - before.x) < 3, "누르지 않은 축으로 크게 밀리면 안 된다");
  });

  test("수동 전환은 공에 가까운 동료 순서로 넘긴다", () => {
    const match = playingMatch({ left: true });
    place(match, "L3", { x: 40, y: 17 });
    place(match, "L2", { x: 22, y: 17 });
    place(match, "L1", { x: 14, y: 17 });
    match.ball.x = 14;
    match.ball.y = 17;

    match.manualSwitch("left");
    assert.equal(match.controlled.left, "L1");
    match.manualSwitch("left");
    assert.equal(match.controlled.left, "L2", "다음으로 가까운 동료로 넘어간다");
  });
});

// ---------------------------------------------------------------------------
// 6. 개인기 (Shift + 방향)
// ---------------------------------------------------------------------------

describe("개인기 4방향", () => {
  /** 개인기 한 번을 쏘고 판정된 종류를 돌려준다. */
  function useSkill(
    side: Side,
    dir: { x: number; y: number },
    opts: { facing?: number } = {},
  ): { match: Match; actorId: string; kind: string; beat: boolean } {
    const match = playingMatch({ left: side === "left", right: side === "right" });
    const me = match.controlledPlayer(side);
    parkTeam(match, side === "left" ? "right" : "left", side === "left" ? PITCH.length - 3 : 3);
    place(match, me.id, {
      x: PITCH.length / 2,
      y: PITCH.width / 2,
      facing: opts.facing ?? (side === "left" ? 0 : Math.PI),
    });
    match.ball.x = 3;
    match.ball.y = 3;
    match.ball.vx = 0;
    match.ball.vy = 0;

    new Pad(match, side).press({ skillDir: dir });
    const events = run(match, 1);
    const ev = events.find((e) => e.kind === "skill");
    assert.ok(ev, `${side} ${JSON.stringify(dir)} 에서 개인기가 나가야 한다`);
    // 공이 멀면 조작이 다른 동료로 넘어가므로, 개인기를 쓴 선수는 id 로 붙잡는다
    return {
      match,
      actorId: me.id,
      kind: ev!.kind === "skill" ? ev!.skill : "",
      beat: ev!.kind === "skill" ? ev!.beat : false,
    };
  }

  test("왼쪽 팀: 앞=stepover, 뒤=dragback, 좌우=feint 로 갈린다", () => {
    assert.equal(useSkill("left", { x: 1, y: 0 }).kind, "stepover");
    assert.equal(useSkill("left", { x: -1, y: 0 }).kind, "dragback");
    const a = useSkill("left", { x: 0, y: -1 }).kind;
    const b = useSkill("left", { x: 0, y: 1 }).kind;
    assert.deepEqual([a, b].sort(), ["feintLeft", "feintRight"], "좌우가 서로 다른 페인트");
  });

  test("오른쪽 팀은 같은 월드 방향이 반대로 해석된다 (팀 기준 앞/뒤)", () => {
    // 오른쪽 팀의 공격 방향은 -x 이므로 월드 +x 는 '뒤'다
    assert.equal(useSkill("right", { x: 1, y: 0 }).kind, "dragback");
    assert.equal(useSkill("right", { x: -1, y: 0 }).kind, "stepover");
    const leftFeint = useSkill("left", { x: 0, y: -1 }).kind;
    const rightFeint = useSkill("right", { x: 0, y: -1 }).kind;
    assert.notEqual(
      leftFeint,
      rightFeint,
      "같은 월드 방향이라도 팀에 따라 좌/우 페인트가 뒤집혀야 한다",
    );
  });

  test("stepover 는 앞으로, dragback 은 뒤로 몸을 던진다", () => {
    const step = useSkill("left", { x: 1, y: 0 });
    const stepPlayer = step.match.byId.get(step.actorId)!;
    const stepX0 = stepPlayer.x;
    assert.equal(stepPlayer.skill, "stepover");
    run(step.match, ticksFor(SKILL.stepover.durationMs));
    assert.equal(stepPlayer.skill, null, "지속 시간이 지나면 동작이 끝난다");
    assert.ok(
      stepPlayer.x - stepX0 > 0.8,
      `stepover 는 앞으로 나가야 한다 (Δ${(stepPlayer.x - stepX0).toFixed(2)})`,
    );

    const drag = useSkill("left", { x: -1, y: 0 });
    const dragPlayer = drag.match.byId.get(drag.actorId)!;
    const dragX0 = dragPlayer.x;
    run(drag.match, ticksFor(SKILL.dragback.durationMs));
    assert.ok(
      dragPlayer.x - dragX0 < -0.5,
      `dragback 은 뒤로 빠져야 한다 (Δ${(dragPlayer.x - dragX0).toFixed(2)})`,
    );
  });

  test("dragback 은 발 앞의 공도 함께 끌고 온다", () => {
    const match = playingMatch({ left: true });
    parkTeam(match, "right", PITCH.length - 3);
    place(match, "L3", { x: 30, y: 17, facing: 0 });
    place(match, "L2", { x: 10, y: 8 });
    place(match, "L1", { x: 8, y: 24 });
    match.ball.x = 30 + DRIBBLE.leadDistance;
    match.ball.y = 17;
    match.ball.vx = 0;
    match.ball.vy = 0;

    new Pad(match, "left").press({ skillDir: { x: -1, y: 0 } });
    run(match, ticksFor(SKILL.dragback.durationMs));

    assert.ok(
      match.ball.vx < -1,
      `공이 뒤로 끌려와야 한다 (ball.vx=${match.ball.vx.toFixed(2)})`,
    );
  });

  test("개인기 쿨다운 동안에는 다시 나가지 않는다", () => {
    const match = playingMatch({ left: true });
    parkTeam(match, "right", PITCH.length - 3);
    place(match, "L3", { x: 28, y: 17, facing: 0 });
    const pad = new Pad(match, "left");

    pad.press({ skillDir: { x: 1, y: 0 } });
    const first = run(match, 1).filter((e) => e.kind === "skill");
    assert.equal(first.length, 1);
    const me = match.byId.get("L3")!;
    assert.equal(me.skillCdMs, SKILL.moveCooldownMs, "쿨다운 게이지가 가득 찬다");

    // 동작이 끝난 뒤(= busy 아님) 쿨다운 안에서 다시 시도
    pad.release();
    run(match, ticksFor(SKILL.stepover.durationMs) + 2);
    assert.equal(me.skill, null, "개인기 동작은 끝나 있어야 한다");
    assert.ok(me.skillCdMs > 0, "아직 쿨다운 중");

    pad.press({ skillDir: { x: 0, y: 1 } });
    const blocked = run(match, 1).filter((e) => e.kind === "skill");
    assert.equal(blocked.length, 0, "쿨다운 중에는 개인기가 나가지 않는다");

    // 쿨다운이 끝나면 다시 나간다 (대조군)
    pad.release();
    run(match, ticksFor(SKILL.moveCooldownMs) + 2);
    assert.equal(me.skillCdMs, 0);
    pad.press({ skillDir: { x: 0, y: 1 } });
    const again = run(match, 1).filter((e) => e.kind === "skill");
    assert.equal(again.length, 1, "쿨다운이 끝나면 다시 쓸 수 있어야 한다");
  });

  test("개인기는 스태미나를 소모하고, 바닥나면 쓰지 못한다", () => {
    const match = playingMatch({ left: true });
    parkTeam(match, "right", PITCH.length - 3);
    place(match, "L3", { x: 28, y: 17, facing: 0 });
    const me = match.byId.get("L3")!;
    me.stamina = 1;

    new Pad(match, "left").press({ skillDir: { x: 1, y: 0 } });
    run(match, 1);
    assert.ok(
      Math.abs(1 - me.stamina - STAMINA.skillCost) < 0.02,
      `개인기 1회는 ${STAMINA.skillCost} 만큼 깎아야 한다 (남은 ${me.stamina.toFixed(3)})`,
    );

    // 대조군: 스태미나가 비용보다 적으면 못 쓴다
    const dry = playingMatch({ left: true });
    parkTeam(dry, "right", PITCH.length - 3);
    place(dry, "L3", { x: 28, y: 17, facing: 0 });
    dry.byId.get("L3")!.stamina = STAMINA.skillCost / 2;
    new Pad(dry, "left").press({ skillDir: { x: 1, y: 0 } });
    assert.equal(run(dry, 1).filter((e) => e.kind === "skill").length, 0);
  });

  test("가까운 상대는 흔들려서(beat) 잠시 느려진다", () => {
    const match = playingMatch({ left: true });
    place(match, "L3", { x: 28, y: 17, facing: 0 });
    place(match, "R1", { x: 29.5, y: 17 });
    parkTeam(match, "left", 6);
    place(match, "L3", { x: 28, y: 17, facing: 0 });
    place(match, "R2", { x: 50, y: 5 });
    place(match, "R3", { x: 50, y: 28 });
    match.ball.x = 3;
    match.ball.y = 3;

    new Pad(match, "left").press({ skillDir: { x: 1, y: 0 } });
    const events = run(match, 1);
    const ev = events.find((e) => e.kind === "skill");
    assert.ok(ev && ev.kind === "skill" && ev.beat, "사거리 안 상대는 흔들려야 한다");
    assert.ok(match.byId.get("R1")!.staggerMs > 0, "흔들린 상대에게 stagger 가 남는다");
    assert.equal(match.byId.get("R2")!.staggerMs, 0, "먼 상대는 영향이 없다 (대조군)");
  });
});

// ---------------------------------------------------------------------------
// 7. 스태미나 (E 달리기)
// ---------------------------------------------------------------------------

describe("스태미나와 속도", () => {
  /**
   * 조작 선수를 계속 같은 사람으로 두려면 공이 그의 발 앞에 있어야 한다.
   * (공이 멀면 서버가 공에 가까운 동료에게 조작을 넘기는 것이 정상 동작이다.)
   */
  function driveFor(ms: number, sprint: boolean): { player: Match["players"][number]; top: number } {
    const match = playingMatch({ left: true });
    parkTeam(match, "right", PITCH.length - 3);
    place(match, "L3", { x: 6, y: 17, facing: 0 });
    place(match, "L2", { x: 4, y: 3 });
    place(match, "L1", { x: 4, y: 31 });
    match.ball.x = 6 + DRIBBLE.leadDistance;
    match.ball.y = 17;
    match.ball.vx = 0;
    match.ball.vy = 0;
    const me = match.byId.get("L3")!;
    me.stamina = 1;

    new Pad(match, "left").press({ ax: 1, ay: 0, sprint });
    let top = 0;
    run(match, ticksFor(ms), () => {
      top = Math.max(top, speed(me));
    });
    top = Math.max(top, speed(me));
    assert.equal(match.controlled.left, "L3", "픽스처 전제: 조작 선수가 바뀌지 않았다");
    return { player: me, top };
  }

  test("달리기는 체력을 깎고 더 빠르다; 일반 이동은 회복한다", () => {
    const sprint = driveFor(1500, true);
    const jog = driveFor(1500, false);

    assert.ok(
      sprint.player.stamina < 1 - STAMINA.sprintDrain * 1.2,
      `스프린트는 체력을 깎아야 한다 (남은 ${sprint.player.stamina.toFixed(3)})`,
    );
    assert.equal(jog.player.stamina, 1, "일반 이동은 체력을 깎지 않는다 (이미 가득이면 유지)");
    assert.ok(
      sprint.top > jog.top + 1,
      `스프린트가 더 빨라야 한다 (${sprint.top.toFixed(2)} vs ${jog.top.toFixed(2)})`,
    );
    assert.ok(sprint.top <= PLAYER.sprintSpeed + 0.05, "스프린트 상한을 넘지 않는다");
    assert.ok(jog.top <= PLAYER.runSpeed + 0.05, "일반 이동 상한을 넘지 않는다");
  });

  test("체력이 줄어 있으면 걷는 동안 회복된다", () => {
    const match = playingMatch({ left: true });
    parkTeam(match, "right", PITCH.length - 3);
    place(match, "L3", { x: 10, y: 17, facing: 0 });
    place(match, "L2", { x: 4, y: 3 });
    place(match, "L1", { x: 4, y: 31 });
    match.ball.x = 10 + DRIBBLE.leadDistance;
    match.ball.y = 17;
    match.ball.vx = 0;
    match.ball.vy = 0;
    const me = match.byId.get("L3")!;
    me.stamina = 0.4;
    new Pad(match, "left").press({ ax: 1, ay: 0, sprint: false });
    run(match, ticksFor(1000));
    assert.equal(match.controlled.left, "L3", "픽스처 전제: 조작 선수가 바뀌지 않았다");
    assert.ok(
      me.stamina > 0.4 + STAMINA.regen * 0.8,
      `1초 걸으면 약 ${STAMINA.regen} 회복해야 한다 (${me.stamina.toFixed(3)})`,
    );
  });

  test("체력 바닥에서는 달리기 키를 눌러도 스프린트가 되지 않는다", () => {
    const match = playingMatch({ left: true });
    parkTeam(match, "right", PITCH.length - 3);
    place(match, "L3", { x: 6, y: 17, facing: 0 });
    match.ball.x = PITCH.length - 4;
    match.ball.y = 30;
    const me = match.byId.get("L3")!;
    me.stamina = STAMINA.sprintFloor / 2;

    new Pad(match, "left").press({ ax: 1, ay: 0, sprint: true });
    let top = 0;
    run(match, ticksFor(900), () => {
      top = Math.max(top, speed(me));
      // 회복으로 floor 를 넘지 않게 눌러 둔다
      me.stamina = Math.min(me.stamina, STAMINA.sprintFloor / 2);
    });
    assert.equal(me.sprinting, false, "체력이 바닥이면 스프린트 상태가 아니다");
    assert.ok(
      top <= PLAYER.runSpeed + 0.05,
      `일반 속도를 넘으면 안 된다 (${top.toFixed(2)} > ${PLAYER.runSpeed})`,
    );
  });
});

// ---------------------------------------------------------------------------
// 8. 골 · 리셋 · 시간 종료 · 재경기 · 접속 끊김
// ---------------------------------------------------------------------------

describe("경기 흐름과 6인 상태", () => {
  test("골이 들어가면 점수가 오르고, 연출 뒤 6명 전원이 킥오프 위치로 돌아간다", () => {
    const match = playingMatch({ left: true });
    // 오른쪽 팀 골문(x=PITCH.length)으로 굴려 넣는다 → 왼쪽 팀 득점
    parkTeam(match, "left", 20);
    parkTeam(match, "right", 20);
    match.ball.x = PITCH.length - 1;
    match.ball.y = PITCH.width / 2;
    match.ball.vx = 18;
    match.ball.vy = 0;
    match.lastToucherId = "L3";

    const events = runUntil(match, 30, (all) => all.some((e) => e.kind === "goal"));
    const goal = events.find((e) => e.kind === "goal");
    assert.ok(goal, "골문 안으로 들어가면 골이어야 한다");
    assert.equal(goal!.kind === "goal" && goal!.side, "left");
    assert.equal(goal!.kind === "goal" && goal!.scorerId, "L3", "마지막 터치가 득점자");
    assert.deepEqual(match.score, { left: 1, right: 0 });
    assert.equal(match.phase, "goal");

    // 연출 시간이 지나면 카운트다운으로 복귀하고 전원이 스폰 위치로
    run(match, ticksFor(MATCH.goalCelebrationMs) + 2);
    assert.equal(match.phase, "countdown");
    assert.equal(match.kickoffSide, "right", "실점한 오른쪽 팀이 다음 킥오프를 찬다");
    for (const p of match.players) {
      const s = kickoffSpotFor(p.side, p.role, match.kickoffSide);
      assert.ok(
        dist(p.x, p.y, s.x, s.y) < 0.01,
        `${p.id} 이 킥오프 위치로 돌아가야 한다 (${p.x.toFixed(2)},${p.y.toFixed(2)})`,
      );
      assert.equal(speed(p), 0, `${p.id} 속도도 0 으로 초기화`);
      assert.equal(p.skill, null);
      assert.equal(p.chargeMs, 0);
    }
    assert.equal(match.ball.x, PITCH.length / 2);
    assert.equal(match.ball.y, PITCH.width / 2);
    assert.deepEqual(match.controlled, { left: "L3", right: "R3" });
    assert.deepEqual(match.score, { left: 1, right: 0 }, "점수는 유지된다");

    // 카운트다운이 끝나면 다시 킥오프
    const resumed = run(match, ticksFor(MATCH.kickoffCountdownMs) + 2);
    assert.ok(resumed.some((e) => e.kind === "kickoff"));
    assert.equal(match.phase, "playing");
  });

  test("골대 밖으로 나간 공은 골이 아니라 벽에 맞고 돌아온다 (대조군)", () => {
    const match = playingMatch({ left: true });
    parkTeam(match, "left", 20);
    parkTeam(match, "right", 20);
    match.ball.x = PITCH.length - 1;
    match.ball.y = 3; // 골문 바깥
    match.ball.vx = 18;
    match.ball.vy = 0;

    const events = run(match, 30);
    assert.equal(events.filter((e) => e.kind === "goal").length, 0, "골문 밖은 골이 아니다");
    assert.equal(match.phase, "playing");
    assert.ok(match.ball.vx < 0, "벽에 맞고 되돌아와야 한다");
  });

  test("시간이 다 되면 matchEnd 와 결과가 나온다", () => {
    const match = playingMatch({ left: true });
    parkTeam(match, "left", 20);
    parkTeam(match, "right", 34);
    match.score = { left: 2, right: 1 };
    match.timeLeftMs = 100;

    const events = runUntil(match, 20, (all) => all.some((e) => e.kind === "matchEnd"));
    const end = events.find((e) => e.kind === "matchEnd");
    assert.ok(end, "시간이 끝나면 matchEnd");
    assert.equal(end!.kind === "matchEnd" && end!.result, "left");
    assert.equal(match.phase, "ended");
    assert.equal(match.result, "left");
    assert.equal(match.timeLeftMs, 0);

    // 끝난 뒤에는 더 이상 진행되지 않는다
    const after = run(match, 60);
    assert.equal(after.length, 0, "ended 이후에는 사건이 없다");
  });

  test("동점이면 draw 로 끝난다 (대조군)", () => {
    const match = playingMatch({ left: true });
    parkTeam(match, "left", 20);
    parkTeam(match, "right", 34);
    match.score = { left: 1, right: 1 };
    match.timeLeftMs = 100;
    const events = runUntil(match, 20, (all) => all.some((e) => e.kind === "matchEnd"));
    const end = events.find((e) => e.kind === "matchEnd");
    assert.equal(end!.kind === "matchEnd" && end!.result, "draw");
  });

  test("두 사람이 모두 준비하면 6명 상태가 새 경기로 초기화된다", () => {
    const { room } = versusRoom();
    room.match.score = { left: 3, right: 1 };
    room.match.phase = "ended";
    room.match.result = "left";
    room.match.timeLeftMs = 0;
    for (const p of room.match.players) {
      p.x += 5;
      p.stamina = 0.2;
    }

    assert.equal(room.setRematch("left", true), false, "한 명만 준비하면 시작하지 않는다");
    assert.equal(room.match.phase, "ended");
    assert.equal(room.setRematch("right", true), true, "두 명 다 준비하면 새 경기");

    assert.equal(room.match.phase, "countdown");
    assert.deepEqual(room.match.score, { left: 0, right: 0 });
    assert.equal(room.match.result, null);
    assert.equal(room.match.timeLeftMs, MATCH.durationMs);
    for (const p of room.match.players) {
      const s = kickoffSpotFor(p.side, p.role, room.match.kickoffSide);
      assert.ok(dist(p.x, p.y, s.x, s.y) < 0.01, `${p.id} 재배치`);
      assert.ok(p.stamina >= 0.7, "체력도 회복된 상태로 시작한다");
    }
    assert.ok(
      room.metaPlayers().every((m) => !m.rematchReady),
      "재경기 준비 표시는 소비된다",
    );
  });

  test("접속이 끊기면 그 선수의 입력이 중립으로 고정되고, 유예 뒤 자리가 비워진다", () => {
    const { room, left } = versusRoom();
    run(room.match, ticksFor(MATCH.kickoffCountdownMs) + 1);
    assert.equal(room.match.phase, "playing");

    room.setInput("left", { ...neutralInput(), seq: 5, ax: 1, ay: 0, sprint: true });
    assert.equal(room.match.controlledPlayer("left").input.ax, 1);

    room.detach(left);
    room.advance(1000 / MATCH.tickHz, Date.now());
    const me = room.match.controlledPlayer("left");
    assert.equal(me.input.ax, 0, "끊긴 사람의 선수는 손을 놓은 상태가 된다");
    assert.equal(me.input.sprint, false);
    assert.equal(room.humanConnectedCount(), 1);
    assert.equal(
      room.metaPlayers().find((m) => m.side === "left")!.connected,
      false,
      "상대에게 끊김이 보여야 한다",
    );

    // 끊긴 동안에도 경기는 6명으로 계속 굴러간다 (AI 가 왼쪽 팀을 맡는다)
    const before = room.match.players.map((p) => ({ id: p.id, x: p.x, y: p.y }));
    for (let i = 0; i < 60; i += 1) room.advance(1000 / MATCH.tickHz, Date.now());
    const movedLeft = before
      .filter((b) => b.id.startsWith("L"))
      .filter((b) => {
        const p = room.match.byId.get(b.id)!;
        return dist(p.x, p.y, b.x, b.y) > 0.3;
      });
    assert.ok(movedLeft.length >= 1, "끊긴 팀도 AI 로 계속 움직인다");
    assert.equal(room.match.players.length, 6, "선수 수는 그대로 6명");

    // 유예 시간이 지나면 자리가 비고 humanSides 가 내려간다
    const expired = room.expireDisconnected(Date.now() + 31_000);
    assert.deepEqual(expired, ["left"]);
    assert.equal(room.match.humanSides.left, false);
    assert.equal(room.seats.has("left"), false);
    assert.equal(room.match.players.length, 6, "자리가 비어도 선수는 6명 그대로");
  });

  test("재접속하면 입력 순서가 초기화되어 낮은 seq 도 받아들인다", () => {
    const { room, left } = versusRoom();
    run(room.match, ticksFor(MATCH.kickoffCountdownMs) + 1);

    room.setInput("left", { ...neutralInput(), seq: 900, ax: 1, ay: 0 });
    const token = room.seats.get("left")!.token;
    room.detach(left);

    const revived = makeConn("left-again");
    const seat = room.resume(token, revived);
    assert.ok(seat, "토큰으로 자리를 되찾아야 한다");
    assert.equal(seat!.side, "left");

    room.setInput("left", { ...neutralInput(), seq: 1, ax: 0, ay: -1 });
    assert.equal(
      room.match.controlledPlayer("left").input.ay,
      -1,
      "재접속 뒤 첫 입력(seq=1)이 버려지면 조작이 먹통이 된다",
    );
  });
});

// ---------------------------------------------------------------------------
// 방 픽스처
// ---------------------------------------------------------------------------

function makeConn(id: string): ClientConn & { sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  return {
    id,
    sent,
    send(msg: ServerMessage) {
      sent.push(msg);
    },
    close() {},
  };
}

function versusRoom(): {
  room: Room;
  left: ClientConn & { sent: ServerMessage[] };
  right: ClientConn & { sent: ServerMessage[] };
} {
  const room = new Room("TESTAA", "versus");
  const left = makeConn("left");
  const right = makeConn("right");
  const a = room.addHuman(left, "왼쪽");
  const b = room.addHuman(right, "오른쪽");
  assert.equal(a?.side, "left");
  assert.equal(b?.side, "right");
  assert.equal(room.maybeStart(), true, "두 자리가 차면 킥오프");
  assert.equal(room.match.humanSides.left, true);
  assert.equal(room.match.humanSides.right, true);
  return { room, left, right };
}
