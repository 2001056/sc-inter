/**
 * AI 선수. 사람이 조작하지 않는 모든 선수(동료 2명, 연습 모드의 상대 팀 전원)를 움직인다.
 * 같은 시뮬레이션 안에서 "입력만" 만들어 내므로 사람과 똑같은 규칙을 따른다.
 */
import {
  DRIBBLE,
  PITCH,
  SKILL,
  attackGoalX,
  ownGoalX,
  type Role,
  type Side,
} from "./constants.ts";
import { neutralInput } from "./sim.ts";
import type { Match, Player } from "./sim.ts";
import type { InputState } from "../protocol.ts";

/** 역할별로 공에서 얼마나 떨어져 서 있을지 */
const SUPPORT: Record<Role, { ahead: number; spread: number; depth: number }> = {
  forward: { ahead: 7, spread: 6, depth: 0.62 },
  mid: { ahead: 1, spread: 8, depth: 0.45 },
  defender: { ahead: -7, spread: 3, depth: 0.28 },
};

const SHOOT_RANGE = 17;
const PRESS_RANGE = 3.2;

function unit(x: number, y: number): { x: number; y: number } {
  const d = Math.hypot(x, y);
  if (d < 1e-6) return { x: 0, y: 0 };
  return { x: x / d, y: y / d };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 같은 팀에서 공에 가장 가까운 선수 */
function nearestTeammateToBall(match: Match, side: Side): Player | null {
  let best: Player | null = null;
  let bestDist = Infinity;
  for (const p of match.team(side)) {
    if (p.proneMs > 0) continue;
    const d = Math.hypot(match.ball.x - p.x, match.ball.y - p.y);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

function towards(p: Player, tx: number, ty: number): { x: number; y: number } {
  return unit(tx - p.x, ty - p.y);
}

export function aiInput(match: Match, p: Player): InputState {
  const input = neutralInput();
  input.seq = match.tick;
  if (match.phase !== "playing" || p.proneMs > 0) return input;

  p.aiTimerMs += 1000 / 60;
  if (p.aiTimerMs > 400) {
    p.aiTimerMs = 0;
    p.aiNoise = (Math.random() - 0.5) * 3;
  }

  const ball = match.ball;
  const goalX = attackGoalX(p.side);
  const homeX = ownGoalX(p.side);
  const midY = PITCH.width / 2;
  const owner = ball.ownerId ? (match.byId.get(ball.ownerId) ?? null) : null;
  const iHaveBall = owner?.id === p.id;
  const teamHasBall = owner !== null && owner.side === p.side;

  // 1) 내가 공을 잡았다
  if (iHaveBall) {
    const distToGoal = Math.hypot(goalX - p.x, midY - p.y);
    const pressure = match.players.some(
      (o) => o.side !== p.side && Math.hypot(o.x - p.x, o.y - p.y) < PRESS_RANGE,
    );

    if (distToGoal < SHOOT_RANGE) {
      // 골대를 보고 충전해서 찬다
      const aim = towards(p, goalX, midY + p.aiNoise * 0.4);
      input.ax = aim.x;
      input.ay = aim.y;
      p.aiChargeMs += 1000 / 60;
      input.shoot = p.aiChargeMs < 420;
      if (p.aiChargeMs > 620) p.aiChargeMs = 0;
      return input;
    }
    p.aiChargeMs = 0;

    if (pressure) {
      const mate = match.passTargetFor(p);
      if (mate) {
        const aim = towards(p, mate.x, mate.y);
        input.ax = aim.x;
        input.ay = aim.y;
        input.pass = true;
        return input;
      }
    }

    const aim = towards(p, goalX, clamp(midY + p.aiNoise, 3, PITCH.width - 3));
    input.ax = aim.x;
    input.ay = aim.y;
    input.sprint = p.stamina > 0.45 && !pressure;
    return input;
  }

  p.aiChargeMs = 0;

  // 2) 동료가 공을 가졌다 — 공간을 만들어 준다
  if (teamHasBall) {
    const spec = SUPPORT[p.role];
    const dir = p.side === "left" ? 1 : -1;
    const tx = clamp(ball.x + spec.ahead * dir, 3, PITCH.length - 3);
    const side = p.y >= midY ? 1 : -1;
    const ty = clamp(ball.y + spec.spread * side + p.aiNoise, 3, PITCH.width - 3);
    const aim = towards(p, tx, ty);
    input.ax = aim.x;
    input.ay = aim.y;
    input.sprint = p.stamina > 0.5 && Math.hypot(tx - p.x, ty - p.y) > 8;
    return input;
  }

  // 3) 상대가 가졌거나 흐른 공 — 가장 가까운 선수가 쫓고 나머지는 자리를 지킨다
  const chaser = nearestTeammateToBall(match, p.side);
  const ballDist = Math.hypot(ball.x - p.x, ball.y - p.y);
  if (chaser?.id === p.id) {
    const aim = towards(p, ball.x, ball.y);
    input.ax = aim.x;
    input.ay = aim.y;
    input.sprint = p.stamina > 0.35 && ballDist > 3;
    // 상대가 몰고 있고 발이 닿을 거리면 태클
    if (
      owner !== null &&
      owner.side !== p.side &&
      ballDist < SKILL.tackle.reach + DRIBBLE.range &&
      p.tackleCdMs === 0
    ) {
      input.tackle = true;
    }
    return input;
  }

  const spec = SUPPORT[p.role];
  const coverX = homeX + (ball.x - homeX) * spec.depth;
  const coverY = midY + (ball.y - midY) * 0.6 + p.aiNoise * 0.5;
  const aim = towards(p, coverX, clamp(coverY, 2, PITCH.width - 2));
  input.ax = aim.x;
  input.ay = aim.y;
  input.sprint = p.stamina > 0.5 && Math.hypot(coverX - p.x, coverY - p.y) > 9;
  return input;
}
