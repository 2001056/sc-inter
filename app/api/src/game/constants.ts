/**
 * 경기장·물리 상수. 서버가 유일한 권위이며 프런트는 렌더링 스케일로만 쓴다.
 * 단위는 실제 사람 기준의 미터/초다(3D 렌더러가 그대로 월드 단위로 쓸 수 있게).
 */

/** 5인제 규모의 소형 경기장. 실제 사람 비율과 카메라 워크를 고려한 크기. */
export const PITCH = {
  length: 64,
  width: 42,
  /** 정규 골대 폭 7.32m */
  goalWidth: 7.32,
  goalDepth: 2,
} as const;

export const PLAYER = {
  /** 어깨 폭 기준 충돌 반지름 */
  radius: 0.45,
  /** 렌더러가 참고하는 키 */
  height: 1.82,
  accel: 48,
  runSpeed: 6.6,
  sprintSpeed: 9.1,
  drag: 4.2,
  mass: 78,
} as const;

export const BALL = {
  radius: 0.11,
  mass: 0.43,
  /** 잔디 마찰 (속도에 비례) */
  drag: 0.52,
  maxSpeed: 34,
  wallRestitution: 0.58,
} as const;

export const KICK = {
  /** 발이 닿는 추가 사거리 */
  reach: 0.55,
  minPower: 9,
  maxPower: 26,
  /** 최대 충전까지 걸리는 시간 */
  chargeMs: 700,
  /** 킥에 실리는 선수 속도 비율 */
  carry: 0.35,
  cooldownMs: 320,
} as const;

/** 볼 컨트롤(드리블): 공을 발 앞에 붙여 두는 부드러운 유도력 */
export const DRIBBLE = {
  /** 이 거리 안에 공이 있으면 컨트롤 중으로 본다 */
  range: 1.5,
  /** 공을 두고 싶은 발 앞 거리 */
  leadDistance: 0.85,
  /** 유도 강성 */
  stiffness: 14,
  /** 스프린트 중에는 컨트롤이 느슨해진다 */
  sprintLooseness: 0.55,
} as const;

export const STAMINA = {
  /** 초당 소모 (스프린트 중) */
  sprintDrain: 0.26,
  /** 초당 회복 */
  regen: 0.14,
  /** 개인기 1회 소모 */
  stepoverCost: 0.1,
  slideCost: 0.16,
  /** 이 아래로는 스프린트 불가 */
  sprintFloor: 0.06,
} as const;

/** 개인기 */
export const SKILL = {
  stepover: {
    durationMs: 380,
    cooldownMs: 3200,
    /** 옆으로 치고 나가는 순간 속도 */
    burstSpeed: 8.4,
    /** 이 거리 안의 상대를 흔든다 */
    beatRange: 2.6,
    /** 흔들린 상대의 감속 시간 */
    staggerMs: 620,
  },
  slide: {
    durationMs: 520,
    cooldownMs: 5200,
    burstSpeed: 10.5,
    /** 이 거리 안의 공을 걷어낸다 */
    reach: 1.5,
    /** 걷어낸 공에 실리는 속도 */
    poke: 13,
    /** 태클 후 일어나는 시간 */
    proneMs: 900,
  },
  /** 흔들린 선수의 속도 배율 */
  staggerSpeedScale: 0.45,
} as const;

export const MATCH = {
  tickHz: 60,
  broadcastHz: 20,
  durationMs: 120_000,
  kickoffCountdownMs: 3_000,
  goalCelebrationMs: 1_800,
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
  left: { x: PITCH.length * 0.3, y: PITCH.width / 2 },
  right: { x: PITCH.length * 0.7, y: PITCH.width / 2 },
};

export const GOAL_TOP = (PITCH.width - PITCH.goalWidth) / 2;
export const GOAL_BOTTOM = GOAL_TOP + PITCH.goalWidth;
