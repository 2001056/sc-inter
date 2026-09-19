/**
 * 경기장과 그 주변을 만든다.
 *
 * 서버가 알려 준 `PitchInfo` 만 보고 짓기 때문에 경기장 규격이 바뀌어도
 * 프런트는 고칠 것이 없다. 잔디와 라인은 한 장의 텍스처로 구워 z-fighting 을
 * 없앴고, 골대·네트·관중석·조명탑은 실제 치수에 비례해 배치한다.
 *
 * 좌표 변환: 경기장 `(x, y)` -> 월드 `(x - length/2, 0, y - width/2)`.
 * 경기장 한가운데가 월드 원점이라 카메라 계산이 단순해진다.
 */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PitchInfo } from "../net/protocol.ts";
import { crowdTexture, netAlphaTexture, pitchTexture } from "./textures.ts";

/** 골대 기둥 굵기(m). 실제 규격(12cm)에 맞춘다. */
const POST_RADIUS = 0.06;
/** 크로스바 높이(m). 풋살·미니 축구 기준. */
const CROSSBAR_HEIGHT = 2.2;

export interface PitchScene {
  group: THREE.Group;
  /** 경기장 좌표를 월드 좌표로 옮긴다. */
  toWorld(x: number, y: number, out?: THREE.Vector3): THREE.Vector3;
  dispose(): void;
}

/** 같은 재질을 쓰는 조각들을 한 메시로 합친다. 조각마다 draw call 이 하나씩 들던 것을 줄인다. */
function merged(pieces: THREE.BufferGeometry[], material: THREE.Material): THREE.Mesh {
  const geometry = mergeGeometries(pieces.map((piece) => piece.index ? piece.toNonIndexed() : piece));
  for (const piece of pieces) piece.dispose();
  if (!geometry) throw new Error("경기장 조각을 합치지 못했습니다.");
  return new THREE.Mesh(geometry, material);
}

/** 조각의 변환을 정점에 구워 넣는다. 합치기 전에 한 번만 부른다. */
function placed(
  geometry: THREE.BufferGeometry,
  position: THREE.Vector3,
  rotation = new THREE.Euler(),
): THREE.BufferGeometry {
  const matrix = new THREE.Matrix4().compose(
    position,
    new THREE.Quaternion().setFromEuler(rotation),
    new THREE.Vector3(1, 1, 1),
  );
  return geometry.applyMatrix4(matrix);
}

/** 그물 면의 UV 를 실제 크기에 비례하게 늘린다. 텍스처를 면마다 복제하지 않아도 그물코 크기가 같다. */
function netPlane(width: number, height: number): THREE.PlaneGeometry {
  const plane = new THREE.PlaneGeometry(width, height);
  const uv = plane.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i += 1) uv.setXY(i, uv.getX(i) * width * 1.6, uv.getY(i) * height * 1.6);
  return plane;
}

/**
 * 골대 두 개. 기둥·크로스바는 한 메시, 그물 여덟 장은 한 메시로 합친다.
 * 예전에는 그물 면마다 재질과 알파맵을 복제해 골대 하나에 draw call 7개를 썼다.
 */
function buildGoals(pitch: PitchInfo, netMap: THREE.Texture): THREE.Group {
  const group = new THREE.Group();
  const halfWidth = pitch.goalWidth / 2;
  const depth = Math.max(0.8, pitch.goalDepth);
  const frames: THREE.BufferGeometry[] = [];
  const nets: THREE.BufferGeometry[] = [];

  for (const side of ["left", "right"] as const) {
    // 왼쪽 골대는 -x 방향으로, 오른쪽 골대는 +x 방향으로 깊이가 생긴다.
    const dir = side === "left" ? -1 : 1;
    const x = (dir * pitch.length) / 2;

    for (const z of [-halfWidth, halfWidth]) {
      frames.push(
        placed(
          new THREE.CylinderGeometry(POST_RADIUS, POST_RADIUS, CROSSBAR_HEIGHT, 12),
          new THREE.Vector3(x, CROSSBAR_HEIGHT / 2, z),
        ),
      );
    }
    frames.push(
      placed(
        new THREE.CylinderGeometry(POST_RADIUS, POST_RADIUS, pitch.goalWidth, 12),
        new THREE.Vector3(x, CROSSBAR_HEIGHT, 0),
        new THREE.Euler(Math.PI / 2, 0, 0),
      ),
    );

    // 그물: 뒷면, 옆면 두 장, 윗면.
    nets.push(
      placed(
        netPlane(pitch.goalWidth, CROSSBAR_HEIGHT),
        new THREE.Vector3(x + dir * depth, CROSSBAR_HEIGHT / 2, 0),
        new THREE.Euler(0, Math.PI / 2, 0),
      ),
    );
    for (const z of [-halfWidth, halfWidth]) {
      nets.push(
        placed(netPlane(depth, CROSSBAR_HEIGHT), new THREE.Vector3(x + (dir * depth) / 2, CROSSBAR_HEIGHT / 2, z)),
      );
    }
    nets.push(
      placed(
        netPlane(depth, pitch.goalWidth),
        new THREE.Vector3(x + (dir * depth) / 2, CROSSBAR_HEIGHT, 0),
        new THREE.Euler(Math.PI / 2, 0, 0),
      ),
    );
  }

  const frameMesh = merged(
    frames,
    new THREE.MeshStandardMaterial({ color: "#f4f6fa", roughness: 0.35, metalness: 0.15 }),
  );
  frameMesh.castShadow = true;
  group.add(frameMesh);

  // 네트는 알파맵으로 그물코를 뚫은 얇은 면이다. 텍스처 한 장을 반복해 쓴다.
  const netMesh = merged(
    nets,
    new THREE.MeshStandardMaterial({
      color: "#e8edf5",
      alphaMap: netMap,
      transparent: true,
      opacity: 0.92,
      alphaTest: 0.32,
      side: THREE.DoubleSide,
      roughness: 0.9,
    }),
  );
  group.add(netMesh);
  return group;
}

