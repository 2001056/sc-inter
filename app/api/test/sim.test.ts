import { test } from "node:test";
import assert from "node:assert/strict";
import { Match, neutralInput, type SimEvent } from "../src/game/sim.ts";
import { MATCH, PITCH, SKILL, STAMINA, TEAM_SIZE } from "../src/game/constants.ts";
import type { InputState, Side } from "../src/protocol.ts";

const DT = 1 / MATCH.tickHz;

function input(over: Partial<InputState> = {}): InputState {
  return { ...neutralInput(), ...over };
}

function runFor(m: Match, ms: number): SimEvent[] {
  const events: SimEvent[] = [];
  const steps = Math.round(ms / (DT * 1000));
  for (let i = 0; i < steps; i += 1) events.push(...m.step(DT));
  return events;
}

/** 카운트다운을 지나 playing 상태의 3대3 경기를 만든다(양 팀 다 사람). */
function playingMatch(): Match {
  const m = new Match();
  m.humanSides.left = true;
  m.humanSides.right = true;
  m.startMatch();
  runFor(m, MATCH.kickoffCountdownMs + 50);
  assert.equal(m.phase, "playing");
  return m;
}

/** 지정한 선수만 남기고 나머지를 구석으로 치운다. */
function isolate(m: Match, keepIds: string[]): void {
  let corner = 0;
  for (const p of m.players) {
    if (keepIds.includes(p.id)) continue;
    corner += 1;
    p.x = 1 + corner * 0.9;
    p.y = 1.2;
    p.vx = 0;
    p.vy = 0;
  }
}

function press(m: Match, side: Side, over: Partial<InputState>, seq: number): void {
  m.setInput(side, input({ ...over, seq }));
}

test("3대3 선수 6명이 고유한 id 와 역할로 만들어진다", () => {
  const m = new Match();
  assert.equal(m.players.length, TEAM_SIZE * 2);
  assert.deepEqual(
    m.players.map((p) => p.id),
    ["L1", "L2", "L3", "R1", "R2", "R3"],
  );
  assert.deepEqual(
    m.team("left").map((p) => p.role),
    ["defender", "mid", "forward"],
  );
  assert.equal(m.team("right").length, 3);
});

test("킥오프는 카운트다운 뒤에 시작한다", () => {
  const m = new Match();
  m.startMatch();
  assert.equal(m.phase, "countdown");
  runFor(m, MATCH.kickoffCountdownMs - 100);
  assert.equal(m.phase, "countdown");
  const events = runFor(m, 200);
  assert.equal(m.phase, "playing");
  assert.ok(events.some((e) => e.kind === "kickoff"));
});

test("카운트다운 동안에는 아무도 움직이지 않는다", () => {
  const m = new Match();
  m.humanSides.left = true;
  m.startMatch();
  press(m, "left", { ax: 1 }, 1);
  const before = m.players.map((p) => `${p.x},${p.y}`);
  runFor(m, 1000);
  assert.deepEqual(
    m.players.map((p) => `${p.x},${p.y}`),
    before,
  );
});

test("조작 중인 선수만 사람 입력을 따른다", () => {
  const m = playingMatch();
  m.controlled.left = "L1";
  const me = m.byId.get("L1")!;
  isolate(m, ["L1"]);
  const startX = me.x;
  press(m, "left", { ax: 1, ay: 0 }, 1);
  runFor(m, 600);
  assert.ok(me.x > startX + 1, `x=${me.x}`);
});

test("달리기는 더 빠르고 스태미나를 쓴다", () => {
  const run = playingMatch();
  run.controlled.left = "L1";
  isolate(run, ["L1"]);
  press(run, "left", { ax: 1 }, 1);
  runFor(run, 1500);

  const sprint = playingMatch();
  sprint.controlled.left = "L1";
  isolate(sprint, ["L1"]);
  press(sprint, "left", { ax: 1, sprint: true }, 1);
  runFor(sprint, 1500);

  const a = run.byId.get("L1")!;
  const b = sprint.byId.get("L1")!;
  assert.ok(b.x > a.x + 1, `${a.x} vs ${b.x}`);
  assert.ok(b.stamina < a.stamina);
});

test("충전한 슛이 골대로 들어가 득점한다", () => {
  const m = playingMatch();
  m.controlled.left = "L3";
  const me = m.byId.get("L3")!;
  isolate(m, ["L3"]);
  m.ball.x = PITCH.length - 12;
  m.ball.y = PITCH.width / 2;
  m.ball.vx = 0;
  m.ball.vy = 0;
  me.x = m.ball.x - 0.9;
  me.y = m.ball.y;
  me.facing = 0;

  press(m, "left", { shoot: true }, 1);
  runFor(m, 700);
  press(m, "left", { shoot: false }, 2);
  const kicked = runFor(m, 100);
  assert.ok(kicked.some((e) => e.kind === "shoot"));
  assert.ok(m.ball.vx > 10, `ball vx=${m.ball.vx}`);

  const events = runFor(m, 3000);
  const goal = events.find((e) => e.kind === "goal");
  assert.ok(goal, "골 이벤트가 나와야 한다");
  assert.equal(goal.kind === "goal" ? goal.side : null, "left");
  assert.equal(goal.kind === "goal" ? goal.scorerId : null, "L3");
  assert.equal(m.score.left, 1);
});

