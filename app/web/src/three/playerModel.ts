/**
 * 축구 선수 한 명을 통째로 만든다: 뼈대 + 살 + 유니폼.
 *
 * 왜 직접 만드는가 — 자세한 근거는 `docs/프론트엔드/3D자산.md` 에 적어 두었다.
 * 요약하면, 재배포가 되는 무료 사람 glTF 중에 "축구 선수 비율 + 개인기 동작" 을
 * 함께 갖춘 것이 없었다. 어차피 스텝오버·슬라이딩 클립을 직접 만들어야 한다면
 * 메시까지 코드로 만드는 편이 라이선스 위험이 0 이고, 팀 색·등번호·체형을
 * 런타임에 바꿀 수 있으며, 번들에 바이너리가 들어가지 않는다.
 *
 * 모델은 키 1.8m 기준으로 세워 두고, 서버가 알려 준 `playerHeight` 에 맞춰
 * 바깥 그룹에서 한 번만 비율을 조정한다.
 */
import * as THREE from "three";
import {
  assignRigid,
  assignSkin,
  ellipsoid,
  emptyPart,
  mergeParts,
  sweep,
  type PartBuffers,
  type Section,
} from "./meshBuilder.ts";
import { buildSkeleton, MODEL_HEIGHT, type BuiltSkeleton } from "./rig.ts";
import { jerseyTexture, KITS, shortsTexture, type KitColors } from "./textures.ts";

/** 재질 순서. `mergeParts` 가 이 순서대로 group 을 만든다. */
const MATERIALS = [
  "skin",
  "jersey",
  "shorts",
  "socks",
  "boots",
  "sole",
  "hair",
  "eyeWhite",
  "eye",
] as const;
type MaterialName = (typeof MATERIALS)[number];

// 밤 경기장 조명에서도 이목구비가 읽히는 밝기 범위로 고른다.
const SKIN_TONES = ["#f0c3a0", "#dea981", "#c2865c", "#9c6540", "#7b4b2e"];
const HAIR_TONES = ["#1d1a17", "#2f2620", "#4a3526", "#0f0e0d"];

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** 한쪽 팔·다리 몫을 만들고, 같은 코드를 x 부호만 바꿔 반대쪽에도 쓴다. */
function sideSign(side: "L" | "R"): 1 | -1 {
  return side === "L" ? 1 : -1;
}

function buildTorso(parts: PartBuffers[], indexOf: Map<string, number>): void {
  const jersey = emptyPart("jersey");
  const spineBones = ["hips", "spine", "chest", "upperChest", "neck"];
  // 어깨 위쪽은 링을 촘촘히 줄여 깎는다. 반구 뚜껑으로 막으면 목까지 부풀어 오른다.
  const sections: Section[] = [
    { center: v3(0, 1.0, 0), rx: 0.143, rz: 0.098 },
    { center: v3(0, 1.06, 0), rx: 0.144, rz: 0.096, offsetZ: 0.004 },
    { center: v3(0, 1.14, 0), rx: 0.158, rz: 0.102, offsetZ: 0.008 },
    { center: v3(0, 1.24, 0), rx: 0.178, rz: 0.113, offsetZ: 0.006 },
    { center: v3(0, 1.33, 0), rx: 0.191, rz: 0.117 },
    { center: v3(0, 1.41, 0), rx: 0.192, rz: 0.112, offsetZ: -0.004 },
    { center: v3(0, 1.452, 0), rx: 0.176, rz: 0.1, offsetZ: -0.006 },
    { center: v3(0, 1.474, 0), rx: 0.128, rz: 0.081, offsetZ: -0.006 },
    { center: v3(0, 1.487, 0), rx: 0.066, rz: 0.053, offsetZ: -0.004 },
  ];
  sweep(jersey, sections, { segments: 22, capStart: true, capDepth: 0.35, vRange: [0, 1] });
  assignSkin(jersey, spineBones, indexOf);
  parts.push(jersey);

  // 반바지 몸통: 허리에서 사타구니까지. 아래는 다리가 채우므로 얕게만 막는다.
  const shortsCore = emptyPart("shorts");
  sweep(
    shortsCore,
    [
      { center: v3(0, 0.84, 0), rx: 0.168, rz: 0.126 },
      { center: v3(0, 0.92, 0), rx: 0.176, rz: 0.124 },
      { center: v3(0, 1.0, 0), rx: 0.168, rz: 0.115 },
      { center: v3(0, 1.075, 0), rx: 0.155, rz: 0.106 },
    ],
    { segments: 22, capStart: true, capDepth: 0.34 },
  );
  assignSkin(shortsCore, ["hips", "spine", "upperLegL", "upperLegR"], indexOf);
  parts.push(shortsCore);

  // 목.
  const neck = emptyPart("skin");
  sweep(
    neck,
    [
      { center: v3(0, 1.41, 0), rx: 0.06, rz: 0.058 },
      { center: v3(0, 1.48, 0), rx: 0.05, rz: 0.049 },
      { center: v3(0, 1.55, 0), rx: 0.048, rz: 0.048 },
    ],
    { segments: 16 },
  );
  assignSkin(neck, ["upperChest", "neck", "head"], indexOf);
  parts.push(neck);
}

