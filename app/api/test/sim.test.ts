import { test } from "node:test";
import assert from "node:assert/strict";
import { Match, NEUTRAL_INPUT, type SimEvent } from "../src/game/sim.ts";
import { MATCH, PITCH, SKILL, STAMINA } from "../src/game/constants.ts";
import type { InputState, SkillKind } from "../src/protocol.ts";

const DT = 1 / MATCH.tickHz;

function input(over: Partial<InputState> = {}): InputState {
  return { ...NEUTRAL_INPUT, seq: 0, ...over };
}

/** 카운트다운을 지나 playing 상태의 경기를 만든다. */
function playingMatch(): Match {
  const m = new Match();
  m.startMatch();
  runFor(m, MATCH.kickoffCountdownMs + 50);
  assert.equal(m.phase, "playing");
  return m;
}

function runFor(m: Match, ms: number): SimEvent[] {
  const events: SimEvent[] = [];
  const steps = Math.round(ms / (DT * 1000));
  for (let i = 0; i < steps; i += 1) events.push(...m.step(DT));
  return events;
}

/** 공과 상대 선수를 옆으로 치워 달리기만 재는 경로를 만든다. */
function clearPath(m: Match): void {
  m.ball.x = PITCH.length / 2;
  m.ball.y = 2;
  m.players.right.y = 40;
}

/** seq 를 늘려가며 입력을 넣는다. */
function press(m: Match, side: "left" | "right", over: Partial<InputState>, seq: number) {
  m.setInput(side, input({ ...over, seq }));
}

test("킥오프는 카운트다운 뒤에 시작한다", () => {
  const m = new Match();
  m.startMatch();
  assert.equal(m.phase, "countdown");
  const early = runFor(m, MATCH.kickoffCountdownMs - 100);
  assert.equal(m.phase, "countdown");
  assert.equal(early.length, 0);
  const events = runFor(m, 200);
  assert.equal(m.phase, "playing");
  assert.ok(events.some((e) => e.kind === "kickoff"));
});

test("카운트다운 동안에는 선수가 움직이지 않는다", () => {
  const m = new Match();
  m.startMatch();
  press(m, "left", { ax: 1 }, 1);
  const startX = m.players.left.x;
  runFor(m, 1000);
  assert.equal(m.players.left.x, startX);
});

test("입력을 주면 선수가 그 방향으로 움직인다", () => {
  const m = playingMatch();
  const before = { ...m.players.left };
  press(m, "left", { ax: 1, ay: 0 }, 1);
  runFor(m, 500);
  assert.ok(m.players.left.x > before.x + 1, `x=${m.players.left.x}`);
  assert.ok(Math.abs(m.players.left.y - before.y) < 0.2);
});

test("과거 seq 입력은 무시한다", () => {
  const m = playingMatch();
  press(m, "left", { ax: 1 }, 5);
  press(m, "left", { ax: -1 }, 2);
  runFor(m, 300);
  assert.ok(m.players.left.x > PITCH.length * 0.3);
});

test("스프린트는 더 빠르고 스태미나를 쓴다", () => {
  const run = playingMatch();
  clearPath(run);
  press(run, "left", { ax: 1 }, 1);
  runFor(run, 1500);

  const sprint = playingMatch();
  clearPath(sprint);
  press(sprint, "left", { ax: 1, sprint: true }, 1);
  runFor(sprint, 1500);

  assert.ok(sprint.players.left.x > run.players.left.x + 1);
  assert.ok(sprint.players.left.stamina < run.players.left.stamina);
  assert.ok(sprint.players.left.stamina < 1);
});

test("충전해서 찬 공이 오른쪽 골대로 들어가 왼쪽이 득점한다", () => {
  const m = playingMatch();
  m.players.right.y = 4;
  m.players.left.x = m.ball.x - 0.9;
  m.players.left.y = m.ball.y;
  press(m, "left", { kick: true }, 1);
  runFor(m, 700);
  press(m, "left", { kick: false }, 2);
  const kickEvents = runFor(m, 100);
  assert.ok(kickEvents.some((e) => e.kind === "kick"));
  assert.ok(m.ball.vx > 10, `ball vx=${m.ball.vx}`);

  const events = runFor(m, 6000);
  const goal = events.find((e) => e.kind === "goal");
  assert.ok(goal, "골 이벤트가 나와야 한다");
  assert.equal(goal.kind === "goal" ? goal.side : null, "left");
  assert.equal(m.score.left, 1);
  assert.notEqual(m.phase, "playing");
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
  assert.equal(m.players.left.x, PITCH.length * 0.3);
});

