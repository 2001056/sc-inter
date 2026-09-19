/**
 * AI 선수. 사람이 조작하지 않는 모든 선수(동료 2명, 연습 모드의 상대 팀 전원)를 움직인다.
 * 같은 시뮬레이션 안에서 "입력만" 만들어 내므로 사람과 똑같은 규칙을 따른다.
 *
 * 판단 순서
 * 1. 공을 가졌다: 슛 길이 열려 있으면 슛, 압박받거나 더 좋은 자리의 동료가 있으면 패스,
 *    앞이 막히면 개인기, 아니면 빈 쪽으로 몰고 간다. 패스 대상은 상대가 끊을 수 있는
 *    길(pass lane)과 받는 동료 주변의 여유를 함께 따진다.
 * 2. 우리 팀 패스가 나에게 오고 있다: 공이 굴러가는 궤적에서 먼저 닿을 수 있는 지점으로 받으러 간다.
 * 3. 동료가 공을 가졌다: 역할별 후보 자리(앞·옆·뒤) 중 상대와 멀고 패스 길이 열린 곳을 고른다.
 * 4. 상대 공이거나 흐른 공: 가장 빨리 닿는 한 명만 압박하고, 나머지는 골문을 막거나 위험한 상대를 붙잡는다.
 */
import {
  BALL,
  DRIBBLE,
  GOAL_BOTTOM,
  GOAL_TOP,
  PASS,
  PITCH,
  PLAYER,
  SKILL,
  STAMINA,
  attackDirX,
  attackGoalX,
  ownGoalX,
  type Role,
  type Side,
} from "./constants.ts";
import { neutralInput } from "./sim.ts";
import type { Match, Player } from "./sim.ts";
import type { InputState } from "../protocol.ts";

const TICK_MS = 1000 / 60;
/** 이 거리(골대 중앙까지) 안이면 슛을 노린다 */
const SHOOT_RANGE = 17;
/** 슛 길이 막혀 있어도 이 거리 안이면 그냥 찬다 */
const POINT_BLANK = 8;
/** 이 거리 안에 상대가 있으면 압박받는 것으로 본다 */
const PRESS_RANGE = 3.2;
/** 슛 충전 시간과 떼고 기다리는 시간 */
const AI_CHARGE_MS = 420;
const AI_CHARGE_CYCLE_MS = 620;
/** 지원 위치를 다시 고르는 간격 */
const RETARGET_MS = 400;
/** 압박 담당을 바꾸려면 새 후보가 이만큼(초) 더 빨리 닿아야 한다 */
const PRESSER_HYSTERESIS_S = 0.35;
/** 패스 대상으로 보는 거리 범위 */
const PASS_MIN_DIST = 5;
const PASS_MAX_DIST = 24;

interface Pt {
  x: number;
  y: number;
}

function unit(x: number, y: number): Pt {
  const d = Math.hypot(x, y);
  if (d < 1e-6) return { x: 0, y: 0 };
  return { x: x / d, y: y / d };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function inPitch(x: number, y: number, margin: number): Pt {
  return {
    x: clamp(x, margin, PITCH.length - margin),
    y: clamp(y, margin, PITCH.width - margin),
  };
}

function towards(p: Pt, tx: number, ty: number): Pt {
  return unit(tx - p.x, ty - p.y);
}

function opponents(match: Match, side: Side): Player[] {
  return match.players.filter((o) => o.side !== side);
}

/** 가장 가까운 상대까지의 거리(여유 공간) */
function openness(pt: Pt, opps: readonly Player[]): number {
  let best = Infinity;
  for (const o of opps) best = Math.min(best, dist(pt, o));
  return best;
}

/**
 * 공이 from → to 로 굴러갈 때 상대가 끊을 수 있는지.
 * 상대가 길에 수직으로 떨어진 거리에서, 공이 거기까지 가는 동안 상대가 좁힐 수 있는 거리를 뺀 값이다.
 * 가장 작은 값을 돌려주며 0 보다 작으면 막힌 길로 본다.
 */
export function laneMargin(from: Pt, to: Pt, opps: readonly Player[]): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return Infinity;
  const ux = dx / length;
  const uy = dy / length;
  let margin = Infinity;
  for (const o of opps) {
    const ox = o.x - from.x;
    const oy = o.y - from.y;
    const along = ox * ux + oy * uy;
    // 차는 선수 뒤쪽이나 받는 자리를 한참 지난 상대는 길을 막지 못한다
    if (along < 0.3 || along > length + 1) continue;
    const perp = Math.abs(ox * uy - oy * ux);
    const reach = PLAYER.radius + 0.5 + along * 0.1;
    margin = Math.min(margin, perp - reach);
  }
  return margin;
}