function buildArm(parts: PartBuffers[], indexOf: Map<string, number>, side: "L" | "R"): void {
  const s = sideSign(side);
  const bones = ["upperChest", `shoulder${side}`, `upperArm${side}`, `lowerArm${side}`, `hand${side}`];

  // 소매는 유니폼 재질, 팔꿈치 아래는 맨살.
  const sleeve = emptyPart("jersey");
  sweep(
    sleeve,
    [
      { center: v3(s * 0.13, 1.448, 0), rx: 0.074, rz: 0.074 },
      { center: v3(s * 0.178, 1.395, 0), rx: 0.066, rz: 0.066 },
      { center: v3(s * 0.2, 1.32, 0), rx: 0.057, rz: 0.057 },
      { center: v3(s * 0.2, 1.26, 0), rx: 0.052, rz: 0.052 },
    ],
    { segments: 16, capStart: true, capDepth: 0.22, vRange: [0.93, 0.74] },
  );
  assignSkin(sleeve, bones, indexOf);
  parts.push(sleeve);

  const arm = emptyPart("skin");
  sweep(
    arm,
    [
      { center: v3(s * 0.2, 1.3, 0), rx: 0.054, rz: 0.054 },
      { center: v3(s * 0.2, 1.2, 0), rx: 0.047, rz: 0.047 },
      { center: v3(s * 0.2, 1.13, 0), rx: 0.043, rz: 0.043 },
      { center: v3(s * 0.2, 1.03, 0), rx: 0.041, rz: 0.041 },
      { center: v3(s * 0.2, 0.93, 0), rx: 0.034, rz: 0.034 },
      { center: v3(s * 0.2, 0.87, 0), rx: 0.031, rz: 0.031 },
    ],
    { segments: 16 },
  );
  assignSkin(arm, bones, indexOf);
  parts.push(arm);

  // 손: 납작한 알약 하나로 두면 장난감처럼 보인다.
  // 손목 -> 손등 -> 붙인 네 손가락 -> 엄지로 나눠 사람 손 실루엣을 만든다.
  const hand = emptyPart("skin");
  // 손등. 앞뒤로 눌린 판이다.
  ellipsoid(hand, v3(s * 0.2, 0.851, 0.003), v3(0.03, 0.033, 0.016), {
    widthSegments: 14,
    heightSegments: 12,
  });
  // 붙인 네 손가락. 끝으로 갈수록 가늘고 살짝 안으로 말린다.
  sweep(
    hand,
    [
      { center: v3(s * 0.2, 0.833, 0.004), rx: 0.028, rz: 0.015 },
      { center: v3(s * 0.201, 0.808, 0.006), rx: 0.026, rz: 0.013 },
      { center: v3(s * 0.202, 0.787, 0.009), rx: 0.021, rz: 0.011 },
      { center: v3(s * 0.203, 0.774, 0.012), rx: 0.014, rz: 0.008 },
    ],
    { segments: 12, capEnd: true, capDepth: 0.7 },
  );
  // 엄지는 몸 안쪽을 향한다.
  ellipsoid(hand, v3(s * 0.176, 0.838, 0.008), v3(0.011, 0.019, 0.011), {
    widthSegments: 10,
    heightSegments: 8,
  });
  assignRigid(hand, `hand${side}`, indexOf);
  parts.push(hand);
}

