/**
 * 경기 화면 전체를 그린다.
 *
 * React 는 캔버스 한 장만 붙여 주고, 그 안쪽은 전부 이 클래스가 명령형으로 관리한다.
 * 스냅샷이 20Hz 로 오는 게임 루프를 React 상태로 돌리면 매 프레임 컴포넌트를 다시
 * 그리게 되므로, 화면 갱신과 UI 갱신을 이렇게 갈라 놓았다.
 */
import * as THREE from "three";
import type { MatchFrame, PlayerFrame } from "../game/interpolation.ts";
import { ROLE_LABEL, type PitchInfo, type Side } from "../net/protocol.ts";
import { PlayerAnimator } from "./animation.ts";
import { createLighting, createPitchScene, createSky, type PitchScene } from "./pitch.ts";
import { appearanceFor, createPlayerModel, type PlayerModel } from "./playerModel.ts";
import { ballTexture } from "./textures.ts";

export type CameraMode = "follow" | "broadcast";

export interface ViewState {
  mySide: Side;
  cameraMode: CameraMode;
  /** 팀별 사람 닉네임. AI 동료는 역할 이름으로 부른다. */
  nicknames: Record<Side, string>;
}

interface PlayerSlot {
  model: PlayerModel;
  animator: PlayerAnimator;
  label: THREE.Sprite;
  labelText: string;
  ring: THREE.Mesh;
  side: Side;
}

const RING_COLORS = {
  controlled: "#b6ff3a",
  passTarget: "#ffd24a",
  teammate: "#8fb8ff",
  opponent: "#ff8f8f",
} as const;

function makeLabelSprite(text: string, accent: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.font = '600 52px "Helvetica Neue", "Apple SD Gothic Neo", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const width = Math.min(480, ctx.measureText(text).width + 56);
    ctx.fillStyle = "rgba(8,14,12,0.72)";
    ctx.beginPath();
    ctx.roundRect((512 - width) / 2, 26, width, 76, 38);
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = "#f2f7f2";
    ctx.fillText(text, 256, 65);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false }),
  );
  sprite.scale.set(1.22, 0.31, 1);
  sprite.renderOrder = 10;
  return sprite;
}

