/**
 * 경기장·물리 상수. 서버가 유일한 권위이며 프런트는 렌더링 스케일로만 쓴다.
 * 단위는 실제 사람 기준의 미터/초다(3D 렌더러가 그대로 월드 단위로 쓸 수 있게).
 */

/** 한 팀의 인원(사람이 조작하는 1명 + AI 동료 2명). */
export const TEAM_SIZE = 3;

/**
 * 3대3 규모의 경기장. 사람 비율(키 1.8m)과 3D 카메라 워크를 고려했고,
 * 한쪽 끝에서 반대쪽 끝까지 달리면 약 9초가 걸린다.
 */
export const PITCH = {
  length: 56,
  width: 34,
  goalWidth: 5.5,
  goalDepth: 1.8,
} as const;

export const PLAYER = {
  /** 어깨 폭 기준 충돌 반지름 */
  radius: 0.42,
  /** 렌더러가 참고하는 키 */
  height: 1.8,
  accel: 48,
  runSpeed: 6.4,
  sprintSpeed: 9,
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

/** 강하게 차는 슛 (충전식) */
export const SHOOT = {
  /** 발이 닿는 추가 사거리 */
  reach: 0.55,
  minPower: 11,
  maxPower: 27,
  chargeMs: 700,
  /** 슛에 실리는 선수 속도 비율 */
  carry: 0.3,
  cooldownMs: 320,
} as const;

/** 동료에게 굴려 주는 땅볼 패스 (한 번 누름) */
export const PASS = {
  reach: 0.55,
  /** 거리 1m 당 더해지는 속도 */
  speedPerMeter: 0.62,
  minSpeed: 7,
  maxSpeed: 19,
  /** 받는 동료의 진행 방향을 내다보는 시간 */
  leadSeconds: 0.35,
  cooldownMs: 280,
  /** 받을 동료가 없을 때 바라보는 방향으로 나가는 세기 */
  fallbackSpeed: 11,
  /** 이 각도(라디안) 안의 동료만 패스 후보로 본다 */
  maxAngle: 1.5,
  /** 받을 동료가 이 시간 안에 공을 소유하지 못하면 완료되지 않은 패스로 본다 */
  completeWindowMs: 2500,
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
  /** 이동 개인기 1회 소모 */
  skillCost: 0.09,
  tackleCost: 0.16,
  /** 이 아래로는 스프린트 불가 */
  sprintFloor: 0.06,
} as const;

/**
 * 개인기. 클라이언트는 월드 좌표의 방향 벡터만 보내고,
 * 서버가 그 팀의 공격 방향 기준으로 앞/뒤/좌/우를 판정해 동작을 고른다.
 */
export const SKILL = {
  /** 이동 개인기 공통 쿨다운 */
  moveCooldownMs: 2600,
  /** 흔들린 선수의 속도 배율 */
  staggerSpeedScale: 0.45,
  stepover: {
    durationMs: 380,
    burstSpeed: 8.6,
    beatRange: 2.6,
    staggerMs: 620,
  },
  feint: {
    durationMs: 340,
    burstSpeed: 8.2,
    beatRange: 2.8,
    staggerMs: 700,
  },
  dragback: {
    durationMs: 320,
    burstSpeed: 5.6,
    beatRange: 2.2,
    staggerMs: 520,
    /** 공을 함께 끌고 오는 힘 */
    ballPull: 9,
  },
  tackle: {
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
} as const;

export const MATCH = {
  tickHz: 60,
  broadcastHz: 20,
  durationMs: 150_000,
  kickoffCountdownMs: 3_000,
  goalCelebrationMs: 1_800,
  /** 조작 선수가 너무 자주 바뀌지 않게 하는 최소 간격 */
  controlSwitchMs: 450,
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
export type Role = "defender" | "mid" | "forward";

export const ROLES: readonly Role[] = ["defender", "mid", "forward"];

/** 킥오프 대형. 값은 경기장 길이·폭에 대한 비율이다. */
export const FORMATION: Record<Role, { depth: number; lateral: number }> = {
  defender: { depth: 0.14, lateral: 0.5 },
  mid: { depth: 0.3, lateral: 0.26 },
  forward: { depth: 0.44, lateral: 0.58 },
};

/** 역할별 킥오프 위치 */
export function spawnFor(side: Side, role: Role): { x: number; y: number } {
  const f = FORMATION[role];
  const x = side === "left" ? PITCH.length * f.depth : PITCH.length * (1 - f.depth);
  const y = side === "left" ? PITCH.width * f.lateral : PITCH.width * (1 - f.lateral);
  return { x, y };
}

export const GOAL_TOP = (PITCH.width - PITCH.goalWidth) / 2;
export const GOAL_BOTTOM = GOAL_TOP + PITCH.goalWidth;

/** 팀이 공격하는 골라인의 x 좌표 */
export function attackGoalX(side: Side): number {
  return side === "left" ? PITCH.length : 0;
}

/** 팀이 지키는 골라인의 x 좌표 */
export function ownGoalX(side: Side): number {
  return side === "left" ? 0 : PITCH.length;
}

/** 팀이 공격하는 방향의 단위 x 성분 */
export function attackDirX(side: Side): number {
  return side === "left" ? 1 : -1;
}