function buildLeg(parts: PartBuffers[], indexOf: Map<string, number>, side: "L" | "R"): void {
  const s = sideSign(side);
  const upper = ["hips", `upperLeg${side}`, `lowerLeg${side}`];
  const lower = ["hips", `upperLeg${side}`, `lowerLeg${side}`, `foot${side}`];

  /*
   * 다리는 "관 안에 관" 을 만들지 않는다. 반바지 자락을 허벅지 위에 덧씌우면
   * 두 면이 겹쳐 z-fighting 으로 찢어져 보였다. 대신 같은 중심선을 따라
   * 반바지 -> 맨살 -> 양말 순으로 끊어 이어 붙이고, 경계마다 단면을 맞춘다.
   */
  const shorts = emptyPart("shorts");
  sweep(
    shorts,
    [
      { center: v3(s * 0.098, 0.92, 0), rx: 0.108, rz: 0.113 },
      { center: v3(s * 0.098, 0.84, 0), rx: 0.116, rz: 0.121 },
      { center: v3(s * 0.099, 0.76, 0), rx: 0.118, rz: 0.123 },
      { center: v3(s * 0.1, 0.69, 0), rx: 0.112, rz: 0.117 },
    ],
    // 아래 뚜껑이 바지 단과 허벅지 사이의 빈 고리를 메운다.
    { segments: 18, capStart: true, capDepth: 0.3, capEnd: true, capDepth2: 0.12 },
  );
  assignSkin(shorts, upper, indexOf);
  parts.push(shorts);

  const leg = emptyPart("skin");
  sweep(
    leg,
    [
      { center: v3(s * 0.098, 0.74, 0), rx: 0.078, rz: 0.082 },
      { center: v3(s * 0.098, 0.66, 0), rx: 0.073, rz: 0.077 },
      { center: v3(s * 0.096, 0.56, 0), rx: 0.062, rz: 0.066 },
      { center: v3(s * 0.095, 0.495, 0), rx: 0.056, rz: 0.058 },
      { center: v3(s * 0.095, 0.44, 0), rx: 0.058, rz: 0.062 },
    ],
    { segments: 18 },
  );
  assignSkin(leg, lower, indexOf);
  parts.push(leg);

  // 양말: 종아리가 볼록하게 나오도록 중간 단면을 키운다.
  const sock = emptyPart("socks");
  sweep(
    sock,
    [
      { center: v3(s * 0.095, 0.45, 0), rx: 0.06, rz: 0.064 },
      { center: v3(s * 0.095, 0.36, 0), rx: 0.064, rz: 0.07, offsetZ: -0.006 },
      { center: v3(s * 0.095, 0.26, 0), rx: 0.055, rz: 0.059 },
      { center: v3(s * 0.095, 0.16, 0), rx: 0.044, rz: 0.047 },
      { center: v3(s * 0.095, 0.1, 0), rx: 0.041, rz: 0.044 },
    ],
    { segments: 16 },
  );
  assignSkin(sock, lower, indexOf);
  parts.push(sock);

  // 축구화: 발등은 낮고 앞이 길다. 밑창을 따로 깔아 바닥이 뭉툭해 보이지 않게 한다.
  const boot = emptyPart("boots");
  sweep(
    boot,
    [
      { center: v3(s * 0.095, 0.082, -0.058), rx: 0.04, rz: 0.048 },
      { center: v3(s * 0.095, 0.062, -0.01), rx: 0.044, rz: 0.055 },
      { center: v3(s * 0.095, 0.048, 0.055), rx: 0.043, rz: 0.044 },
      { center: v3(s * 0.095, 0.038, 0.115), rx: 0.034, rz: 0.032 },
      { center: v3(s * 0.095, 0.032, 0.145), rx: 0.022, rz: 0.02 },
    ],
    { segments: 14, capStart: true, capDepth: 0.5, capEnd: true, capDepth2: 0.5 },
  );
  assignSkin(boot, [`lowerLeg${side}`, `foot${side}`, `toe${side}`], indexOf);
  parts.push(boot);

  const sole = emptyPart("sole");
  sweep(
    sole,
    [
      { center: v3(s * 0.095, 0.016, -0.055), rx: 0.038, rz: 0.014 },
      { center: v3(s * 0.095, 0.012, 0.0), rx: 0.043, rz: 0.013 },
      { center: v3(s * 0.095, 0.011, 0.07), rx: 0.041, rz: 0.012 },
      { center: v3(s * 0.095, 0.011, 0.14), rx: 0.024, rz: 0.011 },
    ],
    { segments: 12, capStart: true, capDepth: 0.5, capEnd: true, capDepth2: 0.5 },
  );
  assignSkin(sole, [`foot${side}`, `toe${side}`], indexOf);
  parts.push(sole);
}

