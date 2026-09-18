/**
 * 권위 시뮬레이션. 순수 로직만 담고 네트워크는 모른다.
 * 같은 입력 순서를 주면 같은 결과가 나오므로 테스트에서 그대로 검증한다.
 */
import {
  BALL,
  DRIBBLE,
  GOAL_BOTTOM,
  GOAL_TOP,
  KICK,
  MATCH,
  PITCH,
  PLAYER,
  SKILL,
  SPAWN,
  STAMINA,
  type Side,
} from "./constants.ts";
import type {
  AnimState,
  BallView,
  InputState,
  MatchResult,
  Phase,
  PlayerView,
  Score,
  SkillKind,
  Snapshot,
} from "../protocol.ts";

export type SimEvent =
  | { kind: "kickoff" }
  | { kind: "goal"; side: Side; score: Score }
  | { kind: "matchEnd"; result: MatchResult; score: Score }
  | { kind: "kick"; side: Side; power: number }
  | { kind: "skill"; side: Side; skill: SkillKind; beat: boolean };

export const NEUTRAL_INPUT: InputState = {
  seq: 0,
  ax: 0,
  ay: 0,
  kick: false,
  sprint: false,
  skill: null,
};

interface Vec {
  x: number;
  y: number;
}

class Player {
  readonly side: Side;
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  facing: number;
  stamina = 1;
  sprinting = false;
  chargeMs = 0;
  kickCooldownMs = 0;
  kickAnimMs = 0;
  skill: SkillKind | null = null;
  skillMs = 0;
  skillDirX = 0;
  skillDirY = 0;
  slidePoked = false;
  proneMs = 0;
  staggerMs = 0;
  stepoverCdMs = 0;
  slideCdMs = 0;
  dribbling = false;
  celebrating = false;
  input: InputState = { ...NEUTRAL_INPUT };
  lastSeq = -1;
  prevKick = false;

  constructor(side: Side) {
    this.side = side;
    this.facing = side === "left" ? 0 : Math.PI;
    this.resetTo(SPAWN[side]);
  }

