/**
 * 경기 기록 · 알림 회귀 테스트.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeEvent,
  FEED_MAX,
  FEED_TTL_MS,
  FeedQueue,
  goalCallout,
  soundFor,
  statRows,
  type DescribeContext,
} from "../src/game/feedback.ts";
import { SnapshotBuffer } from "../src/game/interpolation.ts";
import type { MatchStats, Snapshot } from "../src/net/protocol.ts";

const zero = { shots: 0, passes: 0, completedPasses: 0, possessionMs: 0 };

test("기록이 전부 0 이어도 0 나누기 없이 '–' 로 나온다", () => {
  const rows = statRows({ left: { ...zero }, right: { ...zero } });
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.leftShare, null);
    assert.ok(!/NaN|Infinity/.test(row.left + row.right));
  }
  assert.equal(rows[2]!.left, "–");
  assert.equal(rows[1]!.left, "0/0 · –");
});

test("슛·패스 성공률·점유율을 실제 값으로 비교한다", () => {
  const stats: MatchStats = {
    left: { shots: 3, passes: 8, completedPasses: 6, possessionMs: 30_000 },
    right: { shots: 1, passes: 0, completedPasses: 0, possessionMs: 10_000 },
  };
  const [shots, passes, possession] = statRows(stats);
  assert.equal(shots!.leftShare, 0.75);
  assert.equal(passes!.left, "6/8 · 75%");
  assert.equal(passes!.right, "0/0 · –");
  assert.equal(possession!.left, "75%");
  assert.equal(possession!.right, "25%");
});

test("점유율 두 쪽 합은 반올림해도 100%", () => {
  const [, , p] = statRows({
    left: { ...zero, possessionMs: 1 },
    right: { ...zero, possessionMs: 2 },
  });
  assert.equal(parseInt(p!.left) + parseInt(p!.right), 100);
});

test("기록이 없으면(구버전 서버) 빈 표", () => {
  assert.deepEqual(statRows(null), []);
});

function snapshot(tick: number, stats: MatchStats | undefined): Snapshot {
  const base = {
    t: "snapshot" as const,
    tick,
    ts: tick * 50,
    phase: "playing" as const,
    ball: { x: 0, y: 0, vx: 0, vy: 0, spin: 0, ownerId: null },
    players: [],
    score: { left: 0, right: 0 },
    timeLeftMs: 60_000,
    countdownMs: 0,
    controlled: { left: "L2", right: "R2" },
    passTarget: { left: null, right: null },
  };
  return (stats === undefined ? base : { ...base, stats }) as Snapshot;
}

test("보간 프레임의 기록은 섞지 않고 더 최신 스냅샷 값을 그대로 쓴다", () => {
  const buffer = new SnapshotBuffer();
  const a: MatchStats = { left: { ...zero, shots: 1 }, right: { ...zero } };
  const b: MatchStats = { left: { ...zero, shots: 2 }, right: { ...zero, possessionMs: 999 } };
  buffer.push(snapshot(10, a));
  buffer.push(snapshot(11, b));
  buffer.push(snapshot(12, b));
  const frame = buffer.sample(25);
  assert.ok(frame);
  // 섞었다면 shots 가 1.5, possessionMs 가 499.5 같은 값이 된다.
  assert.deepEqual(frame.stats, b);
});

test("stats 가 없는 옛 스냅샷이면 null(화면이 깨지지 않는다)", () => {
  const buffer = new SnapshotBuffer();
  buffer.push(snapshot(1, undefined));
  buffer.push(snapshot(2, undefined));
  const frame = buffer.sample(10);
  assert.ok(frame);
  assert.equal(frame.stats, null);
});

test("재접속으로 버퍼를 비우면 지난 기록이 남지 않는다", () => {
  const buffer = new SnapshotBuffer();
  buffer.push(snapshot(1, { left: { ...zero, shots: 9 }, right: { ...zero } }));
  buffer.reset();
  assert.equal(buffer.sample(16), null);
});

const ctx: DescribeContext = {
  mySide: "left",
  nicknames: { left: "나", right: "상대" },
  lookup: (id) =>
    ({
      L1: { side: "left", role: "defender", controlled: false },
      L2: { side: "left", role: "mid", controlled: true },
      R2: { side: "right", role: "mid", controlled: true },
      R3: { side: "right", role: "forward", controlled: false },
    })[id] ?? null,
} as DescribeContext;

test("슛은 누구든 띄우고 조작 선수는 닉네임, 속도는 시속으로", () => {
  const item = describeEvent({ t: "event", kind: "shoot", playerId: "R2", power: 25 }, ctx);
  assert.equal(item?.detail, "상대 · 시속 90km");
  assert.equal(item?.mine, false);
});

test("패스는 내 팀 것만, 개인기는 제쳤거나 사람이 쓴 것만", () => {
  assert.equal(describeEvent({ t: "event", kind: "pass", playerId: "R3", targetId: "R2" }, ctx), null);
  assert.equal(
    describeEvent({ t: "event", kind: "pass", playerId: "L2", targetId: "L1" }, ctx)?.detail,
    "나 → 수비",
  );
  assert.equal(
    describeEvent({ t: "event", kind: "skill", playerId: "R3", skill: "stepover", beat: false }, ctx),
    null,
  );
  assert.equal(
    describeEvent({ t: "event", kind: "skill", playerId: "R3", skill: "dragback", beat: true }, ctx)?.detail,
    "공격 · 상대를 제쳤다",
  );
});

test("자책골은 득점 팀 이름 + '자책골'", () => {
  const callout = goalCallout(
    { t: "event", kind: "goal", side: "right", scorerId: "L1", score: { left: 0, right: 1 } },
    ctx,
    1,
  );
  assert.equal(callout.scorer, "자책골");
  assert.equal(callout.teamName, "상대");
  assert.equal(callout.mine, false);
});

test("알림은 최대 개수·유지 시간·중복 억제를 지킨다", () => {
  const q = new FeedQueue();
  for (let i = 0; i < 5; i += 1) q.push({ tone: "shot", side: "left", mine: true, title: "슛", detail: String(i) }, i);
  assert.equal(q.list().length, FEED_MAX);
  assert.equal(q.push({ tone: "shot", side: "left", mine: true, title: "슛", detail: "4" }, 100), false);
  assert.equal(q.prune(FEED_TTL_MS + 10), true);
  assert.equal(q.list().length, 0);
});

test("효과음 매핑: 킥오프=휘슬, 종료=종료휘슬, 개인기는 무음", () => {
  assert.equal(soundFor({ t: "event", kind: "kickoff" })?.kind, "whistle");
  assert.equal(
    soundFor({ t: "event", kind: "matchEnd", result: "draw", score: { left: 0, right: 0 } })?.kind,
    "finalWhistle",
  );
  assert.equal(
    soundFor({ t: "event", kind: "skill", playerId: "L2", skill: "stepover", beat: true }),
    null,
  );
});
