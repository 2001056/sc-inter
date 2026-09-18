/**
 * 방 관리. 시뮬레이션과 네트워크를 잇는 층이다.
 * 하나의 전역 루프가 모든 방을 같은 틱으로 진행한다.
 */
import { randomBytes } from "node:crypto";
import {
  BALL,
  MATCH,
  PITCH,
  PLAYER,
  ROOM,
  SHOOT,
  SKILL,
  TEAM_SIZE,
  type Side,
} from "./constants.ts";
import { Match, neutralInput } from "./sim.ts";
import type {
  InputState,
  PitchInfo,
  PlayerMeta,
  RoomMode,
  ServerMessage,
} from "../protocol.ts";

export const PITCH_INFO: PitchInfo = {
  length: PITCH.length,
  width: PITCH.width,
  goalWidth: PITCH.goalWidth,
  goalDepth: PITCH.goalDepth,
  playerRadius: PLAYER.radius,
  playerHeight: PLAYER.height,
  ballRadius: BALL.radius,
  teamSize: TEAM_SIZE,
  skillCooldownMs: SKILL.moveCooldownMs,
  tackleCooldownMs: SKILL.tackle.cooldownMs,
  shootChargeMs: SHOOT.chargeMs,
};

export interface ClientConn {
  readonly id: string;
  send(msg: ServerMessage): void;
  close(): void;
}

interface Seat {
  side: Side;
  nickname: string;
  token: string;
  conn: ClientConn | null;
  /** 사람이 앉지 않고 AI 가 맡은 자리(연습 모드) */
  bot: boolean;
  rematchReady: boolean;
  disconnectedAt: number | null;
}

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function makeRoomCode(): string {
  const bytes = randomBytes(6);
  let out = "";
  for (let i = 0; i < 6; i += 1) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return out;
}

function makeToken(): string {
  return randomBytes(16).toString("hex");
}

export class Room {
  readonly match = new Match();
  readonly seats = new Map<Side, Seat>();
  lastActivityAt = Date.now();
  private emptySince: number | null = null;
  private accumulatorMs = 0;
  private sinceBroadcastMs = 0;

  readonly code: string;
  readonly mode: RoomMode;

  constructor(code: string, mode: RoomMode) {
    this.code = code;
    this.mode = mode;
  }

  get occupiedSides(): Side[] {
    return [...this.seats.keys()];
  }

  get humanCount(): number {
    let n = 0;
    for (const seat of this.seats.values()) if (seat.bot === false) n += 1;
    return n;
  }

  get isFull(): boolean {
    return this.seats.size >= ROOM.maxPlayers;
  }

  freeSide(): Side | null {
    if (!this.seats.has("left")) return "left";
    if (!this.seats.has("right")) return "right";
    return null;
  }

  seatOfConn(conn: ClientConn): Seat | null {
    for (const seat of this.seats.values()) {
      if (seat.conn === conn) return seat;
    }
    return null;
  }

  addHuman(conn: ClientConn, nickname: string): Seat | null {
    const side = this.freeSide();
    if (side === null) return null;
    const seat: Seat = {
      side,
      nickname,
      token: makeToken(),
      conn,
      bot: false,
      rematchReady: false,
      disconnectedAt: null,
    };
    this.seats.set(side, seat);
    this.match.humanSides[side] = true;
    this.emptySince = null;
    this.touch();
    return seat;
  }

  addBot(side: Side): void {
    this.seats.set(side, {
      side,
      nickname: "AI 팀",
      token: makeToken(),
      conn: null,
      bot: true,
      rematchReady: true,
      disconnectedAt: null,
    });
    this.match.humanSides[side] = false;
  }

  resume(token: string, conn: ClientConn): Seat | null {
    for (const seat of this.seats.values()) {
      if (seat.token === token && seat.bot === false) {
        seat.conn = conn;
        seat.disconnectedAt = null;
        this.emptySince = null;
        this.match.resetInputSeq(seat.side);
        this.touch();
        return seat;
      }
    }
    return null;
  }

  detach(conn: ClientConn): Seat | null {
    const seat = this.seatOfConn(conn);
    if (seat === null) return null;
    seat.conn = null;
    seat.disconnectedAt = Date.now();
    if (this.humanConnectedCount() === 0) this.emptySince = Date.now();
    return seat;
  }

  removeSeat(side: Side): void {
    this.seats.delete(side);
    this.match.humanSides[side] = false;
    if (this.humanConnectedCount() === 0) this.emptySince = Date.now();
    this.touch();
  }