function makeRing(): THREE.Mesh {
  const geometry = new THREE.RingGeometry(0.46, 0.62, 32);
  const material = new THREE.MeshBasicMaterial({
    color: RING_COLORS.teammate,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.02;
  mesh.renderOrder = 2;
  return mesh;
}

export class MatchScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly pitchScene: PitchScene;
  private readonly ball: THREE.Mesh;
  private readonly ballMap: THREE.Texture;
  private readonly slots = new Map<string, PlayerSlot>();
  private readonly pitch: PitchInfo;

  /** 카메라를 부드럽게 따라가게 하려고 목표값과 현재값을 따로 둔다. */
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private camInitialized = false;

  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement, pitch: PitchInfo) {
    this.pitch = pitch;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.3, 500);
    this.scene.add(this.camera);

    this.scene.add(createSky());
    this.scene.add(createLighting(pitch));
    this.pitchScene = createPitchScene(pitch);
    this.scene.add(this.pitchScene.group);
    // 먼 관중석이 자연스럽게 흐려지도록 옅은 안개를 깐다.
    this.scene.fog = new THREE.Fog("#12233a", pitch.length * 1.1, pitch.length * 3.4);

    this.ballMap = ballTexture();
    this.ball = new THREE.Mesh(
      new THREE.SphereGeometry(pitch.ballRadius, 28, 20),
      new THREE.MeshStandardMaterial({ map: this.ballMap, roughness: 0.42 }),
    );
    this.ball.castShadow = true;
    this.scene.add(this.ball);

    this.resize();
  }

  /** 이 선수의 머리 위에 띄울 이름. 사람은 닉네임, AI 동료는 역할 이름. */
  private labelFor(player: PlayerFrame, view: ViewState): string {
    if (player.controlled) return view.nicknames[player.side] || "선수";
    return ROLE_LABEL[player.role];
  }

  private ensureSlot(player: PlayerFrame, view: ViewState): PlayerSlot {
    const existing = this.slots.get(player.id);
    const wanted = this.labelFor(player, view);
    if (existing) {
      // 조작 선수가 바뀌면 이름표도 따라 바뀐다.
      if (existing.labelText !== wanted) this.relabel(existing, wanted, player.side);
      return existing;
    }

    const appearance = appearanceFor(player.side, `${player.id}:${wanted}`);
    const model = createPlayerModel(appearance, this.pitch.playerHeight);

    const label = makeLabelSprite(wanted, player.side === "left" ? "#6f9bff" : "#ff7a7a");
    label.position.y = this.pitch.playerHeight + 0.42;
    model.group.add(label);

    const ring = makeRing();
    this.scene.add(ring);
    this.scene.add(model.group);

    const slot: PlayerSlot = {
      model,
      animator: new PlayerAnimator(model.rig),
      label,
      labelText: wanted,
      ring,
      side: player.side,
    };
    this.slots.set(player.id, slot);
    return slot;
  }

  private relabel(slot: PlayerSlot, text: string, side: Side): void {
    slot.model.group.remove(slot.label);
    slot.label.material.map?.dispose();
    slot.label.material.dispose();
    const label = makeLabelSprite(text, side === "left" ? "#6f9bff" : "#ff7a7a");
    label.position.y = this.pitch.playerHeight + 0.42;
    slot.model.group.add(label);
    slot.label = label;
    slot.labelText = text;
  }

  /** 한 프레임 그린다. `dt` 는 초 단위. */
  render(frame: MatchFrame, view: ViewState, dt: number): void {
    const present = new Set<string>();

    for (const player of frame.players) {
      present.add(player.id);
      const slot = this.ensureSlot(player, view);
      const world = this.pitchScene.toWorld(player.x, player.y, this.tmpA);
      slot.model.group.position.set(world.x, 0, world.z);
      // 모델은 +Z 를 보고 서 있으므로, 경기장 각도를 회전값으로 바꾼다.
      slot.model.group.rotation.y = Math.PI / 2 - player.facing;

      slot.animator.update(dt, {
        anim: player.anim,
        speed: player.speed,
        charge: player.charge,
        dribbling: player.dribbling,
        skill: player.skill,
        skillMs: player.skillMs,
      });

      const ringMaterial = slot.ring.material as THREE.MeshBasicMaterial;
      const myControlled = frame.controlled[view.mySide];
      const myPassTarget = frame.passTarget[view.mySide];
      let color: string = player.side === view.mySide ? RING_COLORS.teammate : RING_COLORS.opponent;
      let opacity = 0.34;
      if (player.id === myControlled) {
        color = RING_COLORS.controlled;
        opacity = 0.95;
      } else if (player.id === myPassTarget) {
        color = RING_COLORS.passTarget;
        opacity = 0.85;
      }
      ringMaterial.color.set(color);
      ringMaterial.opacity = opacity;
      slot.ring.position.set(world.x, 0.02, world.z);
      slot.ring.visible = true;

      /*
       * 이름표는 깊이 검사를 끄고 항상 위에 그리기 때문에, 카메라 바로 앞을
       * 지나가는 선수의 이름표가 화면을 덮을 만큼 커진다. 너무 가까우면 감춘다.
       * 그 거리에서는 누구인지 이미 몸으로 보인다.
       */
      const distance = this.camera.position.distanceTo(slot.model.group.position);
      slot.label.visible = distance > 3.2;
    }

    // 사라진 선수는 치운다(재경기로 구성이 바뀌는 경우).
    for (const [id, slot] of this.slots) {
      if (present.has(id)) continue;
      this.scene.remove(slot.model.group, slot.ring);
      slot.model.dispose();
      slot.ring.geometry.dispose();
      (slot.ring.material as THREE.Material).dispose();
      this.slots.delete(id);
    }

    const ballWorld = this.pitchScene.toWorld(frame.ball.x, frame.ball.y, this.tmpB);
    this.ball.position.set(ballWorld.x, this.pitch.ballRadius, ballWorld.z);
    // 굴러가는 방향에 수직인 축으로 돌린다. 굴러가는 속도와 반지름이 맞아떨어진다.
    const rollAxis = this.tmpA.set(-Math.sin(frame.ball.heading), 0, -Math.cos(frame.ball.heading));
    if (rollAxis.lengthSq() > 1e-6) {
      this.ball.rotateOnWorldAxis(
        rollAxis.normalize(),
        (frame.ball.speed * dt) / Math.max(0.01, this.pitch.ballRadius),
      );
    }

    this.updateCamera(frame, view, dt);
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * 카메라. 기본은 조작 선수 뒤쪽 위에서 공격 방향을 내려다보는 3/4 시점이다.
   * 공이 멀어지면 조금 물러나 두 선수를 같이 담고, 화면 중심은 선수와 공 사이로 옮긴다.
   */
  private updateCamera(frame: MatchFrame, view: ViewState, dt: number): void {
    const attack = view.mySide === "left" ? 1 : -1;
    const me =
      frame.players.find((p) => p.id === frame.controlled[view.mySide]) ??
      frame.players.find((p) => p.side === view.mySide) ??
      frame.players[0];

    const focus = this.tmpA.set(0, 0, 0);
    if (me) this.pitchScene.toWorld(me.x, me.y, focus);
    const ball = this.pitchScene.toWorld(frame.ball.x, frame.ball.y, this.tmpB);

    let targetPos: THREE.Vector3;
    let targetLook: THREE.Vector3;

    if (view.cameraMode === "broadcast") {
      // 중계 시점: 옆에서 경기장 전체를 담는다.
      targetPos = new THREE.Vector3(
        focus.x * 0.55,
        this.pitch.width * 0.56,
        focus.z * 0.3 + this.pitch.width * 0.78,
      );
      targetLook = new THREE.Vector3(focus.x * 0.75, 0, focus.z * 0.5);
    } else {
      const gap = focus.distanceTo(ball);
      // 선수 몸이 또렷하게 보이는 것이 최우선이라 기본 거리를 바짝 붙인다.
      // 공이 멀어지면 조금만 물러나고, 넓은 시야는 미니맵과 중계 시점(V)이 맡는다.
      const back = THREE.MathUtils.clamp(7.4 + gap * 0.2, 7.4, 11.5);
      const height = THREE.MathUtils.clamp(3.4 + gap * 0.12, 3.4, 5.4);
      targetPos = new THREE.Vector3(
        focus.x - attack * back,
        height,
        // 공 쪽으로 살짝 비켜서 옆 상황이 보이게 한다.
        focus.z + (ball.z - focus.z) * 0.18,
      );
      targetLook = new THREE.Vector3(
        focus.x + attack * 3.4 + (ball.x - focus.x) * 0.18,
        1.05,
        focus.z + (ball.z - focus.z) * 0.36,
      );
    }

    if (!this.camInitialized) {
      this.camPos.copy(targetPos);
      this.camLook.copy(targetLook);
      this.camInitialized = true;
    } else {
      // 프레임 시간과 무관하게 같은 속도로 따라붙는다.
      const k = 1 - Math.exp(-dt / (view.cameraMode === "broadcast" ? 0.35 : 0.16));
      this.camPos.lerp(targetPos, k);
      this.camLook.lerp(targetLook, k);
    }

    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** 미니맵이 쓸 경기장 크기. */
  get pitchInfo(): PitchInfo {
    return this.pitch;
  }

  dispose(): void {
    for (const slot of this.slots.values()) {
      slot.model.dispose();
      slot.ring.geometry.dispose();
      (slot.ring.material as THREE.Material).dispose();
      slot.label.material.map?.dispose();
      slot.label.material.dispose();
    }
    this.slots.clear();
    this.pitchScene.dispose();
    this.ball.geometry.dispose();
    (this.ball.material as THREE.Material).dispose();
    this.ballMap.dispose();
    this.renderer.dispose();
    /*
     * dispose() 만으로는 WebGL 컨텍스트가 반납되지 않는다.
     * 로비와 경기를 오갈 때마다 렌더러를 새로 만들기 때문에, 이걸 빼먹으면
     * 브라우저의 컨텍스트 상한(보통 16개)에 걸려 프레임이 1fps 까지 떨어진다.
     */
    this.renderer.forceContextLoss();
  }
}