function buildHead(parts: PartBuffers[], indexOf: Map<string, number>): void {
  const center = v3(0, 1.662, 0.004);
  const head = emptyPart("skin");
  ellipsoid(head, center, v3(0.092, 0.118, 0.103), {
    widthSegments: 30,
    heightSegments: 24,
    // 광대 아래부터 서서히 좁혀 턱선을 만든다. 급하게 꺾으면 각진 도형처럼 보인다.
    shape: (v) => (v < 0.5 ? 1 : 1 - 0.34 * ((v - 0.5) / 0.5) ** 2.1),
  });
  assignRigid(head, "head", indexOf);
  parts.push(head);

  // 머리카락. 앞쪽은 이마가 드러나게 뒤로 물리고, 뒤통수는 아래까지 덮는다.
  const hair = emptyPart("hair");
  // 정수리 덮개.
  ellipsoid(hair, center.clone().add(v3(0, 0.005, -0.006)), v3(0.0965, 0.1225, 0.1075), {
    widthSegments: 26,
    heightSegments: 22,
    rowRange: [0, 0.44],
  });
  // 뒤통수와 옆머리. 앞쪽으로는 오지 않게 뒤로 밀어 둔다.
  ellipsoid(hair, center.clone().add(v3(0, -0.014, -0.03)), v3(0.0955, 0.115, 0.102), {
    widthSegments: 22,
    heightSegments: 18,
    rowRange: [0.26, 0.72],
  });
  // 앞머리. 이마 위에 살짝 내려온 앞머리가 있어야 헤어라인이 자연스럽다.
  ellipsoid(hair, center.clone().add(v3(0, 0.038, 0.028)), v3(0.082, 0.038, 0.075), {
    widthSegments: 20,
    heightSegments: 10,
  });
  assignRigid(hair, "head", indexOf);
  parts.push(hair);

  const white = emptyPart("eyeWhite");
  const pupil = emptyPart("eye");
  const brow = emptyPart("hair");
  const face = emptyPart("skin");

  /*
   * 얼굴 부품의 z 값은 눈대중이 아니라 두상 타원체의 표면 위치에서 잡았다.
   * 눈 높이(y=1.676, x=0.034)의 표면은 z≈0.099 라서, 이보다 안쪽에 두면 아예
   * 파묻혀 보이지 않고(처음에 그래서 민짜 달걀 얼굴이 됐다) 너무 앞에 두면
   * 눈알이 튀어나온 인형이 된다. 2~3mm 만 나오게 두는 것이 사람처럼 보인다.
   */
  for (const s of [1, -1]) {
    ellipsoid(white, v3(s * 0.0345, 1.6745, 0.0885), v3(0.0135, 0.0098, 0.0105), {
      widthSegments: 14,
      heightSegments: 10,
    });
    ellipsoid(pupil, v3(s * 0.0355, 1.674, 0.0955), v3(0.0072, 0.0078, 0.0062), {
      widthSegments: 10,
      heightSegments: 8,
    });
    // 윗눈꺼풀: 눈 위를 살짝 덮어 동그란 구슬로 보이지 않게 한다.
    ellipsoid(face, v3(s * 0.0345, 1.6835, 0.0885), v3(0.0172, 0.0072, 0.0095), {
      widthSegments: 14,
      heightSegments: 8,
    });
    // 아랫눈꺼풀.
    ellipsoid(face, v3(s * 0.0345, 1.6685, 0.0865), v3(0.0152, 0.0042, 0.0075), {
      widthSegments: 14,
      heightSegments: 8,
    });
    // 눈썹.
    ellipsoid(brow, v3(s * 0.0365, 1.6915, 0.0895), v3(0.0215, 0.0042, 0.0072), {
      widthSegments: 12,
      heightSegments: 6,
    });
    // 광대.
    ellipsoid(face, v3(s * 0.0555, 1.6425, 0.0715), v3(0.019, 0.013, 0.0095), {
      widthSegments: 12,
      heightSegments: 8,
    });
    // 귀.
    ellipsoid(face, v3(s * 0.0885, 1.664, -0.004), v3(0.0075, 0.023, 0.014), {
      widthSegments: 10,
      heightSegments: 10,
    });
  }

  // 코: 콧대에서 코끝까지. 표면(z≈0.107)보다 1cm 남짓 나오게 한다.
  sweep(
    face,
    [
      { center: v3(0, 1.6765, 0.0955), rx: 0.0062, rz: 0.0075 },
      { center: v3(0, 1.6625, 0.0995), rx: 0.0092, rz: 0.0105 },
      { center: v3(0, 1.6515, 0.104), rx: 0.014, rz: 0.0135 },
      { center: v3(0, 1.6425, 0.1005), rx: 0.0125, rz: 0.011 },
    ],
    { segments: 14, capEnd: true, capDepth2: 0.6 },
  );
  // 입술. 넓고 납작하게, 두 장을 거의 붙여 한 줄로 보이게 한다.
  ellipsoid(face, v3(0, 1.6225, 0.0895), v3(0.0235, 0.0042, 0.0072), {
    widthSegments: 18,
    heightSegments: 8,
  });
  ellipsoid(face, v3(0, 1.6155, 0.0885), v3(0.0215, 0.0048, 0.0072), {
    widthSegments: 18,
    heightSegments: 8,
  });
  // 턱 끝.
  ellipsoid(face, v3(0, 1.5955, 0.068), v3(0.026, 0.019, 0.021), {
    widthSegments: 16,
    heightSegments: 10,
  });

  assignRigid(white, "head", indexOf);
  assignRigid(pupil, "head", indexOf);
  assignRigid(brow, "head", indexOf);
  assignRigid(face, "head", indexOf);
  parts.push(white, pupil, brow, face);
}