  humanConnectedCount(): number {
    let n = 0;
    for (const seat of this.seats.values()) {
      if (seat.bot === false && seat.conn !== null) n += 1;
    }
    return n;
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  setInput(side: Side, input: InputState): void {
    this.match.setInput(side, input);
    this.touch();
  }

  /** 두 자리가 다 차면 킥오프한다. */
  maybeStart(): boolean {
    if (this.match.phase !== "waiting") return false;
    if (this.seats.size < ROOM.maxPlayers) return false;
    this.match.startMatch();
    return true;
  }

  setRematch(side: Side, ready: boolean): boolean {
    const seat = this.seats.get(side);
    if (!seat) return false;
    seat.rematchReady = ready;
    this.touch();
    if (this.match.phase !== "ended") return false;
    for (const s of this.seats.values()) if (!s.rematchReady) return false;
    if (this.seats.size < ROOM.maxPlayers) return false;
    for (const s of this.seats.values()) s.rematchReady = false;
    this.match.startMatch();
    return true;
  }

  metaPlayers(): PlayerMeta[] {
    const out: PlayerMeta[] = [];
    for (const side of ["left", "right"] as const) {
      const seat = this.seats.get(side);
      if (!seat) continue;
      out.push({
        side,
        nickname: seat.nickname,
        connected: seat.bot || seat.conn !== null,
        rematchReady: seat.rematchReady,
        bot: seat.bot,
      });
    }
    return out;
  }

  roomMessage(): ServerMessage {
    return {
      t: "room",
      code: this.code,
      mode: this.mode,
      phase: this.match.phase,
      players: this.metaPlayers(),
      score: { ...this.match.score },
      timeLeftMs: Math.max(0, Math.round(this.match.timeLeftMs)),
      countdownMs: Math.max(0, Math.round(this.match.countdownMs)),
      result: this.match.result,
    };
  }

  broadcast(msg: ServerMessage, except?: ClientConn): void {
    for (const seat of this.seats.values()) {
      if (seat.conn === null || seat.conn === except) continue;
      seat.conn.send(msg);
    }
  }

  sendTo(side: Side, msg: ServerMessage): void {
    this.seats.get(side)?.conn?.send(msg);
  }

  opponentSide(side: Side): Side {
    return side === "left" ? "right" : "left";
  }

  /** 경과 시간만큼 시뮬레이션을 돌리고 필요하면 브로드캐스트한다. */
  advance(elapsedMs: number, now: number): void {
    const stepMs = 1000 / MATCH.tickHz;
    const broadcastEveryMs = 1000 / MATCH.broadcastHz;
    this.accumulatorMs = Math.min(this.accumulatorMs + elapsedMs, stepMs * 5);

    while (this.accumulatorMs >= stepMs) {
      this.accumulatorMs -= stepMs;
      for (const seat of this.seats.values()) {
        if (!seat.bot && seat.conn === null) {
          // 접속이 끊긴 사람의 선수는 손을 놓은 상태로 둔다
          this.match.forceInput(seat.side, neutralInput());
        }
      }
      const events = this.match.step(stepMs / 1000);
      for (const ev of events) {
        switch (ev.kind) {
          case "goal":
            this.broadcast({
              t: "event",
              kind: "goal",
              side: ev.side,
              scorerId: ev.scorerId,
              score: ev.score,
            });
            this.broadcast(this.roomMessage());
            break;
          case "kickoff":
            this.broadcast({ t: "event", kind: "kickoff" });
            this.broadcast(this.roomMessage());
            break;
          case "matchEnd":
            this.broadcast({
              t: "event",
              kind: "matchEnd",
              result: ev.result,
              score: ev.score,
            });
            this.broadcast(this.roomMessage());
            break;
          case "shoot":
            this.broadcast({
              t: "event",
              kind: "shoot",
              playerId: ev.playerId,
              power: ev.power,
            });
            break;
          case "pass":
            this.broadcast({
              t: "event",
              kind: "pass",
              playerId: ev.playerId,
              targetId: ev.targetId,
            });
            break;
          case "skill":
            this.broadcast({
              t: "event",
              kind: "skill",
              playerId: ev.playerId,
              skill: ev.skill,
              beat: ev.beat,
            });
            break;
          case "control":
            this.broadcast({
              t: "event",
              kind: "control",
              side: ev.side,
              playerId: ev.playerId,
            });
            break;
        }
      }
    }

    this.sinceBroadcastMs += elapsedMs;
    if (this.sinceBroadcastMs >= broadcastEveryMs) {
      this.sinceBroadcastMs = 0;
      if (this.match.phase !== "waiting") {
        this.broadcast(this.match.snapshot(now));
      }
    }
  }

  /** 정리해도 되는 방인지 */
  isDisposable(now: number): boolean {
    if (this.humanConnectedCount() > 0) return false;
    if (this.emptySince !== null && now - this.emptySince > ROOM.emptyRoomTtlMs) return true;
    return now - this.lastActivityAt > ROOM.idleRoomTtlMs;
  }

  /** 재접속 유예가 끝난 자리를 비운다. 비운 자리가 있으면 true. */
  expireDisconnected(now: number): Side[] {
    const expired: Side[] = [];
    for (const seat of [...this.seats.values()]) {
      if (
        seat.bot === false &&
        seat.conn === null &&
        seat.disconnectedAt !== null &&
        now - seat.disconnectedAt > ROOM.reconnectGraceMs
      ) {
        this.seats.delete(seat.side);
        this.match.humanSides[seat.side] = false;
        expired.push(seat.side);
      }
    }
    if (expired.length > 0 && this.humanConnectedCount() === 0) this.emptySince = Date.now();
    return expired;
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();

  get size(): number {
    return this.rooms.size;
  }

  get atCapacity(): boolean {
    return this.rooms.size >= ROOM.maxRooms;
  }

  create(mode: RoomMode): Room {
    let code = makeRoomCode();
    while (this.rooms.has(code)) code = makeRoomCode();
    const room = new Room(code, mode);
    this.rooms.set(code, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  delete(code: string): void {
    this.rooms.delete(code);
  }

  all(): Room[] {
    return [...this.rooms.values()];
  }

  /** 유예가 끝난 자리와 버려진 방을 정리한다. */
  sweep(now: number, onSeatExpired: (room: Room, side: Side) => void): void {
    for (const room of this.all()) {
      for (const side of room.expireDisconnected(now)) onSeatExpired(room, side);
      if (room.isDisposable(now)) this.rooms.delete(room.code);
    }
  }
}
