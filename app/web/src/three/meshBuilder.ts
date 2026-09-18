/**
 * 뼈에 붙는 살을 코드로 만든다.
 *
 * 외부 모델 파일을 쓰지 않으므로 몸통·팔다리는 "단면을 따라 훑은 관"(generalized
 * cylinder)으로, 머리는 눌린 구로 만든다. 단면이 타원이라 가슴은 넓고 얇게,
 * 허벅지는 둥글게 나온다. 관절 근처 정점은 뼈 두 개에 나눠 물리므로
 * 무릎·팔꿈치가 접힐 때 끊기지 않고 부드럽게 휜다.
 */
import * as THREE from "three";
import { BONE_SEGMENT } from "./rig.ts";

export interface PartBuffers {
  material: string;
  position: number[];
  uv: number[];
  skinIndex: number[];
  skinWeight: number[];
  index: number[];
}

export function emptyPart(material: string): PartBuffers {
  return { material, position: [], uv: [], skinIndex: [], skinWeight: [], index: [] };
}

/** 관을 훑어 갈 단면 하나. `rx` 는 좌우 폭, `rz` 는 앞뒤 두께의 반지름이다. */
export interface Section {
  center: THREE.Vector3;
  rx: number;
  rz: number;
  /** 앞쪽으로 밀어 배를 만들거나 엉덩이를 빼는 데 쓰는 단면 중심 이동. */
  offsetZ?: number;
}

export interface SweepOptions {
  segments?: number;
  /** 시작·끝을 둥근 뚜껑으로 막는다. */
  capStart?: boolean;
  capEnd?: boolean;
  /**
   * 뚜껑이 얼마나 볼록한지(1 = 단면 반지름만큼). 기본 뚜껑은 반구라서 넓은 단면을
   * 막으면 크게 부풀어 오른다. 어깨·엉덩이처럼 납작해야 하는 곳은 값을 낮춘다.
   */
  capDepth?: number;
  /** 끝쪽 뚜껑만 다른 깊이를 쓰고 싶을 때. 없으면 `capDepth` 를 따른다. */
  capDepth2?: number;
  /** v 좌표(길이 방향 UV)의 범위. 유니폼 텍스처를 정확히 얹을 때 쓴다. */
  vRange?: [number, number];
}

const CAP_RINGS = 4;

/** 타원 단면을 등간격으로 잘라 정점 링 하나를 만든다. */
function ring(
  out: number[],
  center: THREE.Vector3,
  normal: THREE.Vector3,
  binormal: THREE.Vector3,
  rx: number,
  rz: number,
  segments: number,
): void {
  for (let i = 0; i <= segments; i += 1) {
    const theta = (i / segments) * Math.PI * 2;
    const cx = Math.cos(theta) * rx;
    const cz = Math.sin(theta) * rz;
    out.push(
      center.x + normal.x * cx + binormal.x * cz,
      center.y + normal.y * cx + binormal.y * cz,
      center.z + normal.z * cx + binormal.z * cz,
    );
  }
}

/**
 * 단면 목록을 따라 관을 만든다. 프레임은 평행 이송(parallel transport)으로 굴리기
 * 때문에 중심선이 휘어도 단면이 꼬이지 않는다.
 */
