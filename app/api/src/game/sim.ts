/**
 * 권위 시뮬레이션(3대3). 순수 로직만 담고 네트워크는 모른다.
 * 같은 입력 순서를 주면 같은 결과가 나오므로 테스트에서 그대로 검증한다.
 */
import {
  BALL,
  DRIBBLE,
  GOAL_BOTTOM,
  GOAL_TOP,
  MATCH,
  PASS,
  PITCH,
  PLAYER,
  ROLES,
  SHOOT,
  SKILL,
  STAMINA,
  attackDirX,
  spawnFor,
  type Role,
  type Side,
} from "./constants.ts";
import { aiInput } from "./ai.ts";
import type {
  AnimState,
  BallView,
  InputState,
  MatchResult,
  MatchStats,
  Phase,
  PlayerView,
  Score,
  SkillKind,
  Snapshot,
  TeamStats,
} from "../protocol.ts";

export type SimEvent =
  | { kind: "kickoff" }
  | { kind: "goal"; side: Side; scorerId: string; score: Score }
  | { kind: "matchEnd"; result: MatchResult; score: Score }
  | { kind: "shoot"; playerId: string; power: number }
  | { kind: "pass"; playerId: string; targetId: string | null }
  | { kind: "skill"; playerId: string; skill: SkillKind; beat: boolean }
  | { kind: "control"; side: Side; playerId: string };

export const NEUTRAL_INPUT: InputState = {
  seq: 0,
  ax: 0,
  ay: 0,
  sprint: false,
  shoot: false,
  pass: false,
  tackle: false,
  skillDir: null,
  switchPlayer: false,
};

export function neutralInput(): InputState {
  return { ...NEUTRAL_INPUT };
}

function emptyTeamStats(): TeamStats {
  return { shots: 0, passes: 0, completedPasses: 0, possessionMs: 0 };
}

export function emptyStats(): MatchStats {
  return { left: emptyTeamStats(), right: emptyTeamStats() };
}

/** 성공 여부를 아직 모르는 패스. 받을 동료가 처음 공을 소유하면 완료로 센다. */
export interface PendingPass {
  side: Side;
  passerId: string;
  targetId: string;
  msLeft: number;
}

export class Player {
  readonly id: string;
  readonly side: Side;
  readonly role: Role;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  facing: number;
  stamina = 1;
  sprinting = false;
  chargeMs = 0;
  shootCdMs = 0;
  passCdMs = 0;
  /** 슛·패스 모션을 잠깐 보여주기 위한 타이머 */
  actionAnim: "shoot" | "pass" | null = null;
  actionAnimMs = 0;
  skill: SkillKind | null = null;
  skillMs = 0;
  skillDirX = 0;
  skillDirY = 0;
  skillCdMs = 0;
  tackleCdMs = 0;
  tacklePoked = false;
  proneMs = 0;
  staggerMs = 0;
  dribbling = false;
  celebrating = false;
  input: InputState = neutralInput();
  lastSeq = -1;
  prevShoot = false;
  /** AI 가 쓰는 짧은 기억 */
  aiTimerMs = 0;
  aiNoise = 0;
  aiChargeMs = 0;
  /** 슛을 충전하는 동안 고정해 두는 조준점(y) */
  aiAimY = 0;
  /** 지원 위치를 다시 고를 때까지 남은 시간과 지금 목표 */
  aiRetargetMs = 0;
  aiTargetX = 0;
  aiTargetY = 0;
  aiHasTarget = false;

  constructor(id: string, side: Side, role: Role) {
    this.id = id;
    this.side = side;
    this.role = role;
    this.facing = side === "left" ? 0 : Math.PI;
    const spawn = spawnFor(side, role);
    this.x = spawn.x;
    this.y = spawn.y;
  }

  resetToSpawn(): void {
    const spawn = spawnFor(this.side, this.role);
    this.x = spawn.x;
    this.y = spawn.y;
    this.vx = 0;
    this.vy = 0;
    this.facing = this.side === "left" ? 0 : Math.PI;
    this.chargeMs = 0;
    this.shootCdMs = 0;
    this.passCdMs = 0;
    this.actionAnim = null;
    this.actionAnimMs = 0;
    this.skill = null;
    this.skillMs = 0;
    this.proneMs = 0;
    this.staggerMs = 0;
    this.dribbling = false;
    this.prevShoot = false;
    this.celebrating = false;
    this.input = neutralInput();
    this.aiChargeMs = 0;
    this.aiRetargetMs = 0;
    this.aiHasTarget = false;
  }