/** 잔디 항력만 반영한 t 초 뒤 공의 위치(벽 반사는 무시하고 경기장 안으로 자른다) */
export function ballAt(match: Match, t: number): Pt {
  const k = BALL.drag;
  const f = (1 - Math.exp(-k * t)) / k;
  const b = match.ball;
  return inPitch(b.x + b.vx * f, b.y + b.vy * f, 0.5);
}

/**
 * 굴러가는 공을 가장 먼저 잡을 수 있는 지점과 시각.
 * 공 궤적을 0.1초 간격으로 따라가며 달려서 먼저 닿는 첫 지점을 고른다.
 */
export function interceptOf(match: Match, p: Player): { at: Pt; t: number } {
  const b = match.ball;
  const owner = b.ownerId ? match.byId.get(b.ownerId) : undefined;
  if (owner && owner.id !== p.id) {
    // 누가 몰고 있는 공은 굴러가지 않고 그 선수를 따라간다. 짧게(최대 0.6초) 앞을 내다본다.
    const d = dist(p, owner);
    const lead = Math.min(0.6, d / PLAYER.sprintSpeed);
    const at = inPitch(owner.x + owner.vx * lead, owner.y + owner.vy * lead, 0.5);
    return { at, t: dist(p, at) / PLAYER.runSpeed };
  }
  if (Math.hypot(b.vx, b.vy) < 1) {
    return { at: { x: b.x, y: b.y }, t: dist(p, b) / PLAYER.runSpeed };
  }
  const speed = p.stamina > STAMINA.sprintFloor + 0.1 ? PLAYER.sprintSpeed : PLAYER.runSpeed;
  for (let t = 0; t <= 2.5; t += 0.1) {
    const at = ballAt(match, t);
    const need = Math.max(0, dist(p, at) - DRIBBLE.range * 0.5) / speed + 0.15;
    if (need <= t) return { at, t };
  }
  const at = ballAt(match, 2.5);
  return { at, t: 2.5 + dist(p, at) / speed };
}

// ---------------------------------------------------------------------------
// 팀 단위 기억: 누가 압박을 맡는지 (틱마다 뒤집히지 않게 유지)
// ---------------------------------------------------------------------------

const pressers = new WeakMap<Match, Record<Side, { id: string | null; tick: number }>>();

/** 이 팀에서 공으로 달려갈 단 한 명. 사람이 조작 중인 선수도 후보에 넣는다. */
export function presserFor(match: Match, side: Side): Player | null {
  let memo = pressers.get(match);
  if (!memo) {
    memo = { left: { id: null, tick: -1 }, right: { id: null, tick: -1 } };
    pressers.set(match, memo);
  }
  const slot = memo[side];
  if (slot.tick === match.tick) return slot.id ? (match.byId.get(slot.id) ?? null) : null;

  let best: Player | null = null;
  let bestT = Infinity;
  let currentT = Infinity;
  for (const p of match.team(side)) {
    if (p.proneMs > 0) continue;
    const t = interceptOf(match, p).t;
    if (p.id === slot.id) currentT = t;
    if (t < bestT) {
      bestT = t;
      best = p;
    }
  }
  // 지금 압박 중인 선수가 크게 뒤지지 않으면 그대로 둔다(둘이 번갈아 뛰쳐나가는 것 방지)
  if (slot.id !== null && currentT < Infinity && currentT - bestT < PRESSER_HYSTERESIS_S) {
    best = match.byId.get(slot.id) ?? best;
  }
  slot.id = best?.id ?? null;
  slot.tick = match.tick;
  return best;
}

// ---------------------------------------------------------------------------
// 공을 가진 선수
// ---------------------------------------------------------------------------

interface PassOption {
  mate: Player;
  score: number;
  lane: number;
  open: number;
  progress: number;
}

