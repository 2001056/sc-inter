/** 경기장·물리 상수. 서버가 유일한 권위이며 웹은 이 값을 렌더링에만 사용한다. */
export const FIELD = {
  width: 1050,
  height: 640,
  goalHeight: 208,
  goalDepth: 34,
} as const;

export const PLAYER = {
  radius: 21,
  accel: 2600,
  maxSpeed: 385,
  drag: 6.2,
  mass: 3.2,
} as const;

export const BALL = {
  radius: 12,
  drag: 0.62,
  maxSpeed: 1450,
  wallRestitution: 0.72,
  mass: 1,
} as const;

export const KICK = {
  /** 발이 닿는 추가 사거리 */
  reach: 20,
  power: 760,
  /** 킥에 실리는 선수 속도 비율 */
  carry: 0.45,
  cooldownMs: 340,
} as const;

export const MATCH = {
  tickHz: 60,
  broadcastHz: 20,
  durationMs: 120_000,
  kickoffCountdownMs: 3_000,
  goalCelebrationMs: 1_200,
} as const;

export const ROOM = {
  /** 접속이 끊긴 선수의 자리를 비워두는 시간 */
  reconnectGraceMs: 30_000,
  /** 모두 비어 있는 방을 정리하기까지의 시간 */
  emptyRoomTtlMs: 60_000,
  /** 아무 활동이 없는 방을 정리하기까지의 시간 */
  idleRoomTtlMs: 20 * 60_000,
  maxRooms: 500,
  maxPlayers: 2,
} as const;

export type Side = "left" | "right";

export const SPAWN: Record<Side, { x: number; y: number }> = {
  left: { x: FIELD.width * 0.25, y: FIELD.height / 2 },
  right: { x: FIELD.width * 0.75, y: FIELD.height / 2 },
};

export const GOAL_TOP = (FIELD.height - FIELD.goalHeight) / 2;
export const GOAL_BOTTOM = GOAL_TOP + FIELD.goalHeight;
