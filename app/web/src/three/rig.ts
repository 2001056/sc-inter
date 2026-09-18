/**
 * 축구 선수 한 명의 뼈대.
 *
 * 기준 키는 1.80m 이고 각 관절 높이는 실제 성인 남성 비율을 따른다(머리 하나가
 * 키의 약 1/7.5). 모델은 로컬 좌표에서 +Z 를 바라본 차렷 자세로 세워 두고,
 * 실제 방향은 씬에서 `rotation.y` 로 돌린다.
 *
 * 여기서는 "월드 기준 관절 위치" 만 적는다. 부모 기준 로컬 오프셋은
 * `buildSkeleton` 이 부모 위치를 빼서 계산하므로, 비율을 손볼 때는 이 표만 고치면 된다.
 */
import * as THREE from "three";

export const MODEL_HEIGHT = 1.8;

export interface BoneSpec {
  name: string;
  parent: string | null;
  /** 차렷 자세에서의 관절 위치(미터). y 는 발바닥 0 기준. */
  rest: [number, number, number];
}

/**
 * 좌우 대칭이라 왼쪽만 적고 오른쪽은 x 부호를 뒤집어 자동으로 만든다.
 * 이름 규칙은 `...L` / `...R`.
 */
const SPINE: BoneSpec[] = [
  { name: "hips", parent: null, rest: [0, 0.98, 0] },
  { name: "spine", parent: "hips", rest: [0, 1.08, 0] },
  { name: "chest", parent: "spine", rest: [0, 1.22, 0] },
  { name: "upperChest", parent: "chest", rest: [0, 1.34, 0] },
  { name: "neck", parent: "upperChest", rest: [0, 1.47, 0] },
  { name: "head", parent: "neck", rest: [0, 1.55, 0] },
];

const LEFT_LIMBS: BoneSpec[] = [
  { name: "shoulderL", parent: "upperChest", rest: [0.055, 1.44, 0] },
  { name: "upperArmL", parent: "shoulderL", rest: [0.2, 1.42, 0] },
  { name: "lowerArmL", parent: "upperArmL", rest: [0.2, 1.13, 0] },
  { name: "handL", parent: "lowerArmL", rest: [0.2, 0.87, 0] },
  { name: "upperLegL", parent: "hips", rest: [0.095, 0.935, 0] },
  { name: "lowerLegL", parent: "upperLegL", rest: [0.095, 0.495, 0] },
  { name: "footL", parent: "lowerLegL", rest: [0.095, 0.085, 0] },
  { name: "toeL", parent: "footL", rest: [0.095, 0.03, 0.15] },
];

function mirror(spec: BoneSpec): BoneSpec {
  const flip = (name: string) => (name.endsWith("L") ? `${name.slice(0, -1)}R` : name);
  return {
    name: flip(spec.name),
    parent: spec.parent === null ? null : flip(spec.parent),
    rest: [-spec.rest[0], spec.rest[1], spec.rest[2]],
  };
}

export const BONE_SPECS: BoneSpec[] = [...SPINE, ...LEFT_LIMBS, ...LEFT_LIMBS.map(mirror)];

export const REST_POSITION = new Map<string, THREE.Vector3>(
  BONE_SPECS.map((spec) => [spec.name, new THREE.Vector3(...spec.rest)]),
);

/** 뼈 하나가 "담당하는" 구간. 스킨 가중치를 거리로 구할 때 쓴다. */
export const BONE_SEGMENT = new Map<string, { a: THREE.Vector3; b: THREE.Vector3 }>();
{
  const childOf = new Map<string, string>();
  for (const spec of BONE_SPECS) {
    if (spec.parent && !childOf.has(spec.parent)) childOf.set(spec.parent, spec.name);
  }
  for (const spec of BONE_SPECS) {
    const a = REST_POSITION.get(spec.name)!;
    const childName = childOf.get(spec.name);
    // 말단 뼈(손·발끝·머리)는 자식이 없으니 짧은 가상 구간을 준다.
    const b = childName
      ? REST_POSITION.get(childName)!
      : a.clone().add(new THREE.Vector3(0, spec.name === "head" ? 0.12 : -0.06, 0));
    BONE_SEGMENT.set(spec.name, { a: a.clone(), b: b.clone() });
  }
}

export interface BuiltSkeleton {
  root: THREE.Bone;
  bones: THREE.Bone[];
  byName: Map<string, THREE.Bone>;
  skeleton: THREE.Skeleton;
  /** `bones` 배열에서의 위치. 스킨 인덱스를 채울 때 쓴다. */
  indexOf: Map<string, number>;
}

export function buildSkeleton(): BuiltSkeleton {
  const byName = new Map<string, THREE.Bone>();
  const bones: THREE.Bone[] = [];
  const indexOf = new Map<string, number>();

  for (const spec of BONE_SPECS) {
    const bone = new THREE.Bone();
    bone.name = spec.name;
    byName.set(spec.name, bone);
    indexOf.set(spec.name, bones.length);
    bones.push(bone);
  }

  for (const spec of BONE_SPECS) {
    const bone = byName.get(spec.name)!;
    const rest = REST_POSITION.get(spec.name)!;
    if (spec.parent) {
      const parent = byName.get(spec.parent)!;
      const parentRest = REST_POSITION.get(spec.parent)!;
      bone.position.copy(rest).sub(parentRest);
      parent.add(bone);
    } else {
      bone.position.copy(rest);
    }
  }

  const root = byName.get("hips")!;
  // Skeleton 이 bind 역행렬을 뽑으려면 차렷 자세의 월드 행렬이 최신이어야 한다.
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton(bones);

  return { root, bones, byName, skeleton, indexOf };
}

/** 애니메이션이 매 프레임 덮어쓰는 뼈 회전값의 초기 상태. */
export function resetPose(byName: Map<string, THREE.Bone>): void {
  for (const bone of byName.values()) bone.rotation.set(0, 0, 0);
}
