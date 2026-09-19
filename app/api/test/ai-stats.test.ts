/**
 * 경기 기록(snapshot.stats)과 AI 판단 고도화 회귀 테스트.
 *
 * 고정 dt 틱과 고정 시드 난수만 쓴다. 이벤트 이름이 아니라 좌표·소유권·기록 값으로 확인하고,
 * 각 판단마다 "그 조건이 없으면 다르게 행동한다" 는 대조군을 함께 둔다.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";

import { MATCH, PITCH, PLAYER, type Side } from "../src/game/constants.ts";
import { Match, neutralInput, type Player, type SimEvent } from "../src/game/sim.ts";
import { choosePass, laneMargin, presserFor } from "../src/game/ai.ts";
import { Room, type ClientConn } from "../src/game/room.ts";
import type { InputState, ServerMessage } from "../src/protocol.ts";

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

function playingMatch(human: { left: boolean; right: boolean }): Match {
  const match = new Match();
  match.humanSides.left = human.left;
  match.humanSides.right = human.right;
  match.startMatch();
  run(match, ticksFor(MATCH.kickoffCountdownMs) + 1);
  assert.equal(match.phase, "playing");
  return match;
}

let seq = 1;
function press(match: Match, side: Side, patch: Partial<InputState>): void {
  match.setInput(side, { ...neutralInput(), ...patch, seq: seq++ });
}

function place(match: Match, id: string, x: number, y: number, facing?: number): Player {
  const p = match.byId.get(id)!;
  p.x = x;
  p.y = y;
  p.vx = 0;
  p.vy = 0;
  if (facing !== undefined) p.facing = facing;
  return p;
}

function ballAt(match: Match, x: number, y: number, vx = 0, vy = 0): void {
  match.ball.x = x;
  match.ball.y = y;
  match.ball.vx = vx;
  match.ball.vy = vy;
  match.ball.ownerId = null;
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 선수를 오래 넘어져 있게 해 경기에서 빼 둔다(AI 가 끼어들지 않게 하는 픽스처). */
function bench(match: Match, ids: string[]): void {
  for (const id of ids) {
    const p = match.byId.get(id)!;
    p.proneMs = 60_000;
  }
}

/** 사람 L3 가 발 앞의 공을 L2 에게 패스하기 직전 상태 */
function passFixture(): Match {
  const match = playingMatch({ left: true, right: true });
  place(match, "L3", 20, 17, 0);
  place(match, "L2", 32, 17);
  place(match, "L1", 6, 30);
  place(match, "R1", 50, 3);
  place(match, "R2", 50, 31);
  place(match, "R3", 54, 17);
  ballAt(match, 20 + PLAYER.radius + 0.3, 17);
  return match;
}

// ---------------------------------------------------------------------------
// 1. 경기 기록
// ---------------------------------------------------------------------------