/** 패스할 동료를 고른다. 막힌 길은 빼고, 앞으로 나아가며 여유 있는 동료를 선호한다. */
export function choosePass(match: Match, p: Player): PassOption | null {
  const opps = opponents(match, p.side);
  const dir = attackDirX(p.side);
  let best: PassOption | null = null;
  for (const mate of match.team(p.side)) {
    if (mate.id === p.id || mate.proneMs > 0) continue;
    const lead = { x: mate.x + mate.vx * PASS.leadSeconds, y: mate.y + mate.vy * PASS.leadSeconds };
    const d = dist(p, lead);
    if (d < PASS_MIN_DIST || d > PASS_MAX_DIST) continue;
    const lane = laneMargin(p, lead, opps);
    if (lane < 0) continue;
    // 실제 패스 판정(바라보는 방향 기준)이 이 동료를 고르는지 확인한다
    const aim = Math.atan2(lead.y - p.y, lead.x - p.x);
    if (match.passTargetFor(p, aim)?.id !== mate.id) continue;
    const open = Math.min(openness(lead, opps), 8);
    const progress = (lead.x - p.x) * dir;
    const score = progress * 0.35 + open * 0.6 + Math.min(lane, 3) * 0.8 - d * 0.05;
    if (!best || score > best.score) best = { mate, score, lane, open, progress };
  }
  return best;
}

/** 골문 안쪽 세 지점 중 슛 길이 가장 열린 곳 */
function bestShotAim(match: Match, p: Player): { y: number; lane: number } {
  const goalX = attackGoalX(p.side);
  const opps = opponents(match, p.side);
  let best = { y: PITCH.width / 2, lane: -Infinity };
  for (const y of [GOAL_TOP + 0.8, PITCH.width / 2, GOAL_BOTTOM - 0.8]) {
    const lane = laneMargin(p, { x: goalX, y }, opps);
    if (lane > best.lane) best = { y, lane };
  }
  return best;
}

function inKickReach(match: Match, p: Player): boolean {
  return dist(p, match.ball) <= PLAYER.radius + BALL.radius + PASS.reach;
}

function carrierInput(match: Match, p: Player, input: InputState): InputState {
  const goalX = attackGoalX(p.side);
  const midY = PITCH.width / 2;
  const opps = opponents(match, p.side);
  const distToGoal = Math.hypot(goalX - p.x, midY - p.y);
  const nearestOpp = openness(p, opps);
  const pressured = nearestOpp < PRESS_RANGE;

  // 1) 슛 충전 중이면 정한 조준점을 끝까지 유지한다
  if (p.aiChargeMs > 0 || distToGoal < SHOOT_RANGE) {
    if (p.aiChargeMs === 0) {
      const shot = bestShotAim(match, p);
      const option = choosePass(match, p);
      const mateCloser =
        option !== null &&
        Math.hypot(goalX - option.mate.x, midY - option.mate.y) < distToGoal - 4 &&
        option.open > 3;
      // 길이 막혔고 더 좋은 자리의 동료가 있으면 슛 대신 내준다
      if (shot.lane < 0 && distToGoal > POINT_BLANK && mateCloser && option) {
        return passTo(match, p, option.mate, input);
      }
      p.aiAimY = shot.y + p.aiNoise * 0.25;
    }
    const aim = towards(p, goalX, p.aiAimY);
    input.ax = aim.x;
    input.ay = aim.y;
    p.aiChargeMs += TICK_MS;
    input.shoot = p.aiChargeMs < AI_CHARGE_MS;
    if (p.aiChargeMs > AI_CHARGE_CYCLE_MS) p.aiChargeMs = 0;
    return input;
  }

  // 2) 압박받으면 열린 동료에게, 없으면 앞을 막은 상대를 개인기로 벗긴다
  const option = choosePass(match, p);
  // 받는 동료가 나보다 여유가 있을 때만 내준다(압박을 옆으로 옮기기만 하는 패스 방지)
  if (pressured && option && option.open > nearestOpp + 1) return passTo(match, p, option.mate, input);

  const dir = attackDirX(p.side);
  const blocker = opps.find((o) => {
    const ox = (o.x - p.x) * dir;
    return ox > 0 && dist(p, o) < 2.5 && Math.abs(o.y - p.y) < 1.6;
  });
  if (blocker && p.skillCdMs === 0 && p.stamina > 0.3 && !p.busy) {
    // 상대가 서 있는 쪽의 반대편으로 흔들고 빠진다(월드 좌표 방향)
    const sideways = blocker.y >= p.y ? -1 : 1;
    input.skillDir = { x: 0, y: sideways };
  }

  // 3) 여유가 있어도 확실히 더 좋은 자리의 동료가 있으면 전진 패스
  if (option && option.progress > 8 && option.open > 4 && option.lane > 1 && nearestOpp < 6) {
    return passTo(match, p, option.mate, input);
  }

  // 4) 몰고 간다: 골문 쪽으로 가되 앞에 있는 상대를 피해 빈 쪽으로 튼다
  let tx = goalX - p.x;
  let ty = clamp(midY + p.aiNoise, 3, PITCH.width - 3) - p.y;
  const base = unit(tx, ty);
  tx = base.x;
  ty = base.y;
  for (const o of opps) {
    const d = dist(p, o);
    if (d > 6) continue;
    const ahead = ((o.x - p.x) * base.x + (o.y - p.y) * base.y) / (d || 1);
    if (ahead < 0.2) continue;
    const away = unit(p.x - o.x, p.y - o.y);
    const w = (6 - d) / 6;
    tx += away.x * w * 1.2;
    ty += away.y * w * 1.2;
  }
  const aim = unit(tx, ty);
  input.ax = aim.x;
  input.ay = aim.y;
  input.sprint = p.stamina > 0.45 && !pressured;
  return input;
}

