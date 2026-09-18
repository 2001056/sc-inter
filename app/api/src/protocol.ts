/**
 * 서버-클라이언트 wire 계약 (단일 원본).
 *
 * 프런트엔드(Three.js 3D)와 백엔드가 공유하는 유일한 계약이다.
 * 좌표계는 미터 단위의 평면이며 `x` 는 경기장 길이 방향(0 -> 왼쪽 골대에서 오른쪽 골대),
 * `y` 는 경기장 폭 방향(0 -> 60도 회전 없이 위에서 내려다본 위쪽)이다.
 * 3D 렌더러는 `(x, y)` 를 `(x, z)` 로 매핑하고 높이 축은 스스로 만든다(공은 항상 지면 위).
 */
import type { Side } from "./game/constants.ts";

export type Phase = "waiting" | "countdown" | "playing" | "goal" | "ended";
export type RoomMode = "versus" | "practice";
export type MatchResult = "left" | "right" | "draw";

/** 선수가 지금 쓰고 있는 개인기. 서버가 판정한 결과만 내려간다. */
export type SkillKind = "stepover" | "slide";

/** 3D 애니메이션 클립 선택용 상태. 서버가 확정해 양쪽 화면이 같은 동작을 본다. */
export type AnimState =
  | "idle"
  | "run"
  | "sprint"
  | "dribble"
  | "kick"
  | "stepover"
  | "slide"
  | "prone"
  | "celebrate";

export type ErrorCode =
  | "BAD_MESSAGE"
  | "INVALID_NICKNAME"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "NOT_IN_ROOM"
  | "TOKEN_INVALID"
  | "RATE_LIMITED"
  | "SERVER_BUSY";

export interface InputState {
  seq: number;
  /** 이동 축. -1~1. 길이가 1을 넘으면 서버가 정규화한다. */
  ax: number;
  ay: number;
  /** 슛 버튼을 누르고 있는지. 떼는 순간 충전량만큼 찬다. */
  kick: boolean;
  /** 스프린트 버튼을 누르고 있는지. 스태미나를 소모한다. */
  sprint: boolean;
  /** 이번 입력에서 새로 시도한 개인기. 누르는 순간 한 번만 보낸다. */
  skill: SkillKind | null;
}

export type ClientMessage =
  | { t: "create"; nickname: string }
  | { t: "join"; nickname: string; code: string }
  | { t: "practice"; nickname: string }
  | { t: "resume"; token: string }
  | ({ t: "input" } & InputState)
  | { t: "rematch" }
  | { t: "leave" }
  | { t: "ping"; ts: number };

export interface PlayerMeta {
  side: Side;
  nickname: string;
  connected: boolean;
  rematchReady: boolean;
  bot: boolean;
}

export interface Score {
  left: number;
  right: number;
}

/** 스냅샷에 담기는 선수 한 명. 모든 길이는 미터, 속도는 m/s, 각도는 라디안이다. */
export interface PlayerView {
  side: Side;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 바라보는 방향(라디안). atan2(dy, dx) 규약. */
  facing: number;
  /** 0~1 슛 충전량 */
  charge: number;
  /** 0~1 남은 스태미나 */
  stamina: number;
  /** 지금 공을 발 앞에 두고 몰고 있는지 */
  dribbling: boolean;
  /** 진행 중인 개인기와 남은 시간(ms) */
  skill: SkillKind | null;
  skillMs: number;
  /** 개인기 쿨다운 남은 시간(ms). 프런트 HUD 용. */
  cooldowns: { stepover: number; slide: number };
  anim: AnimState;
}

export interface BallView {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 회전 표현용 누적 각도(라디안) */
  spin: number;
}

export interface Snapshot {
  t: "snapshot";
  tick: number;
  /** 서버 기준 시각(ms). 보간 기준으로만 쓴다. */
  ts: number;
  phase: Phase;
  ball: BallView;
  players: PlayerView[];
  score: Score;
  timeLeftMs: number;
  countdownMs: number;
}

export type ServerEvent =
  | { t: "event"; kind: "goal"; side: Side; score: Score }
  | { t: "event"; kind: "kickoff" }
  | { t: "event"; kind: "matchEnd"; result: MatchResult; score: Score }
  | { t: "event"; kind: "kick"; side: Side; power: number }
  | { t: "event"; kind: "skill"; side: Side; skill: SkillKind; beat: boolean }
  | { t: "event"; kind: "opponentJoined"; nickname: string }
  | { t: "event"; kind: "opponentLeft" }
  | { t: "event"; kind: "opponentDisconnected" }
  | { t: "event"; kind: "opponentReconnected" }
  | { t: "event"; kind: "serverShutdown" };

/** 경기장 치수. 프런트가 하드코딩하지 않도록 접속 직후 한 번 내려준다. */
export interface PitchInfo {
  length: number;
  width: number;
  goalWidth: number;
  goalDepth: number;
  playerRadius: number;
  playerHeight: number;
  ballRadius: number;
}

export type ServerMessage =
  | {
      t: "joined";
      token: string;
      code: string;
      side: Side;
      mode: RoomMode;
      pitch: PitchInfo;
    }
  | {
      t: "room";
      code: string;
      mode: RoomMode;
      phase: Phase;
      players: PlayerMeta[];
      score: Score;
      timeLeftMs: number;
      countdownMs: number;
      result: MatchResult | null;
    }
  | Snapshot
  | ServerEvent
  | { t: "error"; code: ErrorCode; message: string }
  | { t: "pong"; ts: number };