describe("경기 기록 snapshot.stats", () => {
  test("새 경기는 0 으로 시작하고 모든 스냅샷에 두 팀 기록이 있다", () => {
    const match = new Match();
    const zero = { shots: 0, passes: 0, completedPasses: 0, possessionMs: 0 };
    assert.deepEqual(match.snapshot(0).stats, { left: zero, right: zero }, "waiting 에서도 내려간다");
    match.startMatch();
    assert.deepEqual(match.snapshot(0).stats, { left: zero, right: zero }, "countdown 에서도 내려간다");
  });

  test("발이 닿은 슛만 센다 — 헛발질은 세지 않는다(대조군)", () => {
    const match = passFixture();
    // 대조군: 공이 멀리 있으면 슛해도 기록이 늘지 않는다
    ballAt(match, 40, 5);
    press(match, "left", { shoot: true });
    run(match, 20);
    press(match, "left", {});
    run(match, 1);
    assert.equal(match.stats.left.shots, 0, "헛발질은 슛이 아니다");

    run(match, ticksFor(400));
    // 손을 놓은 사이 자동 전환이 일어났을 수 있으니 조작 선수를 L3 로 되돌린다
    match.controlled.left = "L3";
    place(match, "L3", 20, 17, 0);
    ballAt(match, 20 + PLAYER.radius + 0.3, 17);
    press(match, "left", { shoot: true });
    run(match, 20);
    press(match, "left", {});
    const events = run(match, 1);
    assert.equal(events.filter((e) => e.kind === "shoot").length, 1);
    assert.equal(match.stats.left.shots, 1, "실제로 찬 슛 1개");
    assert.equal(match.stats.right.shots, 0, "상대 기록은 그대로");
  });

  test("의도한 동료가 처음 공을 잡으면 완료 패스 1회로 센다", () => {
    const match = passFixture();
    press(match, "left", { pass: true });
    const kick = run(match, 1);
    press(match, "left", {});
    assert.equal(kick.find((e) => e.kind === "pass")?.kind === "pass" && (kick.find((e) => e.kind === "pass") as { targetId: string }).targetId, "L2");
    assert.equal(match.stats.left.passes, 1, "유효한 패스 1개");
    assert.equal(match.stats.left.completedPasses, 0, "아직 받기 전");

    let caughtAt = -1;
    run(match, ticksFor(2500), () => {
      if (caughtAt < 0 && match.ball.ownerId === "L2") caughtAt = match.tick;
    });
    assert.ok(caughtAt > 0, "L2 가 공을 받아야 한다");
    assert.equal(match.stats.left.completedPasses, 1, "받은 순간 1회");
    assert.equal(match.pendingPass, null, "완료 뒤에는 대기 중인 패스가 없다");
    // 계속 몰고 다녀도 두 번 세지 않는다
    run(match, ticksFor(1000));
    assert.ok(match.stats.left.completedPasses <= match.stats.left.passes, "완료 수는 패스 수를 넘지 않는다");
  });

  test("헛발질 패스는 세지 않고, 받을 동료가 없는 패스는 시도로만 센다(대조군)", () => {
    const match = passFixture();
    ballAt(match, 40, 5);
    press(match, "left", { pass: true });
    run(match, 1);
    press(match, "left", {});
    assert.equal(match.stats.left.passes, 0, "공이 발에 안 닿으면 패스가 아니다");

    run(match, ticksFor(400));
    match.controlled.left = "L3";
    place(match, "L3", 20, 17, Math.PI); // 뒤를 보면 받을 동료가 없다
    place(match, "L1", 30, 5); // 두 동료 모두 등 뒤(패스 시야각 밖)
    bench(match, ["L1", "L2"]);
    ballAt(match, 20 - PLAYER.radius - 0.3, 17);
    press(match, "left", { pass: true });
    const events = run(match, 1);
    const pass = events.find((e) => e.kind === "pass");
    assert.ok(pass && pass.kind === "pass" && pass.targetId === null, "대상 없는 패스");
    assert.equal(match.stats.left.passes, 1, "공을 찼으니 패스 시도 1회");
    assert.equal(match.pendingPass, null, "받을 사람이 없으니 완료 판정 대상이 아니다");
    run(match, ticksFor(3000));
    assert.equal(match.stats.left.completedPasses, 0);
  });

  test("상대가 먼저 공에 닿으면 완료 패스로 세지 않는다", () => {
    const match = passFixture();
    // 사람이 조작하는 R3 를 패스 길목에 세워 둔다(중립 입력이라 가만히 서 있다)
    place(match, "R3", 26, 17);
    press(match, "left", { pass: true });
    run(match, 1);
    press(match, "left", {});
    assert.equal(match.stats.left.passes, 1);
    run(match, ticksFor(2500));
    assert.equal(match.stats.left.completedPasses, 0, "가로막힌 패스는 완료가 아니다");
    // 대조군: 같은 배치에서 상대를 치우면 완료된다 → 위 결과는 상대 터치 때문이다
    const control = passFixture();
    press(control, "left", { pass: true });
    run(control, 1);
    press(control, "left", {});
    run(control, ticksFor(2500));
    assert.equal(control.stats.left.completedPasses, 1, "대조군은 완료");
  });

  /** L3 가 L2 에게 준 패스가 굴러가는 중인 상태를 직접 만든다(다른 선수는 모두 벤치). */
  function inFlight(withOpponentAt: { x: number; y: number } | null): Match {
    const match = playingMatch({ left: true, right: true });
    place(match, "L3", 10, 5);
    place(match, "L1", 6, 30);
    for (const id of ["R1", "R2"]) place(match, id, 50, id === "R1" ? 3 : 31);
    place(match, "R3", withOpponentAt?.x ?? 54, withOpponentAt?.y ?? 3);
    bench(match, ["L1", "R1", "R2"]);
    match.pendingPass = { side: "left", passerId: "L3", targetId: "L2", msLeft: 2500 };
    return match;
  }

  test("같은 틱에 상대가 공에 닿고 받을 동료가 소유해도 완료로 세지 않는다", () => {
    // 공 양옆에 L2(움직이는 중, 드리블 사거리 안)와 R3(겹쳐서 충돌)를 세운다
    const match = inFlight({ x: 30.45, y: 17 });
    const l2 = place(match, "L2", 29, 17);
    l2.vx = 2;
    ballAt(match, 30, 17);
    run(match, 1);
    assert.equal(match.ball.ownerId, "L2", "전제: 이 틱에 L2 가 소유자가 된다");
    assert.equal(match.stats.left.completedPasses, 0, "상대가 먼저/같이 닿았으니 완료가 아니다");
    assert.equal(match.pendingPass, null);

    // 대조군: 상대가 없으면 같은 틱에 완료된다
    const control = inFlight(null);
    const c2 = place(control, "L2", 29, 17);
    c2.vx = 2;
    ballAt(control, 30, 17);
    run(control, 1);
    assert.equal(control.ball.ownerId, "L2");
    assert.equal(control.stats.left.completedPasses, 1, "대조군은 완료");
  });

  test("상대 터치 뒤 우리 선수가 건드려 마지막 터치가 덮여도 취소는 유지된다", () => {
    const match = inFlight({ x: 30.45, y: 17 });
    place(match, "L2", 45, 17);
    ballAt(match, 30, 17);
    run(match, 1);
    assert.equal(match.pendingPass, null, "상대가 닿은 순간 취소");
    // 마지막 터치를 우리 편으로 덮은 뒤 L2 가 잡는다
    match.lastToucherId = "L3";
    place(match, "R3", 54, 3);
    const l2 = place(match, "L2", 29, 17);
    l2.vx = 2;
    ballAt(match, 30, 17);
    run(match, 1);
    assert.equal(match.ball.ownerId, "L2");
    assert.equal(match.stats.left.completedPasses, 0, "이미 끊긴 패스는 나중에 받아도 완료가 아니다");
  });

  test("받을 동료가 제한 시간 안에 잡지 못하면 취소된다", () => {
    const match = passFixture();
    press(match, "left", { pass: true });
    run(match, 1);
    press(match, "left", {});
    // 받을 동료와 주변 선수가 모두 넘어져 있으면 아무도 공을 소유하지 못한다
    bench(match, ["L1", "L2", "R1", "R2"]);
    run(match, ticksFor(2700));
    assert.equal(match.pendingPass, null, "시간이 지나면 대기가 풀린다");
    assert.equal(match.stats.left.completedPasses, 0);
    // 취소 뒤 L2 가 일어나 공을 잡아도 늦게 세지 않는다
    match.byId.get("L2")!.proneMs = 0;
    run(match, ticksFor(3000));
    assert.equal(match.stats.left.completedPasses, 0, "만료된 패스는 나중에 잡아도 완료가 아니다");
  });

  test("새 패스는 이전 패스를 취소하고, 슛도 대기 중인 패스를 취소한다", () => {
    const match = passFixture();
    press(match, "left", { pass: true });
    run(match, 1);
    assert.ok(match.pendingPass !== null);
    // 공이 아직 발 앞에 있다고 보고 바로 슛(패스 직후 같은 선수가 다시 찬 상황)
    ballAt(match, match.byId.get("L3")!.x + PLAYER.radius + 0.3, 17, 3, 0);
    press(match, "left", { shoot: true });
    run(match, 5);
    press(match, "left", {});
    run(match, 1);
    assert.equal(match.stats.left.shots, 1);
    assert.equal(match.pendingPass, null, "슛이 나가면 패스 완료 판정은 끝난다");
    run(match, ticksFor(2500));
    assert.equal(match.stats.left.completedPasses, 0);
  });

  test("점유 시간은 playing 에서 공을 가진 팀에만 쌓인다", () => {
    const match = passFixture();
    // 사람 L3 가 공을 몰고 1초 달린다
    press(match, "left", { ax: 1, ay: 0 });
    run(match, ticksFor(1000));
    const left = match.stats.left.possessionMs;
    assert.equal(match.ball.ownerId, "L3");
    assert.ok(left > 800 && left <= 1000 + 17, `1초 가까이 쌓여야 한다 (${left})`);
    assert.equal(match.stats.right.possessionMs, 0, "상대는 공을 가진 적이 없다");

    // 대조군: countdown 동안에는 늘지 않는다
    const counting = new Match();
    counting.startMatch();
    counting.ball.ownerId = "L1";
    run(counting, ticksFor(1000));
    assert.equal(counting.stats.left.possessionMs, 0, "countdown 은 점유 시간이 아니다");
    const snap = match.snapshot(0).stats.left.possessionMs;
    assert.equal(snap, Math.round(left), "스냅샷은 정수 ms");
  });

  test("득점 후 킥오프에서는 기록이 유지되고 재경기에서만 초기화된다", () => {
    const match = passFixture();
    press(match, "left", { pass: true });
    run(match, 1);
    press(match, "left", {});
    run(match, ticksFor(2000));
    // 슛으로 득점(패스를 받은 L2 로 조작이 넘어갔으니 L3 로 되돌린다)
    match.controlled.left = "L3";
    place(match, "L3", PITCH.length - 3, PITCH.width / 2, 0);
    ballAt(match, PITCH.length - 3 + PLAYER.radius + 0.3, PITCH.width / 2);
    place(match, "R3", 40, 5);
    match.byId.get("R3")!.proneMs = 0;
    press(match, "left", { shoot: true });
    run(match, 10);
    press(match, "left", {});
    const events = run(match, ticksFor(600));
    assert.ok(events.some((e) => e.kind === "goal"), "득점해야 한다");
    const before = structuredClone(match.stats);
    assert.ok(before.left.shots >= 1 && before.left.passes >= 1);

    run(match, ticksFor(MATCH.goalCelebrationMs + MATCH.kickoffCountdownMs + 100));
    assert.equal(match.phase, "playing");
    assert.ok(match.stats.left.shots >= before.left.shots, "킥오프 뒤에도 슛 기록 유지");
    assert.ok(match.stats.left.passes >= before.left.passes, "킥오프 뒤에도 패스 기록 유지");
    assert.ok(match.stats.left.possessionMs >= before.left.possessionMs, "점유 시간 유지");

    match.startMatch();
    const zero = { shots: 0, passes: 0, completedPasses: 0, possessionMs: 0 };
    assert.deepEqual(match.stats, { left: zero, right: zero }, "재경기는 0 부터");
    assert.equal(match.pendingPass, null);
  });

  test("방의 재경기 흐름에서도 기록이 초기화되고 클라이언트 스냅샷에 실린다", () => {
    const sentA: ServerMessage[] = [];
    const sentB: ServerMessage[] = [];
    const conn = (id: string, sent: ServerMessage[]): ClientConn => ({
      id,
      send: (m) => {
        sent.push(m);
      },
      close: () => {},
    });
    const room = new Room("STATS1", "versus");
    room.addHuman(conn("a", sentA), "A");
    room.addHuman(conn("b", sentB), "B");
    room.match.stats.left.shots = 4;
    room.match.stats.right.possessionMs = 1234;
    room.match.phase = "ended";
    room.setRematch("left", true);
    room.setRematch("right", true);
    assert.equal(room.match.stats.left.shots, 0);
    assert.equal(room.match.stats.right.possessionMs, 0);
    for (let i = 0; i < 6; i += 1) room.advance(1000 / 60, Date.now());
    const snap = sentA.filter((m) => m.t === "snapshot").at(-1);
    assert.ok(snap && snap.t === "snapshot", "스냅샷이 나가야 한다");
    assert.deepEqual(Object.keys(snap.stats.left).sort(), ["completedPasses", "passes", "possessionMs", "shots"]);
  });
});