/** 동료가 서 있을(내다본) 자리를 바라보며 패스 버튼을 누른다. 공이 발에 닿을 때만 누른다. */
function passTo(match: Match, p: Player, mate: Player, input: InputState): InputState {
  const tx = mate.x + mate.vx * PASS.leadSeconds;
  const ty = mate.y + mate.vy * PASS.leadSeconds;
  const aim = towards(p, tx, ty);
  input.ax = aim.x;
  input.ay = aim.y;
  input.pass = inKickReach(match, p) && p.passCdMs === 0;
  p.aiChargeMs = 0;
  return input;
}

// ---------------------------------------------------------------------------
// 공이 없는 선수
// ---------------------------------------------------------------------------

/** 역할별 지원 후보: 공 가진 동료 기준 (앞으로 몇 m, 옆으로 몇 m) */
const SUPPORT_SPOTS: Record<Role, ReadonlyArray<readonly [number, number]>> = {
  forward: [
    [7, -7],
    [8, -3],
    [9, 0],
    [8, 3],
    [7, 7],
  ],
  mid: [
    [2, -8],
    [0, -10],
    [3, -5],
    [2, 8],
    [0, 10],
    [3, 5],
  ],
  defender: [
    [-7, -4],
    [-7, 0],
    [-7, 4],
    [-5, -7],
    [-5, 7],
  ],
};

function supportTarget(match: Match, p: Player, carrier: Player): Pt {
  const dir = attackDirX(p.side);
  const opps = opponents(match, p.side);
  const others = match.team(p.side).filter((m) => m.id !== p.id && m.id !== carrier.id);

  const scoreOf = (spot: Pt): number => {
    const open = Math.min(openness(spot, opps), 7);
    const lane = Math.min(laneMargin(carrier, spot, opps), 3);
    let crowd = 0;
    if (dist(spot, carrier) < 5) crowd += 3;
    for (const m of others) {
      const theirs = m.aiHasTarget ? { x: m.aiTargetX, y: m.aiTargetY } : m;
      if (dist(spot, theirs) < 6) crowd += 3;
    }
    return open + lane * 1.2 - dist(p, spot) * 0.08 - crowd;
  };

  const current = p.aiHasTarget ? { x: p.aiTargetX, y: p.aiTargetY } : null;
  p.aiRetargetMs -= TICK_MS;
  if (current && p.aiRetargetMs > 0) return current;
  p.aiRetargetMs = RETARGET_MS;

  let best: Pt | null = null;
  let bestScore = -Infinity;
  for (const [ahead, lateral] of SUPPORT_SPOTS[p.role]) {
    const spot = inPitch(carrier.x + ahead * dir, carrier.y + lateral, 2.5);
    // 상대 골라인 바로 앞에 붙지 않는다
    spot.x = clamp(spot.x, 4, PITCH.length - 4);
    const s = scoreOf(spot);
    if (s > bestScore) {
      bestScore = s;
      best = spot;
    }
  }
  // 조금 나아진 정도면 자리를 바꾸지 않는다(떨림 방지). 옛 자리는 공을 따라 옮겨 다시 잰다.
  if (current && best) {
    const shifted = inPitch(current.x, current.y, 2.5);
    if (scoreOf(shifted) >= bestScore - 0.8 && dist(shifted, carrier) > 4) best = shifted;
  }
  const target = best ?? { x: p.x, y: p.y };
  p.aiTargetX = target.x;
  p.aiTargetY = target.y;
  p.aiHasTarget = true;
  return target;
}

