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

function buildGoal(pitch: PitchInfo, side: "left" | "right", netMap: THREE.Texture): THREE.Group {
  const group = new THREE.Group();
  const halfWidth = pitch.goalWidth / 2;
  const depth = Math.max(0.8, pitch.goalDepth);
  // 왼쪽 골대는 -x 방향으로, 오른쪽 골대는 +x 방향으로 깊이가 생긴다.
  const dir = side === "left" ? -1 : 1;

  const frameMaterial = new THREE.MeshStandardMaterial({
    color: "#f4f6fa",
    roughness: 0.35,
    metalness: 0.15,
  });

  const post = new THREE.CylinderGeometry(POST_RADIUS, POST_RADIUS, CROSSBAR_HEIGHT, 12);
  for (const z of [-halfWidth, halfWidth]) {
    const mesh = new THREE.Mesh(post, frameMaterial);
    mesh.position.set(0, CROSSBAR_HEIGHT / 2, z);
    mesh.castShadow = true;
    group.add(mesh);
  }

  const bar = new THREE.CylinderGeometry(POST_RADIUS, POST_RADIUS, pitch.goalWidth, 12);
  const crossbar = new THREE.Mesh(bar, frameMaterial);
  crossbar.rotation.x = Math.PI / 2;
  crossbar.position.set(0, CROSSBAR_HEIGHT, 0);
  crossbar.castShadow = true;
  group.add(crossbar);

  // 네트는 알파맵으로 그물코를 뚫은 얇은 면 네 장이다.
  const netMaterial = new THREE.MeshStandardMaterial({
    color: "#e8edf5",
    alphaMap: netMap,
    transparent: true,
    opacity: 0.92,
    alphaTest: 0.32,
    side: THREE.DoubleSide,
    roughness: 0.9,
  });

  const repeat = (map: THREE.Texture, u: number, v: number) => {
    const clone = map.clone();
    clone.needsUpdate = true;
    clone.wrapS = THREE.RepeatWrapping;
    clone.wrapT = THREE.RepeatWrapping;
    clone.repeat.set(u, v);
    return clone;
  };

  // 뒷면.
  const back = new THREE.Mesh(
    new THREE.PlaneGeometry(pitch.goalWidth, CROSSBAR_HEIGHT),
    netMaterial.clone(),
  );
  (back.material as THREE.MeshStandardMaterial).alphaMap = repeat(netMap, pitch.goalWidth * 1.6, CROSSBAR_HEIGHT * 1.6);
  back.rotation.y = Math.PI / 2;
  back.position.set(dir * depth, CROSSBAR_HEIGHT / 2, 0);
  group.add(back);

  // 옆면 두 장.
  for (const z of [-halfWidth, halfWidth]) {
    const sideNet = new THREE.Mesh(
      new THREE.PlaneGeometry(depth, CROSSBAR_HEIGHT),
      netMaterial.clone(),
    );
    (sideNet.material as THREE.MeshStandardMaterial).alphaMap = repeat(netMap, depth * 1.6, CROSSBAR_HEIGHT * 1.6);
    sideNet.position.set((dir * depth) / 2, CROSSBAR_HEIGHT / 2, z);
    group.add(sideNet);
  }

  // 윗면.
  const top = new THREE.Mesh(new THREE.PlaneGeometry(depth, pitch.goalWidth), netMaterial.clone());
  (top.material as THREE.MeshStandardMaterial).alphaMap = repeat(netMap, depth * 1.6, pitch.goalWidth * 1.6);
  top.rotation.x = Math.PI / 2;
  top.position.set((dir * depth) / 2, CROSSBAR_HEIGHT, 0);
  group.add(top);

  return group;
}

function buildStands(pitch: PitchInfo, crowd: THREE.Texture): THREE.Group {
  const group = new THREE.Group();
  const outerX = pitch.length / 2 + 9;
  const outerZ = pitch.width / 2 + 8;

  const wallMaterial = new THREE.MeshStandardMaterial({ color: "#131a22", roughness: 0.95 });
  const crowdMaterial = new THREE.MeshStandardMaterial({
    map: crowd,
    roughness: 1,
    // 관중석은 그림자를 받을 필요가 없어 조명 계산을 가볍게 둔다.
    metalness: 0,
  });

  // 계단식 관중석을 네 면에 두른다. 안쪽이 낮고 바깥이 높다.
  const tiers = 4;
  for (let i = 0; i < tiers; i += 1) {
    const inset = i * 2.2;
    const height = 1.4 + i * 1.5;
    const y = i * 1.1;
    const halfX = outerX + inset;
    const halfZ = outerZ + inset;

    const longGeometry = new THREE.BoxGeometry(halfX * 2, height, 2.2);
    const shortGeometry = new THREE.BoxGeometry(2.2, height, halfZ * 2);
    for (const z of [-halfZ, halfZ]) {
      const mesh = new THREE.Mesh(longGeometry, i === 0 ? wallMaterial : crowdMaterial);
      mesh.position.set(0, y + height / 2, z);
      group.add(mesh);
    }
    for (const x of [-halfX, halfX]) {
      const mesh = new THREE.Mesh(shortGeometry, i === 0 ? wallMaterial : crowdMaterial);
      mesh.position.set(x, y + height / 2, 0);
      group.add(mesh);
    }
  }

  // 조명탑 네 개.
  const mastMaterial = new THREE.MeshStandardMaterial({ color: "#2b333d", roughness: 0.6 });
  const lampMaterial = new THREE.MeshStandardMaterial({
    color: "#fdfbe8",
    emissive: "#fdf6d0",
    emissiveIntensity: 1.6,
    roughness: 0.4,
  });
  const mast = new THREE.CylinderGeometry(0.34, 0.5, 20, 10);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = sx * (outerX + 8);
      const z = sz * (outerZ + 7);
      const pole = new THREE.Mesh(mast, mastMaterial);
      pole.position.set(x, 10, z);
      group.add(pole);

      const rig = new THREE.Mesh(new THREE.BoxGeometry(5, 2.4, 0.6), lampMaterial);
      rig.position.set(x, 20.4, z);
      rig.lookAt(0, 0, 0);
      group.add(rig);
    }
  }

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
  const leftGoal = buildGoal(pitch, "left", netMap);
  leftGoal.position.x = -pitch.length / 2;
  const rightGoal = buildGoal(pitch, "right", netMap);
  rightGoal.position.x = pitch.length / 2;
  group.add(leftGoal, rightGoal);

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

/** 밤 경기장 분위기의 조명 한 벌. 그림자는 방향광 하나만 만든다. */
export function createLighting(pitch: PitchInfo): THREE.Group {
  const group = new THREE.Group();

  const hemi = new THREE.HemisphereLight("#9fc4ff", "#2c4a2f", 0.75);
  group.add(hemi);

  const key = new THREE.DirectionalLight("#fff6e0", 2.1);
  key.position.set(pitch.length * 0.35, 34, pitch.width * 0.45);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.02;
  const span = Math.max(pitch.length, pitch.width) * 0.62;
  const camera = key.shadow.camera;
  camera.left = -span;
  camera.right = span;
  camera.top = span;
  camera.bottom = -span;
  camera.near = 5;
  camera.far = 110;
  camera.updateProjectionMatrix();
  group.add(key);
  group.add(key.target);

  // 반대편에서 약하게 채워 실루엣이 새까맣게 죽지 않게 한다.
  const fill = new THREE.DirectionalLight("#cfe0ff", 0.55);
  fill.position.set(-pitch.length * 0.4, 22, -pitch.width * 0.5);
  group.add(fill);

  return group;
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