// ---------------------------------------------------------------------------
// 2. AI 판단
// ---------------------------------------------------------------------------

describe("AI 패스 판단", () => {
  test("패스 길이 상대에게 막힌 동료 대신 열린 동료를 고른다", () => {
    const match = playingMatch({ left: false, right: false });
    // L1 이 공을 가지고, 앞쪽 L3 와 옆쪽 L2 가 있다
    const carrier = place(match, "L1", 20, 17, 0);
    place(match, "L3", 32, 17);
    place(match, "L2", 26, 27);
    place(match, "R1", 50, 3);
    place(match, "R2", 50, 31);
    place(match, "R3", 54, 17);
    const open = choosePass(match, carrier);
    assert.equal(open?.mate.id, "L3", "대조군: 길이 열려 있으면 더 앞선 L3");

    // L1 → L3 길목에 상대를 세우면 L3 는 후보에서 빠진다
    place(match, "R2", 26, 17.3);
    const opps = match.team("right");
    assert.ok(laneMargin(carrier, match.byId.get("L3")!, opps) < 0, "L3 로 가는 길은 막혔다");
    const chosen = choosePass(match, carrier);
    assert.equal(chosen?.mate.id, "L2", "막힌 길 대신 열린 L2");
  });

  test("압박받는 AI 는 실제로 열린 동료에게 패스하고 그 동료가 받는다", () => {
    const match = playingMatch({ left: false, right: false });
    place(match, "L1", 20, 17, 0);
    place(match, "L3", 32, 17);
    place(match, "L2", 27, 27);
    place(match, "R2", 26, 17.3); // L3 로 가는 길목
    place(match, "R1", 19, 19.5); // 바로 옆에서 압박
    place(match, "R3", 54, 17);
    bench(match, ["R2", "R3"]);
    ballAt(match, 20 + PLAYER.radius + 0.3, 17);
    match.ball.ownerId = "L1";
    const events = run(match, ticksFor(600));
    const pass = events.find((e) => e.kind === "pass" && e.playerId === "L1");
    assert.ok(pass && pass.kind === "pass", "압박받으면 패스해야 한다");
    assert.equal(pass.targetId, "L2", "막힌 L3 가 아니라 L2 에게");
  });

  test("패스를 받을 AI 는 공이 굴러오는 궤적으로 마중 나간다", () => {
    const match = playingMatch({ left: true, right: false });
    // 사람 L3 가 옆으로 비껴 선 L2 에게 준다. 공은 L2 가 서 있던 자리보다 앞쪽을 지난다.
    place(match, "L3", 20, 17, 0);
    const l2 = place(match, "L2", 30, 20);
    place(match, "L1", 6, 30);
    for (const id of ["R1", "R2", "R3"]) place(match, id, 50, 3 + Number(id[1]) * 8);
    bench(match, ["R1", "R2", "R3", "L1"]);
    ballAt(match, 20 + PLAYER.radius + 0.3, 17);
    press(match, "left", { pass: true });
    run(match, 1);
    press(match, "left", {});
    const start = { x: l2.x, y: l2.y };
    // 0.3초 뒤 L2 는 공의 진행 방향 쪽으로 움직이고 있어야 한다
    run(match, ticksFor(300));
    const moved = dist(l2, start);
    assert.ok(moved > 0.5, `받는 동료가 가만히 기다리면 안 된다 (이동 ${moved.toFixed(2)}m)`);
    const b = match.ball;
    const towardLine = (l2.vx * (b.x - l2.x) + l2.vy * (b.y - l2.y)) / (dist(l2, b) || 1);
    assert.ok(towardLine > 0 || dist(l2, b) < 2, "공 쪽으로 다가가야 한다");
    run(match, ticksFor(2000));
    assert.equal(match.stats.left.completedPasses, 1, "마중 나간 동료가 받아서 완료");
  });
});