export function sweep(part: PartBuffers, sections: Section[], options: SweepOptions = {}): void {
  const segments = options.segments ?? 16;
  const [v0, v1] = options.vRange ?? [0, 1];

  const pts = sections.map((s) => {
    const c = s.center.clone();
    if (s.offsetZ) c.z += s.offsetZ;
    return c;
  });

  // 각 단면의 진행 방향.
  const tangents: THREE.Vector3[] = pts.map((_point, i) => {
    const prev = pts[Math.max(0, i - 1)]!;
    const next = pts[Math.min(pts.length - 1, i + 1)]!;
    const t = next.clone().sub(prev);
    if (t.lengthSq() < 1e-12) t.set(0, 1, 0);
    return t.normalize();
  });

  // 첫 프레임은 몸의 좌우축(+X)에 최대한 가깝게 잡는다. 그래야 타원의 rx 가 좌우 폭이 된다.
  let normal = new THREE.Vector3(1, 0, 0);
  const first = tangents[0]!;
  normal.sub(first.clone().multiplyScalar(normal.dot(first)));
  if (normal.lengthSq() < 1e-8) normal.set(0, 0, 1);
  normal.normalize();
  let binormal = new THREE.Vector3().crossVectors(first, normal).normalize();

  const base = part.position.length / 3;
  const rows: { rx: number; rz: number }[] = [];
  const quaternion = new THREE.Quaternion();

  for (let i = 0; i < pts.length; i += 1) {
    if (i > 0) {
      quaternion.setFromUnitVectors(tangents[i - 1]!, tangents[i]!);
      normal = normal.clone().applyQuaternion(quaternion).normalize();
      binormal = new THREE.Vector3().crossVectors(tangents[i]!, normal).normalize();
    }
    const section = sections[i]!;
    ring(part.position, pts[i]!, normal, binormal, section.rx, section.rz, segments);
    rows.push({ rx: section.rx, rz: section.rz });
    const v = v0 + ((v1 - v0) * i) / (pts.length - 1);
    for (let j = 0; j <= segments; j += 1) part.uv.push(j / segments, v);
  }

  // 링과 링 사이를 사각형으로 잇는다.
  for (let i = 0; i < pts.length - 1; i += 1) {
    for (let j = 0; j < segments; j += 1) {
      const a = base + i * (segments + 1) + j;
      const b = a + segments + 1;
      part.index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }

  const capDepth = options.capDepth ?? 1;
  if (options.capStart) {
    capEnd(part, pts[0]!, tangents[0]!.clone().negate(), rows[0]!, segments, v0, capDepth);
  }
  if (options.capEnd) {
    const last = pts.length - 1;
    capEnd(part, pts[last]!, tangents[last]!, rows[last]!, segments, v1, options.capDepth2 ?? capDepth);
  }
}

/** 관 끝을 반타원체 뚜껑으로 막는다. 손끝·발끝·어깨가 잘려 보이지 않게 한다. */
function capEnd(
  part: PartBuffers,
  center: THREE.Vector3,
  outward: THREE.Vector3,
  radii: { rx: number; rz: number },
  segments: number,
  v: number,
  capDepth = 1,
): void {
  const depth = (radii.rx + radii.rz) * 0.5 * capDepth;
  const sections: Section[] = [];
  for (let k = 0; k <= CAP_RINGS; k += 1) {
    const a = (k / CAP_RINGS) * (Math.PI / 2);
    sections.push({
      center: center.clone().add(outward.clone().multiplyScalar(Math.sin(a) * depth)),
      rx: Math.max(1e-4, radii.rx * Math.cos(a)),
      rz: Math.max(1e-4, radii.rz * Math.cos(a)),
    });
  }
  sweep(part, sections, { segments, vRange: [v, v] });
}

/** 머리·손처럼 덩어리로 놓을 부위. 축마다 다르게 눌러 자연스러운 두상을 만든다. */
export function ellipsoid(
  part: PartBuffers,
  center: THREE.Vector3,
  radii: THREE.Vector3,
  options: {
    widthSegments?: number;
    heightSegments?: number;
    shape?: (v: number) => number;
    /** 위(0)에서 아래(1) 중 이 구간만 만든다. 머리카락처럼 덮개만 필요할 때 쓴다. */
    rowRange?: [number, number];
  } = {},
): void {
  const ws = options.widthSegments ?? 20;
  const [r0, r1] = options.rowRange ?? [0, 1];
  const hs = Math.max(2, Math.round((options.heightSegments ?? 14) * (r1 - r0)));
  const base = part.position.length / 3;
  for (let iy = 0; iy <= hs; iy += 1) {
    const v = r0 + (iy / hs) * (r1 - r0);
    const phi = v * Math.PI;
    // shape 로 아래쪽을 좁히면 턱선이 생긴다.
    const taper = options.shape ? options.shape(v) : 1;
    for (let ix = 0; ix <= ws; ix += 1) {
      const u = ix / ws;
      const theta = u * Math.PI * 2;
      part.position.push(
        center.x + radii.x * taper * Math.sin(phi) * Math.cos(theta),
        center.y + radii.y * Math.cos(phi),
        center.z + radii.z * taper * Math.sin(phi) * Math.sin(theta),
      );
      part.uv.push(u, 1 - v);
    }
  }
  for (let iy = 0; iy < hs; iy += 1) {
    for (let ix = 0; ix < ws; ix += 1) {
      const a = base + iy * (ws + 1) + ix;
      const b = a + ws + 1;
      part.index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
}

/**
 * 이 부위의 정점들을 후보 뼈에 물린다.
 *
 * 정점에서 각 뼈 구간까지의 거리를 재서 가장 가까운 두 개에 나눠 준다.
 * 지수를 크게 잡아 영향 범위를 좁히되, 관절 바로 옆에서는 두 뼈가 비슷한
 * 거리라 자연스럽게 반반씩 섞인다.
 */
export function assignSkin(
  part: PartBuffers,
  candidates: string[],
  indexOf: Map<string, number>,
  falloff = 5,
): void {
  const vertexCount = part.position.length / 3;
  const already = part.skinIndex.length / 4;
  const v = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const av = new THREE.Vector3();

  for (let i = already; i < vertexCount; i += 1) {
    v.set(part.position[i * 3]!, part.position[i * 3 + 1]!, part.position[i * 3 + 2]!);

    let bestIdx = 0;
    let bestDist = Infinity;
    let secondIdx = 0;
    let secondDist = Infinity;

    for (const name of candidates) {
      const seg = BONE_SEGMENT.get(name);
      const boneIndex = indexOf.get(name);
      if (!seg || boneIndex === undefined) continue;
      ab.copy(seg.b).sub(seg.a);
      av.copy(v).sub(seg.a);
      const lenSq = ab.lengthSq();
      const t = lenSq > 1e-12 ? Math.max(0, Math.min(1, av.dot(ab) / lenSq)) : 0;
      const d = av.distanceTo(ab.multiplyScalar(t));
      if (d < bestDist) {
        secondDist = bestDist;
        secondIdx = bestIdx;
        bestDist = d;
        bestIdx = boneIndex;
      } else if (d < secondDist) {
        secondDist = d;
        secondIdx = boneIndex;
      }
    }

    const w0 = 1 / (bestDist ** falloff + 1e-9);
    const w1 = Number.isFinite(secondDist) ? 1 / (secondDist ** falloff + 1e-9) : 0;
    const sum = w0 + w1;
    part.skinIndex.push(bestIdx, secondIdx, 0, 0);
    part.skinWeight.push(w0 / sum, w1 / sum, 0, 0);
  }
}

/** 부위 하나를 뼈 하나에 통째로 고정한다(머리·눈처럼 접히지 않는 곳). */
export function assignRigid(part: PartBuffers, bone: string, indexOf: Map<string, number>): void {
  const vertexCount = part.position.length / 3;
  const already = part.skinIndex.length / 4;
  const boneIndex = indexOf.get(bone) ?? 0;
  for (let i = already; i < vertexCount; i += 1) {
    part.skinIndex.push(boneIndex, 0, 0, 0);
    part.skinWeight.push(1, 0, 0, 0);
  }
}

/**
 * 부위들을 하나의 지오메트리로 합친다.
 * 재질별로 `group` 을 잡아 SkinnedMesh 하나에 여러 재질을 붙일 수 있게 한다.
 */
export function mergeParts(parts: PartBuffers[], materialOrder: string[]): THREE.BufferGeometry {
  const position: number[] = [];
  const uv: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  const index: number[] = [];
  const geometry = new THREE.BufferGeometry();

  // 전개 연산자(push(...arr))는 정점이 많아지면 인자 한도를 넘기므로 한 개씩 옮긴다.
  const appendAll = (dst: number[], src: number[]) => {
    for (let i = 0; i < src.length; i += 1) dst.push(src[i]!);
  };

  materialOrder.forEach((material, materialIndex) => {
    const start = index.length;
    for (const part of parts) {
      if (part.material !== material) continue;
      const offset = position.length / 3;
      appendAll(position, part.position);
      appendAll(uv, part.uv);
      appendAll(skinIndex, part.skinIndex);
      appendAll(skinWeight, part.skinWeight);
      for (const i of part.index) index.push(i + offset);
    }
    const count = index.length - start;
    if (count > 0) geometry.addGroup(start, count, materialIndex);
  });

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeight, 4));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  weldNormals(geometry);
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * 같은 자리에 있는 정점끼리 법선을 평균 낸다.
 *
 * 관의 이음매(u=0 과 u=1)와 부위 경계는 정점이 따로 만들어져서 그냥 두면 밝기가
 * 끊긴 선으로 보인다. 위치가 같은 정점을 묶어 법선만 합쳐 주면 UV 는 그대로 두면서
 * 이음매가 사라진다.
 */
function weldNormals(geometry: THREE.BufferGeometry): void {
  const normal = geometry.getAttribute("normal") as THREE.BufferAttribute;
  const position = geometry.getAttribute("position") as THREE.BufferAttribute;
  const buckets = new Map<string, number[]>();
  const quantize = (n: number) => Math.round(n * 2000);

  for (let i = 0; i < position.count; i += 1) {
    const key = `${quantize(position.getX(i))},${quantize(position.getY(i))},${quantize(position.getZ(i))}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(i);
    else buckets.set(key, [i]);
  }

  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (const i of bucket) {
      nx += normal.getX(i);
      ny += normal.getY(i);
      nz += normal.getZ(i);
    }
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-6) continue;
    nx /= len;
    ny /= len;
    nz /= len;
    for (const i of bucket) normal.setXYZ(i, nx, ny, nz);
  }
  normal.needsUpdate = true;
}