  resetTo(pos: Vec): void {
    this.x = pos.x;
    this.y = pos.y;
    this.vx = 0;
    this.vy = 0;
    this.facing = this.side === "left" ? 0 : Math.PI;
    this.chargeMs = 0;
    this.kickCooldownMs = 0;
    this.kickAnimMs = 0;
    this.skill = null;
    this.skillMs = 0;
    this.proneMs = 0;
    this.staggerMs = 0;
    this.dribbling = false;
    this.prevKick = false;
    this.input = { ...NEUTRAL_INPUT, seq: this.input.seq };
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

export class Match {
  phase: Phase = "waiting";
  tick = 0;
  score: Score = { left: 0, right: 0 };
  timeLeftMs: number = MATCH.durationMs;
  countdownMs = 0;
  celebrationMs = 0;
  result: MatchResult | null = null;

  readonly players: Record<Side, Player> = {
    left: new Player("left"),
    right: new Player("right"),
  };

  ball: BallView = { x: PITCH.length / 2, y: PITCH.width / 2, vx: 0, vy: 0, spin: 0 };

  /** 대기 상태에서 킥오프 카운트다운으로 들어간다. */
  startMatch(): void {
    this.score = { left: 0, right: 0 };
    this.timeLeftMs = MATCH.durationMs;
    this.result = null;
    this.resetPositions();
    this.phase = "countdown";
    this.countdownMs = MATCH.kickoffCountdownMs;
  }

  resetPositions(): void {
    this.players.left.resetTo(SPAWN.left);
    this.players.right.resetTo(SPAWN.right);
    this.players.left.stamina = Math.max(this.players.left.stamina, 0.7);
    this.players.right.stamina = Math.max(this.players.right.stamina, 0.7);
    this.players.left.celebrating = false;
    this.players.right.celebrating = false;
    this.ball = { x: PITCH.length / 2, y: PITCH.width / 2, vx: 0, vy: 0, spin: 0 };
  }

  setInput(side: Side, input: InputState): void {
    const p = this.players[side];
    if (input.seq <= p.lastSeq) return;
    p.lastSeq = input.seq;
    p.input = input;
  }

  /** seq 순서를 무시하고 입력을 덮어쓴다(봇, 접속 끊김 처리용). */
  forceInput(side: Side, input: InputState): void {
    this.players[side].input = input;
  }

  /** 재접속한 선수의 입력 순서를 초기화한다. */
  resetInputSeq(side: Side): void {
    const p = this.players[side];
    p.lastSeq = -1;
    p.input = { ...NEUTRAL_INPUT };
    p.prevKick = false;
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
    for (const side of ["left", "right"] as const) {
      this.stepPlayer(this.players[side], dt, events);
    }
    this.resolvePlayerCollision();
    this.stepBall(dt);
    const scored = this.detectGoal();
    if (scored !== null) {
      this.score[scored] += 1;
      this.phase = "goal";
      this.celebrationMs = MATCH.goalCelebrationMs;
      this.players[scored].celebrating = true;
      events.push({ kind: "goal", side: scored, score: { ...this.score } });
      return events;
    }

    this.timeLeftMs -= ms;
    if (this.timeLeftMs <= 0) {
      this.timeLeftMs = 0;
      this.phase = "ended";
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

  private decayTimers(ms: number): void {
    for (const side of ["left", "right"] as const) {
      const p = this.players[side];
      p.kickCooldownMs = Math.max(0, p.kickCooldownMs - ms);
      p.kickAnimMs = Math.max(0, p.kickAnimMs - ms);
      p.stepoverCdMs = Math.max(0, p.stepoverCdMs - ms);
      p.slideCdMs = Math.max(0, p.slideCdMs - ms);
      p.staggerMs = Math.max(0, p.staggerMs - ms);
      p.proneMs = Math.max(0, p.proneMs - ms);
    }
  }

  private stepPlayer(p: Player, dt: number, events: SimEvent[]): void {
    const input = p.input;
    let ax = input.ax;
    let ay = input.ay;
    const mag = len(ax, ay);
    if (mag > 1) {
      ax /= mag;
      ay /= mag;
    }
    const moving = mag > 0.05;

    // 개인기 시도
    if (input.skill !== null && !p.busy) {
      this.tryStartSkill(p, input.skill, ax, ay, moving, events);
      p.input = { ...input, skill: null };
    }

    if (p.skill !== null) {
      p.skillMs -= dt * 1000;
      p.vx = p.skillDirX * this.skillSpeed(p);
      p.vy = p.skillDirY * this.skillSpeed(p);
      if (p.skill === "slide") this.applySlidePoke(p);
      if (p.skillMs <= 0) {
        if (p.skill === "slide") p.proneMs = SKILL.slide.proneMs;
        p.skill = null;
        p.skillMs = 0;
      }
    } else if (p.proneMs > 0) {
      p.vx -= p.vx * 8 * dt;
      p.vy -= p.vy * 8 * dt;
    } else {
      // 스프린트와 스태미나
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

      // 슛 충전과 발사
      if (input.kick && p.kickCooldownMs <= 0) {
        p.chargeMs = Math.min(KICK.chargeMs, p.chargeMs + dt * 1000);
      }
      if (p.prevKick && !input.kick) {
        this.tryKick(p, events);
      }
    }
    p.prevKick = input.kick;

    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.x = clamp(p.x, PLAYER.radius, PITCH.length - PLAYER.radius);
    p.y = clamp(p.y, PLAYER.radius, PITCH.width - PLAYER.radius);
  }

  private skillSpeed(p: Player): number {
    const spec = p.skill === "slide" ? SKILL.slide : SKILL.stepover;
    const total = p.skill === "slide" ? SKILL.slide.durationMs : SKILL.stepover.durationMs;
    // 시작이 가장 빠르고 끝으로 갈수록 느려진다
    const progress = 1 - clamp(p.skillMs / total, 0, 1);
    return spec.burstSpeed * (1 - progress * 0.7);
  }

  private tryStartSkill(
    p: Player,
    kind: SkillKind,
    ax: number,
    ay: number,
    moving: boolean,
    events: SimEvent[],
  ): void {
    const opponent = this.players[p.side === "left" ? "right" : "left"];
    if (kind === "stepover") {
      if (p.stepoverCdMs > 0 || p.stamina < STAMINA.stepoverCost) return;
      const fx = Math.cos(p.facing);
      const fy = Math.sin(p.facing);
      // 입력 방향이 바라보는 방향의 어느 쪽인지로 좌/우를 정한다
      const cross = moving ? fx * ay - fy * ax : 0;
      const sign = cross >= 0 ? 1 : -1;
      const lx = -fy * sign;
      const ly = fx * sign;
      const dx = fx * 0.55 + lx * 0.95;
      const dy = fy * 0.55 + ly * 0.95;
      const d = len(dx, dy) || 1;
      p.skill = "stepover";
      p.skillMs = SKILL.stepover.durationMs;
      p.skillDirX = dx / d;
      p.skillDirY = dy / d;
      p.stepoverCdMs = SKILL.stepover.cooldownMs;
      p.stamina = clamp(p.stamina - STAMINA.stepoverCost, 0, 1);
      const beat = len(opponent.x - p.x, opponent.y - p.y) <= SKILL.stepover.beatRange;
      if (beat) opponent.staggerMs = SKILL.stepover.staggerMs;
      events.push({ kind: "skill", side: p.side, skill: "stepover", beat });
      return;
    }
    if (p.slideCdMs > 0 || p.stamina < STAMINA.slideCost) return;
    p.skill = "slide";
    p.skillMs = SKILL.slide.durationMs;
    p.skillDirX = Math.cos(p.facing);
    p.skillDirY = Math.sin(p.facing);
    p.slidePoked = false;
    p.slideCdMs = SKILL.slide.cooldownMs;
    p.stamina = clamp(p.stamina - STAMINA.slideCost, 0, 1);
    events.push({ kind: "skill", side: p.side, skill: "slide", beat: false });
  }

  private applySlidePoke(p: Player): void {
    if (p.slidePoked) return;
    const dx = this.ball.x - p.x;
    const dy = this.ball.y - p.y;
    if (len(dx, dy) > SKILL.slide.reach + BALL.radius) return;
    const d = len(dx, dy) || 1;
    this.ball.vx = (dx / d) * SKILL.slide.poke;
    this.ball.vy = (dy / d) * SKILL.slide.poke;
    p.slidePoked = true;
  }

  private tryKick(p: Player, events: SimEvent[]): void {
    const charge = p.chargeMs / KICK.chargeMs;
    p.chargeMs = 0;
    if (p.kickCooldownMs > 0) return;
    p.kickCooldownMs = KICK.cooldownMs;
    p.kickAnimMs = 260;
    const dx = this.ball.x - p.x;
    const dy = this.ball.y - p.y;
    const dist = len(dx, dy);
    if (dist > PLAYER.radius + BALL.radius + KICK.reach) return;
    const d = dist || 1;
    const nx = dist < 1e-4 ? Math.cos(p.facing) : dx / d;
    const ny = dist < 1e-4 ? Math.sin(p.facing) : dy / d;
    const power = KICK.minPower + (KICK.maxPower - KICK.minPower) * clamp(charge, 0, 1);
    this.ball.vx = nx * power + p.vx * KICK.carry;
    this.ball.vy = ny * power + p.vy * KICK.carry;
    events.push({ kind: "kick", side: p.side, power });
  }

  private resolvePlayerCollision(): void {
    const a = this.players.left;
    const b = this.players.right;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = len(dx, dy);
    const min = PLAYER.radius * 2;
    if (dist >= min || dist === 0) return;
    const nx = dx / dist;
    const ny = dy / dist;
    const push = (min - dist) / 2;
    a.x -= nx * push;
    a.y -= ny * push;
    b.x += nx * push;
    b.y += ny * push;
    const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
    if (rel < 0) {
      const j = rel * 0.5;
      a.vx += j * nx;
      a.vy += j * ny;
      b.vx -= j * nx;
      b.vy -= j * ny;
    }
  }

  private stepBall(dt: number): void {
    const ball = this.ball;

    // 볼 컨트롤(드리블): 가장 가까운 선수가 공을 발 앞에 붙인다
    const controller = this.findController();
    for (const side of ["left", "right"] as const) {
      this.players[side].dribbling = controller?.side === side;
    }
    if (controller) {
      const looseness = controller.sprinting ? DRIBBLE.sprintLooseness : 1;
      const tx = controller.x + Math.cos(controller.facing) * DRIBBLE.leadDistance;
      const ty = controller.y + Math.sin(controller.facing) * DRIBBLE.leadDistance;
      const k = DRIBBLE.stiffness * looseness;
      ball.vx += (tx - ball.x) * k * dt;
      ball.vy += (ty - ball.y) * k * dt;
      // 선수 속도를 일부 따라간다
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

    for (const side of ["left", "right"] as const) {
      this.resolveBallPlayer(this.players[side]);
    }

    // 위아래 터치라인
    if (ball.y - BALL.radius < 0) {
      ball.y = BALL.radius;
      ball.vy = Math.abs(ball.vy) * BALL.wallRestitution;
    } else if (ball.y + BALL.radius > PITCH.width) {
      ball.y = PITCH.width - BALL.radius;
      ball.vy = -Math.abs(ball.vy) * BALL.wallRestitution;
    }
    // 좌우 골라인 (골문 밖일 때만 튕긴다)
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

  /** 공을 몰 수 있는 선수(가장 가깝고 사거리 안이며 움직이는 중) */
  private findController(): Player | null {
    let best: Player | null = null;
    let bestDist = Infinity;
    for (const side of ["left", "right"] as const) {
      const p = this.players[side];
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
      const j = -(1 + 0.45) * rel;
      ball.vx += j * nx;
      ball.vy += j * ny;
    }
    ball.vx += p.vx * 0.22;
    ball.vy += p.vy * 0.22;
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
    if (p.skill === "slide") return "slide";
    if (p.skill === "stepover") return "stepover";
    if (p.kickAnimMs > 0) return "kick";
    const speed = len(p.vx, p.vy);
    if (speed < 0.35) return "idle";
    if (p.dribbling) return "dribble";
    return p.sprinting ? "sprint" : "run";
  }

  viewOf(side: Side): PlayerView {
    const p = this.players[side];
    return {
      side,
      x: round(p.x),
      y: round(p.y),
      vx: round(p.vx),
      vy: round(p.vy),
      facing: round(p.facing),
      charge: round(p.chargeMs / KICK.chargeMs),
      stamina: round(p.stamina),
      dribbling: p.dribbling,
      skill: p.skill,
      skillMs: Math.round(p.skillMs),
      cooldowns: {
        stepover: Math.round(p.stepoverCdMs),
        slide: Math.round(p.slideCdMs),
      },
      anim: this.animOf(p),
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
      },
      players: [this.viewOf("left"), this.viewOf("right")],
      score: { ...this.score },
      timeLeftMs: Math.max(0, Math.round(this.timeLeftMs)),
      countdownMs: Math.max(0, Math.round(this.countdownMs)),
    };
  }
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}