describe("AI 수비 분담", () => {
  test("상대가 공을 몰면 한 명만 압박하고, 한 명은 골문을, 한 명은 위험한 상대를 막는다", () => {
    // 오른쪽은 사람 팀: 조작 선수 R3 가 왼쪽 골문 쪽으로 천천히 공을 몬다(결정론적 공격자).
    // 왼쪽은 AI 셋. R3 뒤에서 L3 가 쫓아오고, L2 는 R2 근처, L1 은 골문 앞에 있다.
    const match = playingMatch({ left: false, right: true });
    place(match, "R3", 30, 17, Math.PI);
    place(match, "R2", 24, 8);
    place(match, "R1", 40, 26);
    place(match, "L1", 12, 20);
    place(match, "L2", 21, 11);
    place(match, "L3", 36, 15);
    ballAt(match, 30 - PLAYER.radius - 0.3, 17);
    match.ball.ownerId = "R3";
    press(match, "right", { ax: -0.5, ay: 0 });
    const startTick = match.tick;
    const goal = { x: 0, y: PITCH.width / 2 };
    let closers = 0;
    let samples = 0;
    let coverOk = 0;
    let markSamples = 0;
    let markOk = 0;
    let presserChanges = 0;
    let lastPresser: string | null = null;
    run(match, ticksFor(1200), () => {
      if (match.ball.ownerId === null || match.byId.get(match.ball.ownerId)!.side !== "right") return;
      samples += 1;
      const presser = presserFor(match, "left")!;
      if (lastPresser && presser.id !== lastPresser) presserChanges += 1;
      lastPresser = presser.id;
      // 공에서 5m 밖에서 공 쪽으로 달려드는 왼쪽 선수 수
      closers += match.team("left").filter((p) => {
        const d = dist(p, match.ball);
        return d > 5 && (p.vx * (match.ball.x - p.x) + p.vy * (match.ball.y - p.y)) / d > 3;
      }).length;
      const others = match.team("left").filter((p) => p.id !== presser.id);
      // 압박하지 않는 선수 중 누군가는 공보다 우리 골문에 가깝다(골문 담당)
      if (others.some((p) => dist(p, goal) < dist(match.ball, goal) - 2)) coverOk += 1;
      // 0.5초 뒤부터는 누군가가 공을 갖지 않은 상대 한 명에게 4m 안으로 붙어 있다(마크 담당)
      if (match.tick - startTick > ticksFor(500)) {
        markSamples += 1;
        const free = match.team("right").filter((o) => o.id !== match.ball.ownerId);
        if (others.some((p) => free.some((o) => dist(p, o) < 4))) markOk += 1;
      }
    });
    assert.ok(samples > 30, `상대가 공을 가진 상황이 유지되어야 한다 (${samples}틱)`);
    assert.ok(closers / samples < 1.2, `모두 공으로 몰려들면 안 된다 (평균 ${(closers / samples).toFixed(2)}명)`);
    assert.ok(presserChanges <= 2, `압박 담당이 틱마다 뒤집히면 안 된다 (${presserChanges}회)`);
    assert.ok(coverOk / samples > 0.9, `골문 담당이 공보다 뒤에 남아 있어야 한다 (${coverOk}/${samples})`);
    assert.ok(markSamples > 0 && markOk / markSamples > 0.6, `마크 담당이 상대에게 붙어야 한다 (${markOk}/${markSamples})`);
  });

  test("공 가진 동료를 앞·옆·뒤로 벌려 지원하고, 상대가 서 있는 길은 피한다", () => {
    const match = playingMatch({ left: true, right: false });
    const me = place(match, "L3", 22, 17, 0);
    place(match, "L1", 10, 17);
    place(match, "L2", 14, 17);
    place(match, "R1", 30, 12);
    place(match, "R2", 44, 24);
    place(match, "R3", 50, 17);
    bench(match, ["R1", "R2", "R3"]);
    ballAt(match, 22 + PLAYER.radius + 0.3, 17);
    press(match, "left", { ax: 0.2, ay: 0 });
    run(match, ticksFor(2000));
    assert.equal(match.ball.ownerId, "L3", "사람이 계속 공을 가진 상태");
    const l1 = match.byId.get("L1")!;
    const l2 = match.byId.get("L2")!;
    assert.ok(l1.x < me.x, "수비수는 뒤에서 받쳐 준다");
    assert.ok(l2.x > me.x - 3, "미드필더는 옆이나 앞으로 올라온다");
    assert.ok(Math.abs(l2.y - me.y) > 3, "미드필더는 옆으로 벌린다");
    assert.ok(dist(l1, l2) > 5, "두 지원 선수는 같은 자리에 겹치지 않는다");
    const opps = match.team("right");
    for (const p of [l1, l2]) {
      assert.ok(laneMargin(me, p, opps) > -0.5, `${p.id} 로 가는 패스 길이 열려 있다`);
    }
  });
});

