/**
 * 20Hz 로 오는 스냅샷을 60fps 화면으로 펴 주는 버퍼.
 *
 * 서버와 시계를 맞추지 않는다. 대신 "렌더 시각" 을 따로 굴리면서 버퍼의 가장 최신
 * 스냅샷보다 `INTERP_DELAY_MS` 만큼 뒤를 보여 준다. 네트워크가 흔들려 버퍼가
 * 얇아지거나 두꺼워지면 렌더 시각의 진행 속도를 아주 조금 조절해 따라잡는다.
 * 속도를 순간적으로 확 바꾸지 않으므로 화면이 튀지 않는다.
 */
import type { AnimState, MatchStats, PlayerView, Role, Side, Snapshot } from "../net/protocol.ts";

/** 스냅샷 두 개(50ms)를 손에 쥐고 보간할 만큼의 지연. */
const INTERP_DELAY_MS = 105;
/** 버퍼가 마르면 이 시간까지만 속도로 밀어서 메운다. */
const MAX_EXTRAPOLATE_MS = 140;
/** 렌더 시각이 이만큼 어긋나면 부드럽게 못 따라잡으니 그냥 맞춰 버린다. */
const RESYNC_THRESHOLD_MS = 900;
const MAX_BUFFER = 40;

export interface PlayerFrame {
  /** 경기 내내 고정된 식별자. 예: "L1" "R3" */
  id: string;
  side: Side;
  role: Role;
  /** 지금 사람이 조작 중인 선수인지(팀마다 한 명) */
  controlled: boolean;
  /** 사람이 있는 팀 소속인지. false 면 AI 팀. */
  human: boolean;
  x: number;
  y: number;
  /** m/s. 달리기 사이클 속도와 카메라 리드에 쓴다. */
  speed: number;
  facing: number;
  charge: number;
  stamina: number;
  dribbling: boolean;
  skill: PlayerView["skill"];
  skillMs: number;
  cooldowns: PlayerView["cooldowns"];
  anim: AnimState;
}

export interface BallFrame {
  x: number;
  y: number;
  speed: number;
  spin: number;
  /** 진행 방향(라디안). 굴리는 축을 정하는 데 쓴다. */
  heading: number;
  /** 공을 소유한 선수 id. */
  ownerId: string | null;
}