function moveTo(p: Player, target: Pt, input: InputState, sprintOver: number): InputState {
  const d = dist(p, target);
  if (d < 0.4) return input;
  const aim = towards(p, target.x, target.y);
  // 목표에 가까우면 천천히 들어가 제자리에서 흔들리지 않게 한다
  const scale = d < 1.5 ? d / 1.5 : 1;
  input.ax = aim.x * scale;
  input.ay = aim.y * scale;
  input.sprint = p.stamina > 0.5 && d > sprintOver;
  return input;
}

/** 우리 골문 앞에서 공과 골대 사이를 막는 자리 */
function goalCoverSpot(match: Match, side: Side, depthScale: number): Pt {
  const gx = ownGoalX(side);
  const gy = PITCH.width / 2;
  const b = match.ball;
  const toBall = dist({ x: gx, y: gy }, b);
  const u = unit(b.x - gx, b.y - gy);
  const d = clamp(toBall * depthScale, 3, 15);
  return inPitch(gx + u.x * d, gy + u.y * d, 1.5);
}

/** 공을 갖지 않은 상대 중 우리 골문에 가장 위협적인 선수 */
function mostDangerous(match: Match, side: Side, excludeId: string | null): Player | null {
  const gx = ownGoalX(side);
  const gy = PITCH.width / 2;
  let best: Player | null = null;
  let bestScore = Infinity;
  for (const o of opponents(match, side)) {
    if (o.id === excludeId) continue;
    const score = Math.hypot(o.x - gx, o.y - gy) + dist(o, match.ball) * 0.3;
    if (score < bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best;
}

function defendInput(match: Match, p: Player, input: InputState, owner: Player | null): InputState {
  const presser = presserFor(match, p.side);
  const ball = match.ball;
  const gx = ownGoalX(p.side);
  const gy = PITCH.width / 2;

  if (presser?.id === p.id) {
    // 압박: 상대가 몰고 있으면 골문 쪽 앞을 막아서고, 흐른 공이면 궤적에서 먼저 닿는 곳으로
    let target: Pt;
    if (owner && owner.side !== p.side) {
      const guard = unit(gx - owner.x, gy - owner.y);
      const close = dist(p, owner) < 2.2;
      target = close ? { x: ball.x, y: ball.y } : { x: owner.x + guard.x * 0.9, y: owner.y + guard.y * 0.9 };
    } else {
      target = interceptOf(match, p).at;
    }
    const aim = towards(p, target.x, target.y);
    input.ax = aim.x;
    input.ay = aim.y;
    const ballDist = dist(p, ball);
    input.sprint = p.stamina > 0.35 && ballDist > 3;
    if (owner && owner.side !== p.side && p.tackleCdMs === 0 && ballDist < SKILL.tackle.reach + DRIBBLE.range) {
      // 태클은 바라보는 방향으로 나가므로 공 쪽을 보고 있을 때만 건다
      const face = unit(ball.x - p.x, ball.y - p.y);
      const facing = Math.cos(p.facing) * face.x + Math.sin(p.facing) * face.y;
      if (facing > 0.6 || ballDist < 1) input.tackle = true;
    }
    return input;
  }

  // 압박하지 않는 AI 들: 골문 쪽에 더 가까운 한 명은 골문을 막고, 다른 한 명은 위협적인 상대를 붙잡는다
  const helpers = match
    .team(p.side)
    .filter((m) => m.id !== presser?.id && !(match.humanSides[p.side] && match.controlled[p.side] === m.id));
  helpers.sort((a, b) => {
    const bias = (m: Player): number => (m.role === "defender" ? -4 : 0);
    return Math.hypot(a.x - gx, a.y - gy) + bias(a) - (Math.hypot(b.x - gx, b.y - gy) + bias(b));
  });
  const isCover = helpers[0]?.id === p.id || helpers.length < 2;

  if (isCover) {
    const depth = p.role === "defender" ? 0.4 : 0.5;
    const spot = goalCoverSpot(match, p.side, depth);
    spot.y += p.aiNoise * 0.3;
    return moveTo(p, spot, input, 8);
  }

  // 공 가진(또는 공에 가장 가까운) 상대는 압박 담당 몫이다. 마크는 그 밖의 상대 중에서 고른다.
  const ballSideOpp =
    owner && owner.side !== p.side
      ? owner
      : opponents(match, p.side).reduce<Player | null>(
          (a, o) => (a === null || dist(o, ball) < dist(a, ball) ? o : a),
          null,
        );
  const mark = mostDangerous(match, p.side, ballSideOpp?.id ?? null);
  if (!mark) return moveTo(p, goalCoverSpot(match, p.side, 0.6), input, 8);
  // 상대와 우리 골문 사이, 공 쪽으로 조금 치우친 자리(패스 길과 슛 길을 함께 막는다)
  const toGoal = unit(gx - mark.x, gy - mark.y);
  const toBall = unit(ball.x - mark.x, ball.y - mark.y);
  const spot = inPitch(mark.x + toGoal.x * 1.1 + toBall.x * 0.9, mark.y + toGoal.y * 1.1 + toBall.y * 0.9, 1);
  // 움직이는 상대를 따라붙어야 하므로 조금만 벌어져도 달린다
  return moveTo(p, spot, input, 3);
}

export function aiInput(match: Match, p: Player): InputState {
  const input = neutralInput();
  input.seq = match.tick;
  if (match.phase !== "playing" || p.proneMs > 0) return input;

  p.aiTimerMs += TICK_MS;
  if (p.aiTimerMs > 400) {
    p.aiTimerMs = 0;
    p.aiNoise = (Math.random() - 0.5) * 3;
  }

  const owner = match.ball.ownerId ? (match.byId.get(match.ball.ownerId) ?? null) : null;

  const pending = match.pendingPass;
  // 방금 패스를 준 선수는 공이 발에서 빠져나가기 전에 다시 잡지 않도록, 받는 동료 기준 지원 자리로 뛰어 나간다
  if (pending !== null && pending.passerId === p.id && (owner === null || owner.id === p.id)) {
    p.aiChargeMs = 0;
    const receiver = match.byId.get(pending.targetId);
    if (receiver) return moveTo(p, supportTarget(match, p, receiver), input, 7);
  }

  // 1) 내가 공을 잡았다
  if (owner?.id === p.id) return carrierInput(match, p, input);
  p.aiChargeMs = 0;

  // 2) 우리 팀 패스가 나에게 오고 있다 — 공 궤적에서 먼저 닿는 곳으로 받으러 간다
  if ((owner === null || owner.id === pending?.passerId) && pending !== null && pending.side === p.side) {
    if (pending.targetId === p.id) {
      const { at } = interceptOf(match, p);
      const aim = towards(p, at.x, at.y);
      const d = dist(p, at);
      if (d > 0.3) {
        input.ax = aim.x;
        input.ay = aim.y;
      } else {
        // 도착했으면 공 쪽으로 살짝 다가가 소유(움직이는 중이어야 잡힌다)
        const toBall = towards(p, match.ball.x, match.ball.y);
        input.ax = toBall.x * 0.5;
        input.ay = toBall.y * 0.5;
      }
      input.sprint = p.stamina > 0.3 && d > 3;
      return input;
    }
    // 받는 동료를 기준으로 다음 지원 자리를 미리 잡는다
    const receiver = match.byId.get(pending.targetId);
    if (receiver) return moveTo(p, supportTarget(match, p, receiver), input, 7);
  }

  // 3) 동료가 공을 가졌다 — 빈 공간으로 벌려 준다
  if (owner !== null && owner.side === p.side) {
    return moveTo(p, supportTarget(match, p, owner), input, 7);
  }
  p.aiHasTarget = false;

  // 4) 상대 공이거나 흐른 공
  return defendInput(match, p, input, owner);
}

/** 테스트와 문서에서 쓰는 판단 상수 */
export const AI_TUNING = {
  shootRange: SHOOT_RANGE,
  pointBlank: POINT_BLANK,
  pressRange: PRESS_RANGE,
  chargeMs: AI_CHARGE_MS,
  retargetMs: RETARGET_MS,
  passMinDist: PASS_MIN_DIST,
  passMaxDist: PASS_MAX_DIST,
} as const;