describe("AI 대 AI 전체 경기 시뮬레이션", () => {
  test("세 경기 동안 기록이 일관되고, 패스 절반 이상이 이어지며, 공에 몰려들지 않는다", () => {
    let passes = 0;
    let completed = 0;
    let crowd = 0;
    let samples = 0;
    for (const seed of [11, 22, 33]) {
      Math.random = mulberry32(seed);
      const match = new Match();
      match.startMatch();
      let shootEvents: Record<Side, number> = { left: 0, right: 0 };
      let passEvents: Record<Side, number> = { left: 0, right: 0 };
      let playingMs = 0;
      while (match.phase !== "ended") {
        const events = match.step(DT);
        for (const e of events) {
          if (e.kind === "shoot") shootEvents[match.byId.get(e.playerId)!.side] += 1;
          if (e.kind === "pass") passEvents[match.byId.get(e.playerId)!.side] += 1;
        }
        if (match.phase === "playing") {
          playingMs += DT * 1000;
          for (const side of ["left", "right"] as const) {
            crowd += match.team(side).filter((p) => dist(p, match.ball) < 4).length;
            samples += 1;
          }
        }
      }
      const snap = match.snapshot(0).stats;
      for (const side of ["left", "right"] as const) {
        assert.equal(snap[side].shots, shootEvents[side], `${side} 슛 기록 = shoot 이벤트 수`);
        assert.equal(snap[side].passes, passEvents[side], `${side} 패스 기록 = pass 이벤트 수`);
        assert.ok(snap[side].completedPasses <= snap[side].passes);
      }
      const poss = snap.left.possessionMs + snap.right.possessionMs;
      assert.ok(poss <= playingMs + 20, `점유 합(${poss})은 경기 진행 시간(${Math.round(playingMs)})을 넘지 않는다`);
      assert.ok(poss > playingMs * 0.3, "AI 가 공을 실제로 소유하며 경기해야 한다");
      passes += snap.left.passes + snap.right.passes;
      completed += snap.left.completedPasses + snap.right.completedPasses;
      shootEvents = { left: 0, right: 0 };
      passEvents = { left: 0, right: 0 };
    }
    assert.ok(passes > 30, `AI 가 패스로 경기를 풀어야 한다 (${passes}회)`);
    const rate = completed / passes;
    assert.ok(rate > 0.45, `패스 성공률이 절반 가까이는 되어야 한다 (${(rate * 100).toFixed(1)}%)`);
    const avgNear = crowd / samples;
    assert.ok(avgNear < 1.6, `팀당 공 4m 안 평균 인원 ${avgNear.toFixed(2)} — 모두 공을 쫓지 않는다`);
  });
});