test("골문 밖 골라인에서는 공이 튕긴다", () => {
  const m = playingMatch();
  m.ball.x = 2;
  m.ball.y = 3;
  m.ball.vx = -12;
  runFor(m, 500);
  assert.equal(m.phase, "playing");
  assert.ok(m.ball.vx > 0, "공이 되튕겨 나와야 한다");
  assert.equal(m.score.right, 0);
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

test("스텝오버는 옆으로 치고 나가며 쿨다운과 스태미나를 쓴다", () => {
  const m = playingMatch();
  const startY = m.players.left.y;
  press(m, "left", { ax: 1, ay: 1, skill: "stepover" as SkillKind }, 1);
  const events = runFor(m, 60);
  assert.ok(events.some((e) => e.kind === "skill"));
  assert.equal(m.players.left.skill, "stepover");
  assert.ok(m.players.left.stepoverCdMs > 0);
  runFor(m, SKILL.stepover.durationMs);
  assert.equal(m.players.left.skill, null);
  assert.ok(Math.abs(m.players.left.y - startY) > 0.5, "옆으로 이동해야 한다");
  assert.ok(m.players.left.stamina <= 1 - STAMINA.stepoverCost + 0.05);
});

test("쿨다운 중에는 스텝오버가 다시 나가지 않는다", () => {
  const m = playingMatch();
  press(m, "left", { skill: "stepover" as SkillKind }, 1);
  runFor(m, SKILL.stepover.durationMs + 50);
  const cd = m.players.left.stepoverCdMs;
  assert.ok(cd > 0);
  press(m, "left", { skill: "stepover" as SkillKind }, 2);
  runFor(m, 30);
  assert.equal(m.players.left.skill, null);
});

test("가까운 상대에게 스텝오버를 걸면 상대가 흔들린다", () => {
  const m = playingMatch();
  m.players.right.x = m.players.left.x + 1.2;
  m.players.right.y = m.players.left.y;
  press(m, "left", { ax: 1, skill: "stepover" as SkillKind }, 1);
  const events = runFor(m, 40);
  const skill = events.find((e) => e.kind === "skill");
  assert.ok(skill && skill.kind === "skill" && skill.beat);
  assert.ok(m.players.right.staggerMs > 0);
});

test("슬라이딩은 공을 걷어내고 끝나면 잠시 못 움직인다", () => {
  const m = playingMatch();
  m.players.right.x = m.ball.x + 1.0;
  m.players.right.y = m.ball.y;
  m.players.right.facing = Math.PI;
  press(m, "right", { skill: "slide" as SkillKind }, 1);
  runFor(m, SKILL.slide.durationMs + 20);
  assert.ok(Math.hypot(m.ball.vx, m.ball.vy) > 5, "공이 튕겨 나가야 한다");
  assert.ok(m.players.right.proneMs > 0, "태클 후 일어나는 시간이 있어야 한다");
});

test("공 근처에서 움직이면 드리블 상태가 된다", () => {
  const m = playingMatch();
  m.players.left.x = m.ball.x - 0.8;
  m.players.left.y = m.ball.y;
  press(m, "left", { ax: 1 }, 1);
  runFor(m, 600);
  assert.equal(m.players.left.dribbling, true);
  const dist = Math.hypot(m.ball.x - m.players.left.x, m.ball.y - m.players.left.y);
  assert.ok(dist < 1.5, `드리블 중 거리 ${dist}`);
  assert.equal(m.snapshot(0).players[0]?.anim, "dribble");
});

test("선수와 공은 경기장 밖으로 나가지 않는다", () => {
  const m = playingMatch();
  press(m, "left", { ax: -1, ay: -1, sprint: true }, 1);
  runFor(m, 4000);
  assert.ok(m.players.left.x >= 0 && m.players.left.x <= PITCH.length);
  assert.ok(m.players.left.y >= 0 && m.players.left.y <= PITCH.width);
  assert.ok(m.ball.y >= 0 && m.ball.y <= PITCH.width);
});

test("스냅샷은 양쪽 선수와 점수를 담는다", () => {
  const m = playingMatch();
  const snap = m.snapshot(1234);
  assert.equal(snap.t, "snapshot");
  assert.equal(snap.ts, 1234);
  assert.equal(snap.players.length, 2);
  assert.deepEqual(
    snap.players.map((p) => p.side),
    ["left", "right"],
  );
  assert.deepEqual(snap.score, { left: 0, right: 0 });
  assert.ok(snap.players[0] && typeof snap.players[0].facing === "number");
});