export interface MatchFrame {
  players: PlayerFrame[];
  ball: BallFrame;
  /** 각 팀에서 지금 사람이 조작 중인 선수 id. */
  controlled: { left: string; right: string };
  /** 패스하면 받을 동료 id. */
  passTarget: { left: string | null; right: string | null };
  phase: Snapshot["phase"];
  score: Snapshot["score"];
  timeLeftMs: number;
  countdownMs: number;
  /**
   * 경기 누적 기록(슛·패스·점유 시간). 누적값이라 보간하지 않고 더 최신 스냅샷 값을
   * 그대로 쓴다. 기록을 모르는 구버전 서버이거나 아직 스냅샷이 없으면 null.
   */
  stats: MatchStats | null;
  /** 버퍼가 비어서 아직 보여 줄 게 없으면 false. */
  ready: boolean;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 각도는 -PI..PI 를 넘나들므로 짧은 쪽으로 돌려서 섞는다. */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export class SnapshotBuffer {
  private readonly frames: Snapshot[] = [];
  private renderTs = 0;
  private started = false;

  push(snapshot: Snapshot): void {
    const last = this.frames[this.frames.length - 1];
    // 순서가 뒤집혀 도착한 오래된 스냅샷은 버린다.
    if (last && snapshot.tick <= last.tick) return;
    this.frames.push(snapshot);
    if (this.frames.length > MAX_BUFFER) this.frames.splice(0, this.frames.length - MAX_BUFFER);
    if (!this.started) {
      this.renderTs = snapshot.ts - INTERP_DELAY_MS;
      this.started = true;
    }
  }

  reset(): void {
    this.frames.length = 0;
    this.started = false;
    this.renderTs = 0;
  }

  get hasData(): boolean {
    return this.frames.length > 0;
  }

  /** 마지막으로 받은 원본 스냅샷. HUD 처럼 보간이 필요 없는 값에 쓴다. */
  get latest(): Snapshot | null {
    return this.frames[this.frames.length - 1] ?? null;
  }

  /**
   * `dtMs` 만큼 렌더 시각을 진행시키고 그 시점의 화면 상태를 만든다.
   * 매 프레임 한 번만 부른다.
   */
  sample(dtMs: number): MatchFrame | null {
    const newest = this.frames[this.frames.length - 1];
    if (!newest || !this.started) return null;

    const target = newest.ts - INTERP_DELAY_MS;
    const drift = target - this.renderTs;
    if (Math.abs(drift) > RESYNC_THRESHOLD_MS) {
      this.renderTs = target;
    } else {
      // 뒤처졌으면 조금 빠르게, 앞섰으면 조금 느리게. 최대 ±12%.
      const rate = 1 + Math.max(-0.12, Math.min(0.12, drift / 500));
      this.renderTs += dtMs * rate;
    }

    this.dropStale();

    const [older, newer] = this.pair(this.renderTs);
    if (!older) return null;

    if (!newer) {
      // 버퍼가 말랐다. 마지막 상태를 속도로 짧게 밀어 준다.
      const ahead = Math.min(MAX_EXTRAPOLATE_MS, Math.max(0, this.renderTs - older.ts)) / 1000;
      return this.project(older, ahead);
    }

    const span = newer.ts - older.ts;
    const t = span > 0 ? Math.max(0, Math.min(1, (this.renderTs - older.ts) / span)) : 1;
    return this.blend(older, newer, t);
  }

  private dropStale(): void {
    // 보간에 쓰이는 구간(현재 렌더 시각 직전) 앞쪽은 버린다.
    while (this.frames.length > 2) {
      const second = this.frames[1];
      if (!second || second.ts > this.renderTs) break;
      this.frames.shift();
    }
  }

  private pair(ts: number): [Snapshot | null, Snapshot | null] {
    for (let i = this.frames.length - 1; i >= 0; i -= 1) {
      const frame = this.frames[i];
      if (!frame) continue;
      if (frame.ts <= ts) return [frame, this.frames[i + 1] ?? null];
    }
    return [this.frames[0] ?? null, this.frames[1] ?? null];
  }

  private blend(a: Snapshot, b: Snapshot, t: number): MatchFrame {
    const players: PlayerFrame[] = [];
    for (const from of a.players) {
      const to = b.players.find((p) => p.id === from.id) ?? from;
      players.push({
        id: from.id,
        side: from.side,
        role: from.role,
        controlled: to.controlled,
        human: to.human,
        x: lerp(from.x, to.x, t),
        y: lerp(from.y, to.y, t),
        speed: Math.hypot(lerp(from.vx, to.vx, t), lerp(from.vy, to.vy, t)),
        facing: lerpAngle(from.facing, to.facing, t),
        charge: lerp(from.charge, to.charge, t),
        stamina: lerp(from.stamina, to.stamina, t),
        // 상태값은 섞으면 뜻이 사라진다. 더 최신 쪽을 그대로 쓴다.
        dribbling: to.dribbling,
        skill: to.skill,
        skillMs: to.skillMs,
        cooldowns: to.cooldowns,
        anim: to.anim,
      });
    }
    const ballVx = lerp(a.ball.vx, b.ball.vx, t);
    const ballVy = lerp(a.ball.vy, b.ball.vy, t);
    return {
      players,
      ball: {
        x: lerp(a.ball.x, b.ball.x, t),
        y: lerp(a.ball.y, b.ball.y, t),
        speed: Math.hypot(ballVx, ballVy),
        spin: lerp(a.ball.spin, b.ball.spin, t),
        heading: Math.atan2(ballVy, ballVx),
        ownerId: b.ball.ownerId,
      },
      controlled: b.controlled,
      passTarget: b.passTarget,
      phase: b.phase,
      score: b.score,
      timeLeftMs: Math.round(lerp(a.timeLeftMs, b.timeLeftMs, t)),
      countdownMs: Math.round(lerp(a.countdownMs, b.countdownMs, t)),
      stats: b.stats ?? null,
      ready: true,
    };
  }

  private project(snapshot: Snapshot, aheadSec: number): MatchFrame {
    const players = snapshot.players.map<PlayerFrame>((p) => ({
      id: p.id,
      side: p.side,
      role: p.role,
      controlled: p.controlled,
      human: p.human,
      x: p.x + p.vx * aheadSec,
      y: p.y + p.vy * aheadSec,
      speed: Math.hypot(p.vx, p.vy),
      facing: p.facing,
      charge: p.charge,
      stamina: p.stamina,
      dribbling: p.dribbling,
      skill: p.skill,
      skillMs: Math.max(0, p.skillMs - aheadSec * 1000),
      cooldowns: p.cooldowns,
      anim: p.anim,
    }));
    const ball = snapshot.ball;
    return {
      players,
      ball: {
        x: ball.x + ball.vx * aheadSec,
        y: ball.y + ball.vy * aheadSec,
        speed: Math.hypot(ball.vx, ball.vy),
        spin: ball.spin,
        heading: Math.atan2(ball.vy, ball.vx),
        ownerId: ball.ownerId,
      },
      controlled: snapshot.controlled,
      passTarget: snapshot.passTarget,
      phase: snapshot.phase,
      score: snapshot.score,
      timeLeftMs: Math.max(0, snapshot.timeLeftMs - aheadSec * 1000),
      countdownMs: Math.max(0, snapshot.countdownMs - aheadSec * 1000),
      stats: snapshot.stats ?? null,
      ready: true,
    };
  }
}

export function emptyFrame(): MatchFrame {
  return {
    players: [],
    ball: { x: 0, y: 0, speed: 0, spin: 0, heading: 0, ownerId: null },
    controlled: { left: "", right: "" },
    passTarget: { left: null, right: null },
    phase: "waiting",
    score: { left: 0, right: 0 },
    timeLeftMs: 0,
    countdownMs: 0,
    stats: null,
    ready: false,
  };
}

export { lerp, lerpAngle };