/**
 * 계단식 관중석과 조명탑. 재질이 셋(벽·관중·조명탑·램프)뿐이라 재질별로 한 메시씩 합친다.
 * 예전에는 상자 24개가 각각 draw call 이었다.
 */
function buildStands(pitch: PitchInfo, crowd: THREE.Texture): THREE.Group {
  const group = new THREE.Group();
  const outerX = pitch.length / 2 + 9;
  const outerZ = pitch.width / 2 + 8;

  const walls: THREE.BufferGeometry[] = [];
  const seats: THREE.BufferGeometry[] = [];

  // 계단식 관중석을 네 면에 두른다. 안쪽이 낮고 바깥이 높다.
  const tiers = 4;
  for (let i = 0; i < tiers; i += 1) {
    const inset = i * 2.2;
    const height = 1.4 + i * 1.5;
    const y = i * 1.1;
    const halfX = outerX + inset;
    const halfZ = outerZ + inset;
    const into = i === 0 ? walls : seats;
    for (const z of [-halfZ, halfZ]) {
      into.push(placed(new THREE.BoxGeometry(halfX * 2, height, 2.2), new THREE.Vector3(0, y + height / 2, z)));
    }
    for (const x of [-halfX, halfX]) {
      into.push(placed(new THREE.BoxGeometry(2.2, height, halfZ * 2), new THREE.Vector3(x, y + height / 2, 0)));
    }
  }

  group.add(merged(walls, new THREE.MeshStandardMaterial({ color: "#131a22", roughness: 0.95 })));
  // 관중석은 그림자를 받지 않는다. 조명 계산을 가볍게 둔다.
  group.add(merged(seats, new THREE.MeshStandardMaterial({ map: crowd, roughness: 1, metalness: 0 })));

  // 조명탑 네 개.
  const masts: THREE.BufferGeometry[] = [];
  const lamps: THREE.BufferGeometry[] = [];
  const aim = new THREE.Object3D();
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (outerX + 8);
      const z = sz * (outerZ + 7);
      masts.push(placed(new THREE.CylinderGeometry(0.34, 0.5, 20, 10), new THREE.Vector3(x, 10, z)));
      aim.position.set(x, 20.4, z);
      aim.lookAt(0, 0, 0);
      lamps.push(placed(new THREE.BoxGeometry(5, 2.4, 0.6), aim.position.clone(), aim.rotation.clone()));
    }
  }
  group.add(merged(masts, new THREE.MeshStandardMaterial({ color: "#2b333d", roughness: 0.6 })));
  group.add(
    merged(
      lamps,
      new THREE.MeshStandardMaterial({
        color: "#fdfbe8",
        emissive: "#fdf6d0",
        emissiveIntensity: 1.6,
        roughness: 0.4,
      }),
    ),
  );

  return group;
}

