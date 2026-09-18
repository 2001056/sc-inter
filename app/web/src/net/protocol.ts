/**
 * 서버-클라이언트 wire 계약의 프런트엔드 사본.
 *
 * 원본(SSOT)은 `app/api/src/protocol.ts` 이고, 워크스페이스 패키지 경계를 넘는
 * import 를 만들지 않으려고 타입만 그대로 옮겼다. 서버 계약이 바뀌면 이 파일도
 * 같은 커밋에서 함께 고친다. 지금 사본은 3대3 계약 기준이다.
 *
 * 입력은 키가 아니라 **의도**를 보낸다. 방향키·S·D·E·Shift 라는 배치는 프런트만
 * 알고 있으며, 서버는 이동/슛/패스/달리기/개인기 방향만 받는다.
 *
 * 좌표계: 미터 단위 평면. `x` 는 경기장 길이 방향(0 = 왼쪽 골라인),
 * `y` 는 경기장 폭 방향. 3D 렌더러가 `(x, y)` 를 `(x, z)` 로 매핑한다.
 */

export type Side = "left" | "right";
export type Role = "defender" | "mid" | "forward";
export type Phase = "waiting" | "countdown" | "playing" | "goal" | "ended";
export type RoomMode = "versus" | "practice";
export type MatchResult = "left" | "right" | "draw";

/**
 * 서버가 판정한 개인기. 프런트는 방향 벡터만 보내고, 어느 기술인지는 서버가
 * 그 팀의 공격 방향을 기준으로 정한다(앞 = 스텝오버, 좌우 = 바디페인트, 뒤 = 드래그백).
 */
export type SkillKind = "stepover" | "feintLeft" | "feintRight" | "dragback" | "tackle";

export const SKILL_LABEL: Record<SkillKind, string> = {
  stepover: "스텝오버",
  feintLeft: "왼쪽 바디페인트",
  feintRight: "오른쪽 바디페인트",
  dragback: "드래그백",
  tackle: "태클",
};

/** 3D 애니메이션 상태. 서버가 확정해 양쪽 화면이 같은 동작을 본다. */
export type AnimState =
  | "idle"
  | "run"
  | "sprint"
  | "dribble"
  | "shoot"
  | "pass"
  | "stepover"
  | "feint"
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
  /** 달리기(E): 누르고 있는 동안 true. 스태미나를 소모한다. */
  sprint: boolean;
  /** 슛(D): 누르고 있는 동안 true. 떼는 순간 충전량만큼 강하게 찬다. */
  shoot: boolean;
  /** 패스(S): 누르는 순간 한 번만 true. */
  pass: boolean;
  /** 태클(Q): 누르는 순간 한 번만 true. */
  tackle: boolean;
  /** 개인기(Shift+방향키): 누르는 순간 한 번만, 월드 좌표 방향 벡터. */
  skillDir: Vec2 | null;
  /** 조작 선수 수동 전환(C): 누르는 순간 한 번만 true. */
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

/** 스냅샷에 담기는 선수 한 명. 길이는 미터, 속도는 m/s, 각도는 라디안. */
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
  /** 남은 쿨다운(ms). 이동 개인기는 한 게이지를 공유한다. */
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
  /** 패스하면 받을 가능성이 가장 높은 동료 id (각 팀 기준) */
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

/** 경기장 치수와 규모. 프런트가 하드코딩하지 않도록 접속 직후 한 번 내려온다. */
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

export interface JoinedMessage {
  t: "joined";
  token: string;
  code: string;
  side: Side;
  mode: RoomMode;
  pitch: PitchInfo;
}

export interface RoomMessage {
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

export type ServerMessage =
  | JoinedMessage
  | RoomMessage
  | Snapshot
  | ServerEvent
  | { t: "error"; code: ErrorCode; message: string }
  | { t: "pong"; ts: number };

/**
 * 서버가 `joined` 를 보내기 전까지 쓰는 대체 치수.
 * 실제 값은 반드시 `joined.pitch` 로 덮어쓴다. 로비 프리뷰의 스케일 용도다.
 */
export const FALLBACK_PITCH: PitchInfo = {
  length: 56,
  width: 34,
  goalWidth: 5.5,
  goalDepth: 1.8,
  playerRadius: 0.42,
  playerHeight: 1.8,
  ballRadius: 0.11,
  teamSize: 3,
  skillCooldownMs: 1200,
  tackleCooldownMs: 2500,
  shootChargeMs: 700,
};

export const ERROR_TEXT: Record<ErrorCode, string> = {
  BAD_MESSAGE: "서버가 요청을 이해하지 못했습니다. 새로고침 후 다시 시도해 주세요.",
  INVALID_NICKNAME: "닉네임은 1~12자여야 하고 특수 제어문자를 쓸 수 없습니다.",
  ROOM_NOT_FOUND: "그런 방이 없습니다. 코드를 다시 확인해 주세요.",
  ROOM_FULL: "이미 인원이 찬 방입니다.",
  NOT_IN_ROOM: "방에서 나온 상태입니다. 로비에서 다시 시작해 주세요.",
  TOKEN_INVALID: "재접속 시간이 지났습니다. 로비에서 새로 시작해 주세요.",
  RATE_LIMITED: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  SERVER_BUSY: "서버에 방이 가득 찼습니다. 잠시 후 다시 시도해 주세요.",
};

export const ROLE_LABEL: Record<Role, string> = {
  defender: "수비",
  mid: "미드필더",
  forward: "공격",
};