export interface PlayerAppearance {
  kit: KitColors;
  skinTone: string;
  hairTone: string;
  number: number;
}

/** 닉네임에서 항상 같은 값을 뽑아 두 선수가 서로 다르게 보이도록 한다. */
export function appearanceFor(side: "left" | "right", nickname: string): PlayerAppearance {
  let hash = 2166136261;
  for (let i = 0; i < nickname.length; i += 1) {
    hash ^= nickname.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const pick = <T,>(list: readonly T[], salt: number): T =>
    list[Math.abs((hash >>> salt) % list.length)]!;
  return {
    kit: KITS[side],
    skinTone: pick(SKIN_TONES, 3),
    hairTone: pick(HAIR_TONES, 11),
    number: 1 + (Math.abs(hash >>> 7) % 29),
  };
}

export interface PlayerModel {
  /** 씬에 넣는 바깥 그룹. 위치·방향·크기는 여기에만 준다. */
  group: THREE.Group;
  mesh: THREE.SkinnedMesh;
  rig: BuiltSkeleton;
  materials: THREE.Material[];
  dispose(): void;
}

/**
 * 선수 하나를 만든다. `height` 는 서버가 알려 준 실제 키(미터)다.
 */
export function createPlayerModel(appearance: PlayerAppearance, height: number): PlayerModel {
  const rig = buildSkeleton();
  const parts: PartBuffers[] = [];
  buildTorso(parts, rig.indexOf);
  buildArm(parts, rig.indexOf, "L");
  buildArm(parts, rig.indexOf, "R");
  buildLeg(parts, rig.indexOf, "L");
  buildLeg(parts, rig.indexOf, "R");
  buildHead(parts, rig.indexOf);

  const geometry = mergeParts(parts, MATERIALS as unknown as string[]);

  const jerseyMap = jerseyTexture(appearance.kit, appearance.number);
  const shortsMap = shortsTexture(appearance.kit);
  const byName: Record<MaterialName, THREE.Material> = {
    skin: new THREE.MeshStandardMaterial({ color: appearance.skinTone, roughness: 0.82 }),
    jersey: new THREE.MeshStandardMaterial({ map: jerseyMap, roughness: 0.74 }),
    shorts: new THREE.MeshStandardMaterial({ map: shortsMap, roughness: 0.8 }),
    socks: new THREE.MeshStandardMaterial({ color: appearance.kit.socks, roughness: 0.88 }),
    boots: new THREE.MeshStandardMaterial({
      color: appearance.kit.boots,
      roughness: 0.32,
      metalness: 0.08,
    }),
    sole: new THREE.MeshStandardMaterial({ color: "#14171c", roughness: 0.6 }),
    hair: new THREE.MeshStandardMaterial({ color: appearance.hairTone, roughness: 0.72 }),
    eyeWhite: new THREE.MeshStandardMaterial({ color: "#e9e5dc", roughness: 0.4 }),
    eye: new THREE.MeshStandardMaterial({ color: "#14120f", roughness: 0.25 }),
  };
  const materials = MATERIALS.map((name) => byName[name]);

  const mesh = new THREE.SkinnedMesh(geometry, materials);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // 몸이 화면 밖으로 잠깐 나가도 사라지지 않도록 넉넉한 경계구를 쓴다.
  mesh.frustumCulled = false;
  mesh.add(rig.root);
  mesh.bind(rig.skeleton);

  const group = new THREE.Group();
  const scale = height / MODEL_HEIGHT;
  group.scale.setScalar(scale);
  group.add(mesh);

  return {
    group,
    mesh,
    rig,
    materials,
    dispose() {
      geometry.dispose();
      jerseyMap.dispose();
      shortsMap.dispose();
      for (const material of materials) material.dispose();
      rig.skeleton.dispose();
    },
  };
}