export function createPitchScene(pitch: PitchInfo): PitchScene {
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];

  // 경기장 바깥까지 이어지는 잔디. 경기장 바로 밖이 갑자기 끊기면 어색하다.
  const surroundMaterial = new THREE.MeshStandardMaterial({ color: "#1f5730", roughness: 1 });
  const surround = new THREE.Mesh(
    new THREE.PlaneGeometry(pitch.length + 34, pitch.width + 30),
    surroundMaterial,
  );
  surround.rotation.x = -Math.PI / 2;
  surround.position.y = -0.02;
  surround.receiveShadow = true;
  group.add(surround);
  disposables.push(surround.geometry, surroundMaterial);

  const turfMap = pitchTexture({
    length: pitch.length,
    width: pitch.width,
    goalWidth: pitch.goalWidth,
  });
  const turfMaterial = new THREE.MeshStandardMaterial({ map: turfMap, roughness: 0.96 });
  const turf = new THREE.Mesh(new THREE.PlaneGeometry(pitch.length, pitch.width), turfMaterial);
  turf.rotation.x = -Math.PI / 2;
  turf.receiveShadow = true;
  group.add(turf);
  disposables.push(turf.geometry, turfMaterial, turfMap);

  const netMap = netAlphaTexture();
  disposables.push(netMap);
  group.add(buildGoals(pitch, netMap));

  const crowd = crowdTexture();
  disposables.push(crowd);
  group.add(buildStands(pitch, crowd));

  const halfLength = pitch.length / 2;
  const halfWidth = pitch.width / 2;

  return {
    group,
    toWorld(x, y, out = new THREE.Vector3()) {
      return out.set(x - halfLength, 0, y - halfWidth);
    },
    dispose() {
      for (const item of disposables) item.dispose();
      group.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose();
          const material = object.material;
          if (Array.isArray(material)) material.forEach((m) => m.dispose());
          else material.dispose();
        }
      });
    },
  };
}

export interface Lighting {
  group: THREE.Group;
  /** 그림자를 만드는 유일한 조명. 장면이 그림자 범위를 옮길 때 쓴다. */
  key: THREE.DirectionalLight;
  /** 주광이 경기장 중심에서 떨어진 방향과 거리. 그림자 범위를 옮겨도 빛 방향은 같다. */
  keyOffset: THREE.Vector3;
}

/**
 * 그림자 범위의 반지름(m). 조작 선수 주변만 덮는다.
 *
 * 예전에는 경기장 전체(±34.7m)를 2048 맵 하나로 덮었다(1화소 약 3.4cm). 지금은
 * 카메라가 보는 곳 주변 ±17m 만 1024 맵으로 덮는다(1화소 약 3.3cm). 그림자 선명도는
 * 거의 같고 그림자 맵에 그리는 화소는 1/4 이다. 중계 시점에서는 경기장 전체를 덮어
 * 1화소가 약 6.8cm 로 흐려지지만, 그 거리에서는 선수 자체가 작게 보인다.
 */
export const FOLLOW_SHADOW_SPAN = 17;
export const SHADOW_MAP_SIZE = 1024;

/** 밤 경기장 분위기의 조명 한 벌. 그림자는 방향광 하나만 만든다. */
export function createLighting(pitch: PitchInfo): Lighting {
  const group = new THREE.Group();

  const hemi = new THREE.HemisphereLight("#9fc4ff", "#2c4a2f", 0.75);
  group.add(hemi);

  const key = new THREE.DirectionalLight("#fff6e0", 2.1);
  const keyOffset = new THREE.Vector3(pitch.length * 0.35, 34, pitch.width * 0.45);
  key.position.copy(keyOffset);
  key.castShadow = true;
  key.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.02;
  setShadowSpan(key, FOLLOW_SHADOW_SPAN);
  group.add(key);
  group.add(key.target);

  // 반대편에서 약하게 채워 실루엣이 새까맣게 죽지 않게 한다.
  const fill = new THREE.DirectionalLight("#cfe0ff", 0.55);
  fill.position.set(-pitch.length * 0.4, 22, -pitch.width * 0.5);
  group.add(fill);

  return { group, key, keyOffset };
}

/** 그림자 카메라가 덮는 반지름을 바꾼다. 바뀔 때만 투영 행렬을 다시 계산한다. */
export function setShadowSpan(key: THREE.DirectionalLight, span: number): void {
  const camera = key.shadow.camera;
  if (camera.right === span) return;
  camera.left = -span;
  camera.right = span;
  camera.top = span;
  camera.bottom = -span;
  camera.near = 5;
  camera.far = 110;
  camera.updateProjectionMatrix();
}

/** 밤하늘 배경. 위는 짙은 남색, 지평선 근처는 조명이 번진 색. */
export function createSky(): THREE.Mesh {
  const geometry = new THREE.SphereGeometry(320, 24, 16);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      topColor: { value: new THREE.Color("#060c18") },
      bottomColor: { value: new THREE.Color("#1d3350") },
    },
    vertexShader: `
      varying float vHeight;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vHeight = normalize(world.xyz).y;
        gl_Position = projectionMatrix * viewMatrix * world;
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      varying float vHeight;
      void main() {
        float t = smoothstep(-0.1, 0.55, vHeight);
        gl_FragColor = vec4(mix(bottomColor, topColor, t), 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  return mesh;
}
