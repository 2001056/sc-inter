/**
 * 서버-클라이언트 wire 계약 (단일 원본).
 *
 * 프런트엔드(Three.js 3D)와 백엔드가 공유하는 유일한 계약이다.
 * 좌표계는 미터 단위의 평면이며 `x` 는 경기장 길이 방향(0 = 왼쪽 골라인),
 * `y` 는 경기장 폭 방향이다. 3D 렌더러는 `(x, y)` 를 `(x, z)` 로 매핑한다.
 *
 * 입력은 **키가 아니라 의도**를 보낸다. 어떤 키를 어떤 의도에 묶을지는 프런트가 정하므로
 * 키 매핑이 바뀌어도 이 계약은 바뀌지 않는다.
 */
import type { Role, Side } from "./game/constants.ts";

export type { Role, Side };

export type Phase = "waiting" | "countdown" | "playing" | "goal" | "ended";
export type RoomMode = "versus" | "practice";
export type MatchResult = "left" | "right" | "draw";

/**
 * 서버가 판정한 개인기.
 * 클라이언트는 방향 벡터만 보내고, 서버가 그 팀의 공격 방향 기준으로
 * 앞(stepover) / 좌우(feint) / 뒤(dragback) 를 정한다.
 */
export type SkillKind = "stepover" | "feintLeft" | "feintRight" | "dragback" | "tackle";

/** 3D 애니메이션 클립 선택용 상태. 서버가 확정해 양쪽 화면이 같은 동작을 본다. */
export type AnimState =
  | "idle"
  | "run"
  | "sprint"
  | "dribble"
  | "shoot"
  | "pass"
  | "stepover"
  | "feintLeft"
  | "feintRight"
  | "dragback"
  | "tackle"
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

/** 월드 좌표의 방향(정규화는 서버가 한다). */
export interface Vec2 {
  x: number;
  y: number;
}

export interface InputState {
  seq: number;
  /** 이동 축. 월드 좌표 -1~1. 길이가 1을 넘으면 서버가 정규화한다. */
  ax: number;
  ay: number;
  /** 달리기: 누르고 있는 동안 true. 스태미나를 소모한다. */
  sprint: boolean;
  /** 슛: 누르고 있는 동안 true. 떼는 순간 충전량만큼 강하게 찬다. */
  shoot: boolean;
  /** 패스: 누르는 순간 한 번만 true. 앞쪽 동료에게 땅볼로 준다. */
  pass: boolean;
  /** 태클: 누르는 순간 한 번만 true. */
  tackle: boolean;
  /** 개인기: 누르는 순간 한 번만, 월드 좌표 방향 벡터를 담는다. */
  skillDir: Vec2 | null;
  /** 조작 선수 수동 전환: 누르는 순간 한 번만 true. */
  switchPlayer: boolean;
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

/** 스냅샷에 담기는 선수 한 명. 길이는 미터, 속도는 m/s, 각도는 라디안이다. */
export interface PlayerView {
  /** 경기 내내 고정된 식별자. 예: "L1" "R3" */
  id: string;
  side: Side;
  role: Role;
  /** 이 선수를 사람이 조작하고 있는지(팀마다 한 명) */
  controlled: boolean;
  /** 사람이 조작 중인 팀 소속인지 (false 면 AI 팀) */
  human: boolean;
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
  /** 남은 쿨다운(ms). 이동 개인기는 공유한다. */
  cooldowns: { skill: number; tackle: number };
  anim: AnimState;
}

export interface BallView {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 회전 표현용 누적 각도(라디안) */
  spin: number;
  /** 지금 공을 소유한 선수 id (없으면 null) */
  ownerId: string | null;
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
  /** 각 팀에서 지금 사람이 조작 중인 선수 id */
  controlled: { left: string; right: string };
  /** 내가 패스하면 받을 가능성이 가장 높은 동료 id (각 팀 기준) */
  passTarget: { left: string | null; right: string | null };
}

export type ServerEvent =
  | { t: "event"; kind: "goal"; side: Side; scorerId: string; score: Score }
  | { t: "event"; kind: "kickoff" }
  | { t: "event"; kind: "matchEnd"; result: MatchResult; score: Score }
  | { t: "event"; kind: "shoot"; playerId: string; power: number }
  | { t: "event"; kind: "pass"; playerId: string; targetId: string | null }
  | { t: "event"; kind: "skill"; playerId: string; skill: SkillKind; beat: boolean }
  | { t: "event"; kind: "control"; side: Side; playerId: string }
  | { t: "event"; kind: "opponentJoined"; nickname: string }
  | { t: "event"; kind: "opponentLeft" }
  | { t: "event"; kind: "opponentDisconnected" }
  | { t: "event"; kind: "opponentReconnected" }
  | { t: "event"; kind: "serverShutdown" };

/** 경기장 치수와 규모. 프런트가 하드코딩하지 않도록 접속 직후 한 번 내려준다. */
export interface PitchInfo {
  length: number;
  width: number;
  goalWidth: number;
  goalDepth: number;
  playerRadius: number;
  playerHeight: number;
  ballRadius: number;
  teamSize: number;
  /** 쿨다운 게이지 상한(ms) */
  skillCooldownMs: number;
  tackleCooldownMs: number;
  /** 슛 최대 충전 시간(ms) */
  shootChargeMs: number;
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