  get busy(): boolean {
    return this.skill !== null || this.proneMs > 0;
  }
}

function len(x: number, y: number): number {
  return Math.hypot(x, y);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** 사람이 지금 무언가를 누르고 있는지 */
function isActiveInput(input: InputState): boolean {
  return (
    Math.hypot(input.ax, input.ay) > 0.05 ||
    input.sprint ||
    input.shoot ||
    input.pass ||
    input.tackle ||
    input.skillDir !== null
  );
}

/** 이 거리보다 공에 가까우면 조작 선수를 바꾸지 않는다(미터) */
const CONTROL_HANDOVER_DISTANCE = 6;

export class Match {
  phase: Phase = "waiting";
  tick = 0;
  score: Score = { left: 0, right: 0 };
  timeLeftMs: number = MATCH.durationMs;
  countdownMs = 0;
  celebrationMs = 0;
  result: MatchResult | null = null;

  readonly players: Player[] = [];
  readonly byId = new Map<string, Player>();
  /** 팀마다 사람이 조작 중인 선수. 사람이 없으면 AI 가 그 선수도 맡는다. */
  controlled: Record<Side, string>;
  /** 그 팀에 사람이 앉아 있는지 */
  humanSides: Record<Side, boolean> = { left: false, right: false };

  ball: BallView = {
    x: PITCH.length / 2,
    y: PITCH.width / 2,
    vx: 0,
    vy: 0,
    spin: 0,
    ownerId: null,
  };
  lastToucherId: string | null = null;
  /** 팀별 경기 기록(서버 권위). 재경기(startMatch)에서만 초기화된다. */
  stats: MatchStats = emptyStats();
  /** 지금 굴러가는 중인, 받을 동료가 정해진 패스. AI 수신자도 이것을 보고 받으러 간다. */
  pendingPass: PendingPass | null = null;

  private switchCooldown: Record<Side, number> = { left: 0, right: 0 };
  /** 패스가 날아가는 동안에는 조작을 다른 선수에게 넘기지 않는다. */
  private passInFlight: Record<Side, { targetId: string; msLeft: number } | null> = {
    left: null,
    right: null,
  };

  constructor() {
    for (const side of ["left", "right"] as const) {
      ROLES.forEach((role, i) => {
        const id = `${side === "left" ? "L" : "R"}${i + 1}`;
        const p = new Player(id, side, role);
        this.players.push(p);
        this.byId.set(id, p);
      });
    }
    this.controlled = { left: "L3", right: "R3" };
  }

  team(side: Side): Player[] {
    return this.players.filter((p) => p.side === side);
  }

  controlledPlayer(side: Side): Player {
    return this.byId.get(this.controlled[side]) ?? this.team(side)[0]!;
  }

  /** 대기 상태에서 킥오프 카운트다운으로 들어간다. */
  startMatch(): void {
    this.score = { left: 0, right: 0 };
    this.stats = emptyStats();
    this.timeLeftMs = MATCH.durationMs;
    this.result = null;
    this.resetPositions();
    this.phase = "countdown";
    this.countdownMs = MATCH.kickoffCountdownMs;
  }

  resetPositions(): void {
    for (const p of this.players) {
      p.resetToSpawn();
      p.stamina = Math.max(p.stamina, 0.7);
    }
    this.ball = {
      x: PITCH.length / 2,
      y: PITCH.width / 2,
      vx: 0,
      vy: 0,
      spin: 0,
      ownerId: null,
    };
    this.lastToucherId = null;
    this.pendingPass = null;
    this.controlled = { left: "L3", right: "R3" };
  }

  setInput(side: Side, input: InputState): void {
    const p = this.controlledPlayer(side);
    if (input.seq <= p.lastSeq) return;
    // 조작 선수가 바뀌어도 seq 흐름이 끊기지 않게 팀 단위로 기억한다
    for (const mate of this.team(side)) mate.lastSeq = input.seq;
    p.input = input;
    if (input.switchPlayer) this.manualSwitch(side);
  }

  /** seq 순서를 무시하고 입력을 덮어쓴다(접속 끊김 처리용). */
  forceInput(side: Side, input: InputState): void {
    this.controlledPlayer(side).input = input;
  }

  /** 재접속한 선수의 입력 순서를 초기화한다. */
  resetInputSeq(side: Side): void {
    for (const p of this.team(side)) {
      p.lastSeq = -1;
      p.input = neutralInput();
      p.prevShoot = false;
    }
  }

  /** dt 초만큼 진행하고 이번 틱에 일어난 사건을 돌려준다. */
  step(dt: number): SimEvent[] {
    const events: SimEvent[] = [];
    this.tick += 1;
    const ms = dt * 1000;

    if (this.phase === "countdown") {
      this.countdownMs -= ms;
      this.decayTimers(ms);
      if (this.countdownMs <= 0) {
        this.countdownMs = 0;
        this.phase = "playing";
        events.push({ kind: "kickoff" });
      }
      return events;
    }

    if (this.phase === "goal") {
      this.celebrationMs -= ms;
      this.decayTimers(ms);
      if (this.celebrationMs <= 0) {
        this.celebrationMs = 0;
        this.resetPositions();
        this.phase = "countdown";
        this.countdownMs = MATCH.kickoffCountdownMs;
      }
      return events;
    }

    if (this.phase !== "playing") return events;

    this.decayTimers(ms);
    for (const p of this.players) {
      const input = this.inputFor(p);
      this.stepPlayer(p, input, dt, events);
    }
    this.resolvePlayerCollisions();
    this.stepBall(dt);
    this.updateStats(ms);
    this.updateControl(ms, events);

    const scored = this.detectGoal();
    if (scored !== null) {
      this.score[scored] += 1;
      this.phase = "goal";
      this.celebrationMs = MATCH.goalCelebrationMs;
      const scorerId = this.lastToucherId ?? this.controlled[scored];
      for (const p of this.team(scored)) p.celebrating = true;
      events.push({ kind: "goal", side: scored, scorerId, score: { ...this.score } });
      return events;
    }

    this.timeLeftMs -= ms;
    if (this.timeLeftMs <= 0) {
      this.timeLeftMs = 0;
      this.phase = "ended";
      this.pendingPass = null;
      this.result =
        this.score.left === this.score.right
          ? "draw"
          : this.score.left > this.score.right
            ? "left"
            : "right";
      events.push({ kind: "matchEnd", result: this.result, score: { ...this.score } });
    }
    return events;
  }

  /** 사람이 조작하는 선수면 사람 입력, 나머지는 AI 입력 */
  private inputFor(p: Player): InputState {
    if (this.humanSides[p.side] && this.controlled[p.side] === p.id) return p.input;
    return aiInput(this, p);
  }

  private decayTimers(ms: number): void {
    for (const p of this.players) {
      p.shootCdMs = Math.max(0, p.shootCdMs - ms);
      p.passCdMs = Math.max(0, p.passCdMs - ms);
      p.actionAnimMs = Math.max(0, p.actionAnimMs - ms);
      if (p.actionAnimMs === 0) p.actionAnim = null;
      p.skillCdMs = Math.max(0, p.skillCdMs - ms);
      p.tackleCdMs = Math.max(0, p.tackleCdMs - ms);
      p.staggerMs = Math.max(0, p.staggerMs - ms);
      p.proneMs = Math.max(0, p.proneMs - ms);
    }
    for (const side of ["left", "right"] as const) {
      this.switchCooldown[side] = Math.max(0, this.switchCooldown[side] - ms);
    }
  }

  private stepPlayer(p: Player, input: InputState, dt: number, events: SimEvent[]): void {
    let ax = input.ax;
    let ay = input.ay;
    const mag = len(ax, ay);
    if (mag > 1) {
      ax /= mag;
      ay /= mag;
    }
    const moving = mag > 0.05;

    if (input.tackle && !p.busy) this.tryTackle(p, events);
    if (input.skillDir !== null && !p.busy) this.trySkill(p, input.skillDir, events);

    if (p.skill !== null) {
      p.skillMs -= dt * 1000;
      const speed = this.skillSpeed(p);
      p.vx = p.skillDirX * speed;
      p.vy = p.skillDirY * speed;
      if (p.skill === "tackle") this.applyTacklePoke(p);
      if (p.skill === "dragback") this.applyDragback(p, dt);
      if (p.skillMs <= 0) {
        if (p.skill === "tackle") p.proneMs = SKILL.tackle.proneMs;
        p.skill = null;
        p.skillMs = 0;
      }
    } else if (p.proneMs > 0) {
      p.vx -= p.vx * 8 * dt;
      p.vy -= p.vy * 8 * dt;
    } else {
      const wantsSprint = input.sprint && moving && p.stamina > STAMINA.sprintFloor;
      p.sprinting = wantsSprint;
      p.stamina = clamp(
        p.stamina + (wantsSprint ? -STAMINA.sprintDrain : STAMINA.regen) * dt,
        0,
        1,
      );

      const staggered = p.staggerMs > 0;
      const base = wantsSprint ? PLAYER.sprintSpeed : PLAYER.runSpeed;
      const maxSpeed = base * (staggered ? SKILL.staggerSpeedScale : 1);

      if (moving) {
        p.vx += ax * PLAYER.accel * dt;
        p.vy += ay * PLAYER.accel * dt;
        p.facing = Math.atan2(ay, ax);
      }
      p.vx -= p.vx * PLAYER.drag * dt;
      p.vy -= p.vy * PLAYER.drag * dt;
      const speed = len(p.vx, p.vy);
      if (speed > maxSpeed) {
        p.vx = (p.vx / speed) * maxSpeed;
        p.vy = (p.vy / speed) * maxSpeed;
      }

      if (input.shoot && p.shootCdMs <= 0) {
        p.chargeMs = Math.min(SHOOT.chargeMs, p.chargeMs + dt * 1000);
      }
      if (p.prevShoot && !input.shoot) this.tryShoot(p, events);
      if (input.pass && p.passCdMs <= 0) this.tryPass(p, events);
    }
    p.prevShoot = input.shoot;

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.x = clamp(p.x, PLAYER.radius, PITCH.length - PLAYER.radius);
    p.y = clamp(p.y, PLAYER.radius, PITCH.width - PLAYER.radius);
  }

  private skillSpeed(p: Player): number {
    const spec = this.skillSpec(p.skill);
    const progress = 1 - clamp(p.skillMs / spec.durationMs, 0, 1);
    return spec.burstSpeed * (1 - progress * 0.7);
  }

  private skillSpec(kind: SkillKind | null): {
    durationMs: number;
    burstSpeed: number;
    beatRange: number;
    staggerMs: number;
  } {
    switch (kind) {
      case "tackle":
        return {
          durationMs: SKILL.tackle.durationMs,
          burstSpeed: SKILL.tackle.burstSpeed,
          beatRange: 0,
          staggerMs: 0,
        };
      case "dragback":
        return SKILL.dragback;
      case "stepover":
        return SKILL.stepover;
      default:
        return SKILL.feint;
    }
  }

  /**
   * 월드 방향 벡터를 그 팀의 공격 방향 기준으로 해석해 개인기를 고른다.
   * 앞 = 스텝오버, 뒤 = 드래그백, 좌/우 = 바디 페인트.
   */
  private classifySkill(p: Player, dirX: number, dirY: number): SkillKind {
    const d = len(dirX, dirY);
    if (d < 0.2) return "stepover";
    const nx = dirX / d;
    const ny = dirY / d;
    const fx = attackDirX(p.side);
    const forward = nx * fx;
    if (forward > 0.5) return "stepover";
    if (forward < -0.5) return "dragback";
    // 공격 방향 기준 왼쪽/오른쪽
    const cross = fx * ny;
    return cross < 0 ? "feintLeft" : "feintRight";
  }

  private trySkill(p: Player, dir: { x: number; y: number }, events: SimEvent[]): void {
    if (p.skillCdMs > 0 || p.stamina < STAMINA.skillCost) return;
    const kind = this.classifySkill(p, dir.x, dir.y);
    const spec = this.skillSpec(kind);
    const fx = Math.cos(p.facing);
    const fy = Math.sin(p.facing);
    let dx: number;
    let dy: number;
    if (kind === "stepover") {
      dx = fx;
      dy = fy;
    } else if (kind === "dragback") {
      dx = -fx;
      dy = -fy;
    } else {
      const sign = kind === "feintLeft" ? -1 : 1;
      dx = fx * 0.35 + -fy * sign;
      dy = fy * 0.35 + fx * sign;
    }
    const d = len(dx, dy) || 1;
    p.skill = kind;
    p.skillMs = spec.durationMs;
    p.skillDirX = dx / d;
    p.skillDirY = dy / d;
    p.skillCdMs = SKILL.moveCooldownMs;
    p.stamina = clamp(p.stamina - STAMINA.skillCost, 0, 1);

    let beat = false;
    for (const other of this.players) {
      if (other.side === p.side) continue;
      if (len(other.x - p.x, other.y - p.y) <= spec.beatRange) {
        other.staggerMs = Math.max(other.staggerMs, spec.staggerMs);
        beat = true;
      }
    }
    events.push({ kind: "skill", playerId: p.id, skill: kind, beat });
  }

  private tryTackle(p: Player, events: SimEvent[]): void {
    if (p.tackleCdMs > 0 || p.stamina < STAMINA.tackleCost) return;
    p.skill = "tackle";
    p.skillMs = SKILL.tackle.durationMs;
    p.skillDirX = Math.cos(p.facing);
    p.skillDirY = Math.sin(p.facing);
    p.tacklePoked = false;
    p.tackleCdMs = SKILL.tackle.cooldownMs;
    p.stamina = clamp(p.stamina - STAMINA.tackleCost, 0, 1);
    events.push({ kind: "skill", playerId: p.id, skill: "tackle", beat: false });
  }

  private applyTacklePoke(p: Player): void {
    if (p.tacklePoked) return;
    const dx = this.ball.x - p.x;
    const dy = this.ball.y - p.y;
    const dist = len(dx, dy);
    if (dist > SKILL.tackle.reach + BALL.radius) return;
    const d = dist || 1;
    this.ball.vx = (dx / d) * SKILL.tackle.poke;
    this.ball.vy = (dy / d) * SKILL.tackle.poke;
    this.ball.ownerId = null;
    this.touch(p);
    p.tacklePoked = true;
  }

  /** 드래그백은 공을 함께 뒤로 끌고 온다. */
  private applyDragback(p: Player, dt: number): void {
    const dx = this.ball.x - p.x;
    const dy = this.ball.y - p.y;
    if (len(dx, dy) > DRIBBLE.range) return;
    this.ball.vx += p.skillDirX * SKILL.dragback.ballPull * dt * 10;
    this.ball.vy += p.skillDirY * SKILL.dragback.ballPull * dt * 10;
    this.touch(p);
  }

  private inKickRange(p: Player, reach: number): boolean {
    const dist = len(this.ball.x - p.x, this.ball.y - p.y);
    return dist <= PLAYER.radius + BALL.radius + reach;
  }

  private tryShoot(p: Player, events: SimEvent[]): void {
    const charge = p.chargeMs / SHOOT.chargeMs;
    p.chargeMs = 0;
    if (p.shootCdMs > 0) return;
    p.shootCdMs = SHOOT.cooldownMs;
    p.actionAnim = "shoot";
    p.actionAnimMs = 260;
    if (!this.inKickRange(p, SHOOT.reach)) return;
    const power = SHOOT.minPower + (SHOOT.maxPower - SHOOT.minPower) * clamp(charge, 0, 1);
    const nx = Math.cos(p.facing);
    const ny = Math.sin(p.facing);
    this.ball.vx = nx * power + p.vx * SHOOT.carry;
    this.ball.vy = ny * power + p.vy * SHOOT.carry;
    this.ball.ownerId = null;
    this.touch(p);
    this.stats[p.side].shots += 1;
    this.pendingPass = null;
    events.push({ kind: "shoot", playerId: p.id, power: round(power) });
  }

  /** 바라보는 방향에서 가장 받기 좋은 동료. `facing` 을 주면 그 방향을 본다고 가정한다(AI 판단용). */
  passTargetFor(p: Player, facing: number = p.facing): Player | null {
    const fx = Math.cos(facing);
    const fy = Math.sin(facing);
    let best: Player | null = null;
    let bestScore = Infinity;
    for (const mate of this.players) {
      if (mate.side !== p.side || mate.id === p.id) continue;
      const dx = mate.x - p.x;
      const dy = mate.y - p.y;
      const dist = len(dx, dy) || 1;
      const angle = Math.acos(clamp((dx * fx + dy * fy) / dist, -1, 1));
      if (angle > PASS.maxAngle) continue;
      const score = angle * 3 + dist * 0.04;
      if (score < bestScore) {
        bestScore = score;
        best = mate;
      }
    }
    return best;
  }

  private tryPass(p: Player, events: SimEvent[]): void {
    p.passCdMs = PASS.cooldownMs;
    p.actionAnim = "pass";
    p.actionAnimMs = 220;
    if (!this.inKickRange(p, PASS.reach)) return;
    this.stats[p.side].passes += 1;
    // 새 패스는 이전 패스의 완료 판정을 끝낸다
    this.pendingPass = null;
    const target = this.passTargetFor(p);
    if (target === null) {
      const nx = Math.cos(p.facing);
      const ny = Math.sin(p.facing);
      this.ball.vx = nx * PASS.fallbackSpeed;
      this.ball.vy = ny * PASS.fallbackSpeed;
      this.ball.ownerId = null;
      this.touch(p);
      events.push({ kind: "pass", playerId: p.id, targetId: null });
      return;
    }
    // 받는 사람의 진행 방향을 살짝 내다본다
    const tx = target.x + target.vx * PASS.leadSeconds;
    const ty = target.y + target.vy * PASS.leadSeconds;
    const dx = tx - p.x;
    const dy = ty - p.y;
    const dist = len(dx, dy) || 1;
    const speed = clamp(dist * PASS.speedPerMeter + PASS.minSpeed, PASS.minSpeed, PASS.maxSpeed);
    this.ball.vx = (dx / dist) * speed;
    this.ball.vy = (dy / dist) * speed;
    this.ball.ownerId = null;
    this.touch(p);
    this.passInFlight[p.side] = { targetId: target.id, msLeft: PASS.completeWindowMs };
    this.pendingPass = {
      side: p.side,
      passerId: p.id,
      targetId: target.id,
      msLeft: PASS.completeWindowMs,
    };
    events.push({ kind: "pass", playerId: p.id, targetId: target.id });
  }

  private resolvePlayerCollisions(): void {
    for (let i = 0; i < this.players.length; i += 1) {
      for (let j = i + 1; j < this.players.length; j += 1) {
        const a = this.players[i]!;
        const b = this.players[j]!;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = len(dx, dy);
        const min = PLAYER.radius * 2;
        if (dist >= min || dist === 0) continue;
        const nx = dx / dist;
        const ny = dy / dist;
        const push = (min - dist) / 2;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
        const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (rel < 0) {
          const jImp = rel * 0.5;
          a.vx += jImp * nx;
          a.vy += jImp * ny;
          b.vx -= jImp * nx;
          b.vy -= jImp * ny;
        }
      }
    }
  }

  private stepBall(dt: number): void {
    const ball = this.ball;

    const controller = this.findController();
    for (const p of this.players) p.dribbling = controller?.id === p.id;
    ball.ownerId = controller?.id ?? null;
    if (controller) {
      this.touch(controller);
      const looseness = controller.sprinting ? DRIBBLE.sprintLooseness : 1;
      const tx = controller.x + Math.cos(controller.facing) * DRIBBLE.leadDistance;
      const ty = controller.y + Math.sin(controller.facing) * DRIBBLE.leadDistance;
      const k = DRIBBLE.stiffness * looseness;
      ball.vx += (tx - ball.x) * k * dt;
      ball.vy += (ty - ball.y) * k * dt;
      ball.vx += (controller.vx - ball.vx) * 2.5 * dt;
      ball.vy += (controller.vy - ball.vy) * 2.5 * dt;
    }

    ball.vx -= ball.vx * BALL.drag * dt;
    ball.vy -= ball.vy * BALL.drag * dt;
    const speed = len(ball.vx, ball.vy);
    if (speed > BALL.maxSpeed) {
      ball.vx = (ball.vx / speed) * BALL.maxSpeed;
      ball.vy = (ball.vy / speed) * BALL.maxSpeed;
    }
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;
    ball.spin = (ball.spin + speed * dt) % (Math.PI * 2);

    for (const p of this.players) this.resolveBallPlayer(p);

    if (ball.y - BALL.radius < 0) {
      ball.y = BALL.radius;
      ball.vy = Math.abs(ball.vy) * BALL.wallRestitution;
    } else if (ball.y + BALL.radius > PITCH.width) {
      ball.y = PITCH.width - BALL.radius;
      ball.vy = -Math.abs(ball.vy) * BALL.wallRestitution;
    }
    const inMouth = ball.y > GOAL_TOP && ball.y < GOAL_BOTTOM;
    if (!inMouth) {
      if (ball.x - BALL.radius < 0) {
        ball.x = BALL.radius;
        ball.vx = Math.abs(ball.vx) * BALL.wallRestitution;
      } else if (ball.x + BALL.radius > PITCH.length) {
        ball.x = PITCH.length - BALL.radius;
        ball.vx = -Math.abs(ball.vx) * BALL.wallRestitution;
      }
    }
  }

  /**
   * 경기 기록을 갱신한다(`playing` 단계의 틱마다 공 이동 직후).
   * - 소유 시간: 공 소유자 팀에 이번 틱 시간을 더한다.
   * - 패스 완료: 받을 동료가 처음 공을 소유하면 1회. 패스한 선수도 받을 동료도 아닌
   *   동료가 먼저 잡거나 시간이 지나면 취소한다. 상대 터치는 닿는 순간 `touch` 에서 취소한다.
   */
  /**
   * 선수가 공에 닿았다. 마지막 터치를 기록하고, 대기 중인 패스를 상대가 건드렸으면
   * 그 자리에서 취소한다(같은 틱에 받을 동료가 소유해도 먼저 닿은 상대 터치가 이긴다).
   */
  private touch(p: Player): void {
    this.lastToucherId = p.id;
    if (this.pendingPass !== null && this.pendingPass.side !== p.side) this.pendingPass = null;
  }

  private updateStats(ms: number): void {
    const owner = this.ball.ownerId ? this.byId.get(this.ball.ownerId) : undefined;
    if (owner) this.stats[owner.side].possessionMs += ms;

    const pending = this.pendingPass;
    if (pending === null) return;
    if (owner && owner.id === pending.targetId) {
      this.stats[pending.side].completedPasses += 1;
      this.pendingPass = null;
      return;
    }
    const takenByOther = owner !== undefined && owner.id !== pending.passerId;
    pending.msLeft -= ms;
    if (takenByOther || pending.msLeft <= 0) this.pendingPass = null;
  }

  /** 공을 몰고 있는 선수(가장 가깝고 사거리 안이며 움직이는 중) */
  private findController(): Player | null {
    let best: Player | null = null;
    let bestDist = Infinity;
    for (const p of this.players) {
      if (p.busy) continue;
      const d = len(this.ball.x - p.x, this.ball.y - p.y);
      if (d > DRIBBLE.range) continue;
      if (len(p.vx, p.vy) < 0.6) continue;
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  private resolveBallPlayer(p: Player): void {
    const ball = this.ball;
    const dx = ball.x - p.x;
    const dy = ball.y - p.y;
    const dist = len(dx, dy);
    const min = PLAYER.radius + BALL.radius;
    if (dist >= min) return;
    const d = dist || 1e-6;
    const nx = dx / d;
    const ny = dy / d;
    ball.x = p.x + nx * min;
    ball.y = p.y + ny * min;
    const rel = (ball.vx - p.vx) * nx + (ball.vy - p.vy) * ny;
    if (rel < 0) {
      const jImp = -(1 + 0.45) * rel;
      ball.vx += jImp * nx;
      ball.vy += jImp * ny;
    }
    ball.vx += p.vx * 0.22;
    ball.vy += p.vy * 0.22;
    this.touch(p);
  }

  /**
   * 사람이 조작할 선수를 상황에 맞게 넘긴다.
   *
   * 1. 동료가 공을 잡으면 바로 그 선수로 넘긴다(패스를 받으면 이어서 조작하게 된다).
   * 2. 그 밖에는 손을 놓고 있고, 공에서 멀리 떨어져 있으며, 훨씬 가까운 동료가 있을 때만 넘긴다.
   *    조작 중인 사람에게서 선수를 빼앗지 않는 것이 규칙이다.
   */
  private updateControl(ms: number, events: SimEvent[]): void {
    for (const side of ["left", "right"] as const) {
      const flight = this.passInFlight[side];
      if (flight !== null) {
        flight.msLeft -= ms;
        if (flight.msLeft <= 0) this.passInFlight[side] = null;
      }
      if (!this.humanSides[side]) continue;
      const current = this.controlled[side];
      const owner = this.ball.ownerId ? this.byId.get(this.ball.ownerId) : undefined;

      if (owner) this.passInFlight[side] = null;

      // 1) 동료가 공을 잡았다
      if (owner && owner.side === side && owner.id !== current) {
        this.setControlled(side, owner.id, events);
        continue;
      }
      if (owner && owner.side === side) continue;
      if (this.switchCooldown[side] > 0) continue;
      // 패스가 날아가는 동안에는 받을 동료가 잡을 때까지 기다린다
      if (this.passInFlight[side] !== null) continue;

      const currentPlayer = this.byId.get(current);
      // 사람이 조작 중이면 넘기지 않는다
      if (currentPlayer && isActiveInput(currentPlayer.input)) continue;

      const currentDist = currentPlayer
        ? len(this.ball.x - currentPlayer.x, this.ball.y - currentPlayer.y)
        : Infinity;
      // 공 근처에서 플레이 중이면 그대로 둔다
      if (currentDist < CONTROL_HANDOVER_DISTANCE) continue;

      const nearest = this.nearestToBall(side);
      if (nearest && nearest.id !== current) {
        const nearestDist = len(this.ball.x - nearest.x, this.ball.y - nearest.y);
        // 충분히 더 가까울 때만 넘겨서 깜빡임을 막는다
        if (nearestDist < currentDist - 2) this.setControlled(side, nearest.id, events);
      }
    }
  }

  private setControlled(side: Side, id: string, events: SimEvent[]): void {
    if (this.controlled[side] === id) return;
    const previous = this.byId.get(this.controlled[side]);
    if (previous) {
      previous.input = neutralInput();
      previous.prevShoot = false;
      previous.chargeMs = 0;
    }
    this.controlled[side] = id;
    this.switchCooldown[side] = MATCH.controlSwitchMs;
    events.push({ kind: "control", side, playerId: id });
  }

  private nearestToBall(side: Side): Player | null {
    let best: Player | null = null;
    let bestDist = Infinity;
    for (const p of this.team(side)) {
      if (p.proneMs > 0) continue;
      const d = len(this.ball.x - p.x, this.ball.y - p.y);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    return best;
  }

  /** 수동 선수 전환: 공에 가까운 순서로 다음 동료에게 넘긴다. */
  manualSwitch(side: Side): void {
    const mates = this.team(side)
      .filter((p) => p.id !== this.controlled[side])
      .sort(
        (a, b) =>
          len(this.ball.x - a.x, this.ball.y - a.y) - len(this.ball.x - b.x, this.ball.y - b.y),
      );
    const next = mates[0];
    if (!next) return;
    const events: SimEvent[] = [];
    this.setControlled(side, next.id, events);
  }

  private detectGoal(): Side | null {
    const ball = this.ball;
    if (ball.y <= GOAL_TOP || ball.y >= GOAL_BOTTOM) return null;
    if (ball.x - BALL.radius <= 0) return "right";
    if (ball.x + BALL.radius >= PITCH.length) return "left";
    return null;
  }

  private animOf(p: Player): AnimState {
    if (p.celebrating && this.phase === "goal") return "celebrate";
    if (p.proneMs > 0) return "prone";
    if (p.skill === "tackle") return "tackle";
    if (p.skill === "stepover") return "stepover";
    if (p.skill === "dragback") return "dragback";
    if (p.skill === "feintLeft") return "feintLeft";
    if (p.skill === "feintRight") return "feintRight";
    if (p.actionAnim === "shoot") return "shoot";
    if (p.actionAnim === "pass") return "pass";
    const speed = len(p.vx, p.vy);
    if (speed < 0.35) return "idle";
    if (p.dribbling) return "dribble";
    return p.sprinting ? "sprint" : "run";
  }

  viewOf(p: Player): PlayerView {
    return {
      id: p.id,
      side: p.side,
      role: p.role,
      controlled: this.controlled[p.side] === p.id,
      human: this.humanSides[p.side],
      x: round(p.x),
      y: round(p.y),
      vx: round(p.vx),
      vy: round(p.vy),
      facing: round(p.facing),
      charge: round(p.chargeMs / SHOOT.chargeMs),
      stamina: round(p.stamina),
      dribbling: p.dribbling,
      skill: p.skill,
      skillMs: Math.round(p.skillMs),
      cooldowns: { skill: Math.round(p.skillCdMs), tackle: Math.round(p.tackleCdMs) },
      anim: this.animOf(p),
    };
  }

  private statsView(side: Side): TeamStats {
    const s = this.stats[side];
    return {
      shots: s.shots,
      passes: s.passes,
      completedPasses: s.completedPasses,
      possessionMs: Math.round(s.possessionMs),
    };
  }

  snapshot(now: number): Snapshot {
    return {
      t: "snapshot",
      tick: this.tick,
      ts: now,
      phase: this.phase,
      ball: {
        x: round(this.ball.x),
        y: round(this.ball.y),
        vx: round(this.ball.vx),
        vy: round(this.ball.vy),
        spin: round(this.ball.spin),
        ownerId: this.ball.ownerId,
      },
      players: this.players.map((p) => this.viewOf(p)),
      score: { ...this.score },
      timeLeftMs: Math.max(0, Math.round(this.timeLeftMs)),
      countdownMs: Math.max(0, Math.round(this.countdownMs)),
      controlled: { ...this.controlled },
      passTarget: {
        left: this.passTargetFor(this.controlledPlayer("left"))?.id ?? null,
        right: this.passTargetFor(this.controlledPlayer("right"))?.id ?? null,
      },
      stats: {
        left: this.statsView("left"),
        right: this.statsView("right"),
      },
    };
  }
}