test("패스는 바라보는 쪽 동료에게 굴러간다", () => {
  const m = playingMatch();
  m.controlled.left = "L3";
  const me = m.byId.get("L3")!;
  const mate = m.byId.get("L2")!;
  isolate(m, ["L3", "L2"]);
  me.x = 20;
  me.y = 17;
  me.facing = 0;
  mate.x = 32;
  mate.y = 17;
  mate.vx = 0;
  mate.vy = 0;
  m.ball.x = me.x + 0.6;
  m.ball.y = me.y;
  m.ball.vx = 0;
  m.ball.vy = 0;

  press(m, "left", { pass: true }, 1);
  const events = runFor(m, 60);
  const pass = events.find((e) => e.kind === "pass");
  assert.ok(pass, "패스 이벤트가 나와야 한다");
  assert.equal(pass.kind === "pass" ? pass.targetId : null, "L2");
  assert.ok(m.ball.vx > 5, `ball vx=${m.ball.vx}`);
  assert.ok(Math.abs(m.ball.vy) < 3);
});

test("동료가 없는 방향으로 패스하면 앞으로만 나간다", () => {
  const m = playingMatch();
  m.controlled.left = "L3";
  const me = m.byId.get("L3")!;
  isolate(m, ["L3"]);
  me.x = 20;
  me.y = 17;
  me.facing = Math.PI / 2;
  m.ball.x = me.x;
  m.ball.y = me.y + 0.6;
  press(m, "left", { pass: true }, 1);
  const events = runFor(m, 60);
  const pass = events.find((e) => e.kind === "pass");
  assert.ok(pass && pass.kind === "pass" && pass.targetId === null);
  assert.ok(m.ball.vy > 5);
});

test("개인기 방향을 공격 방향 기준으로 해석한다", () => {
  const cases: Array<[Side, { x: number; y: number }, string]> = [
    ["left", { x: 1, y: 0 }, "stepover"],
    ["left", { x: -1, y: 0 }, "dragback"],
    ["left", { x: 0, y: -1 }, "feintLeft"],
    ["left", { x: 0, y: 1 }, "feintRight"],
    // 오른쪽 팀은 -x 로 공격하므로 앞뒤가 뒤집힌다
    ["right", { x: -1, y: 0 }, "stepover"],
    ["right", { x: 1, y: 0 }, "dragback"],
  ];
  for (const [side, dir, expected] of cases) {
    const m = playingMatch();
    const id = side === "left" ? "L3" : "R3";
    m.controlled[side] = id;
    isolate(m, [id]);
    press(m, side, { skillDir: dir }, 1);
    const events = runFor(m, 40);
    const skill = events.find((e) => e.kind === "skill");
    assert.ok(skill, `${side} ${expected} 개인기가 나와야 한다`);
    assert.equal(skill.kind === "skill" ? skill.skill : null, expected);
  }
});

test("개인기는 쿨다운과 스태미나를 쓰고 가까운 상대를 흔든다", () => {
  const m = playingMatch();
  m.controlled.left = "L3";
  const me = m.byId.get("L3")!;
  const foe = m.byId.get("R3")!;
  isolate(m, ["L3", "R3"]);
  me.x = 25;
  me.y = 17;
  me.facing = 0;
  foe.x = 26.5;
  foe.y = 17;

  press(m, "left", { skillDir: { x: 1, y: 0 } }, 1);
  const events = runFor(m, 40);
  const skill = events.find((e) => e.kind === "skill");
  assert.ok(skill && skill.kind === "skill" && skill.beat);
  assert.ok(foe.staggerMs > 0);
  assert.ok(me.skillCdMs > 0);
  assert.ok(me.stamina <= 1 - STAMINA.skillCost + 0.05);

  runFor(m, SKILL.stepover.durationMs + 20);
  assert.equal(me.skill, null);
  press(m, "left", { skillDir: { x: 1, y: 0 } }, 2);
  runFor(m, 40);
  assert.equal(me.skill, null, "쿨다운 중에는 다시 나가지 않는다");
});

test("태클은 공을 걷어내고 끝나면 넘어져 있다", () => {
  const m = playingMatch();
  m.controlled.right = "R3";
  const me = m.byId.get("R3")!;
  isolate(m, ["R3"]);
  me.x = 30;
  me.y = 17;
  me.facing = Math.PI;
  m.ball.x = 29;
  m.ball.y = 17;
  m.ball.vx = 0;
  m.ball.vy = 0;

  press(m, "right", { tackle: true }, 1);
  runFor(m, SKILL.tackle.durationMs + 20);
  assert.ok(Math.hypot(m.ball.vx, m.ball.vy) > 5, "공이 튕겨 나가야 한다");
  assert.ok(me.proneMs > 0);
  assert.ok(me.tackleCdMs > 0);
});

test("동료가 공을 잡으면 조작 선수가 그쪽으로 넘어간다", () => {
  const m = playingMatch();
  m.controlled.left = "L1";
  const mate = m.byId.get("L2")!;
  isolate(m, ["L1", "L2"]);
  mate.x = 25;
  mate.y = 17;
  mate.vx = 3;
  m.ball.x = mate.x + 0.7;
  m.ball.y = mate.y;

  const events = runFor(m, 300);
  assert.equal(m.controlled.left, "L2");
  assert.ok(events.some((e) => e.kind === "control"));
});

test("수동 전환은 공에 가까운 동료로 넘긴다", () => {
  const m = playingMatch();
  m.controlled.left = "L1";
  const target = m.byId.get("L3")!;
  m.ball.x = target.x + 0.5;
  m.ball.y = target.y;
  m.manualSwitch("left");
  assert.equal(m.controlled.left, "L3");
});

test("사람이 없는 팀은 AI 가 알아서 움직인다", () => {
  const m = new Match();
  m.humanSides.left = true;
  m.humanSides.right = false;
  m.startMatch();
  runFor(m, MATCH.kickoffCountdownMs + 50);
  const before = m.team("right").map((p) => ({ id: p.id, x: p.x, y: p.y }));
  runFor(m, 1500);
  const moved = m.team("right").some((p) => {
    const b = before.find((q) => q.id === p.id)!;
    return Math.hypot(p.x - b.x, p.y - b.y) > 0.5;
  });
  assert.ok(moved, "AI 팀이 움직여야 한다");
});

test("시간이 다 되면 점수가 높은 쪽이 이긴다", () => {
  const m = playingMatch();
  m.score.left = 2;
  m.score.right = 1;
  m.timeLeftMs = 200;
  const events = runFor(m, 400);
  const end = events.find((e) => e.kind === "matchEnd");
  assert.ok(end);
  assert.equal(end.kind === "matchEnd" ? end.result : null, "left");
  assert.equal(m.phase, "ended");
});

test("동점으로 끝나면 무승부다", () => {
  const m = playingMatch();
  m.timeLeftMs = 100;
  const events = runFor(m, 300);
  const end = events.find((e) => e.kind === "matchEnd");
  assert.equal(end && end.kind === "matchEnd" ? end.result : null, "draw");
});

test("득점 뒤에는 세리머니를 거쳐 다시 카운트다운으로 간다", () => {
  const m = playingMatch();
  m.ball.x = PITCH.length - 0.5;
  m.ball.y = PITCH.width / 2;
  m.ball.vx = 20;
  runFor(m, 100);
  assert.equal(m.phase, "goal");
  runFor(m, MATCH.goalCelebrationMs + 100);
  assert.equal(m.phase, "countdown");
  assert.equal(m.ball.x, PITCH.length / 2);
});

test("골문 밖 골라인에서는 공이 튕긴다", () => {
  const m = playingMatch();
  m.ball.x = 2;
  m.ball.y = 3;
  m.ball.vx = -12;
  runFor(m, 400);
  assert.equal(m.phase, "playing");
  assert.ok(m.ball.vx > 0);
  assert.equal(m.score.right, 0);
});

test("선수와 공은 경기장 밖으로 나가지 않는다", () => {
  const m = playingMatch();
  m.controlled.left = "L1";
  press(m, "left", { ax: -1, ay: -1, sprint: true }, 1);
  runFor(m, 4000);
  for (const p of m.players) {
    assert.ok(p.x >= 0 && p.x <= PITCH.length, `${p.id} x=${p.x}`);
    assert.ok(p.y >= 0 && p.y <= PITCH.width, `${p.id} y=${p.y}`);
  }
  assert.ok(m.ball.y >= 0 && m.ball.y <= PITCH.width);
});

test("스냅샷은 여섯 선수와 조작 선수·패스 대상을 담는다", () => {
  const m = playingMatch();
  const snap = m.snapshot(1234);
  assert.equal(snap.t, "snapshot");
  assert.equal(snap.ts, 1234);
  assert.equal(snap.players.length, 6);
  assert.equal(snap.controlled.left, m.controlled.left);
  assert.equal(snap.players.filter((p) => p.controlled).length, 2);
  assert.ok(snap.players[0] && typeof snap.players[0].facing === "number");
  assert.ok("ownerId" in snap.ball);
  assert.ok(snap.passTarget.left === null || typeof snap.passTarget.left === "string");
});
