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
import {
  createLighting,
  createPitchScene,
  createSky,
  FOLLOW_SHADOW_SPAN,
  setShadowSpan,
  type Lighting,
  type PitchScene,
} from "./pitch.ts";
import { appearanceFor, createPlayerModel, type PlayerModel } from "./playerModel.ts";
import { AdaptiveQuality, baseProfile, type GraphicsQuality, type RenderProfile } from "./quality.ts";
import { ballTexture, blobShadowTexture } from "./textures.ts";

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
  /** 그림자 맵을 끈 품질에서만 보이는 발밑 그림자 원판. */
  blob: THREE.Mesh;
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

  /** 달리는 방향으로 앞 공간을 비워 주는 양. 방향이 바뀔 때 튀지 않게 따로 부드럽게 따라간다. */
  private readonly camLead = new THREE.Vector3();

  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly targetPos = new THREE.Vector3();
  private readonly targetLook = new THREE.Vector3();
  private readonly present = new Set<string>();

  private readonly lighting: Lighting;
  private readonly blobGeometry = new THREE.PlaneGeometry(1, 1);
  private readonly blobMaterial: THREE.MeshBasicMaterial;
  private readonly ballBlob: THREE.Mesh;
  /** 조작 선수에서 패스 받을 동료까지 바닥에 까는 옅은 띠. */
  private readonly passLane: THREE.Mesh;

  private quality: GraphicsQuality = "auto";
  private adaptive: AdaptiveQuality | null = null;
  private profile: RenderProfile = { pixelRatio: 1, shadows: true };
  private clock = 0;

  constructor(canvas: HTMLCanvasElement, pitch: PitchInfo, quality: GraphicsQuality = "auto") {
    this.pitch = pitch;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(46, 1, 0.3, 500);
    this.scene.add(this.camera);

    this.scene.add(createSky());
    this.lighting = createLighting(pitch);
    this.scene.add(this.lighting.group);
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

    const blobMap = blobShadowTexture();
    this.blobMaterial = new THREE.MeshBasicMaterial({
      map: blobMap,
      transparent: true,
      depthWrite: false,
    });
    this.blobGeometry.rotateX(-Math.PI / 2);
    this.ballBlob = new THREE.Mesh(this.blobGeometry, this.blobMaterial);
    this.ballBlob.scale.setScalar(pitch.ballRadius * 5);
    this.ballBlob.position.y = 0.012;
    this.ballBlob.renderOrder = 1;
    this.scene.add(this.ballBlob);

    this.passLane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        color: RING_COLORS.passTarget,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
      }),
    );
    this.passLane.position.y = 0.015;
    this.passLane.renderOrder = 1;
    this.passLane.visible = false;
    this.scene.add(this.passLane);

    this.setQuality(quality);
  }

  /**
   * 그래픽 품질을 바꾼다. 즉시 적용하며 저장은 하지 않는다(저장은 UI 가
   * `writeGraphicsQuality` 로 한다). `auto` 는 실제 프레임 시간을 보고 스스로 조절한다.
   */
  setQuality(quality: GraphicsQuality): void {
    this.quality = quality;
    this.adaptive = quality === "auto" ? new AdaptiveQuality() : null;
    this.applyProfile(this.adaptive ? this.adaptive.profile : baseProfile(quality));
  }

  /** 지금 적용 중인 품질과 실제 설정. 진단·표시용. */
  get graphics(): { quality: GraphicsQuality; pixelRatio: number; shadows: boolean } {
    return { quality: this.quality, ...this.profile };
  }

  private applyProfile(profile: RenderProfile): void {
    const shadowsChanged = profile.shadows !== this.profile.shadows;
    this.profile = profile;
    this.renderer.setPixelRatio(profile.pixelRatio);
    this.resize();
    this.renderer.shadowMap.enabled = profile.shadows;
    this.lighting.key.castShadow = profile.shadows;
    for (const slot of this.slots.values()) slot.blob.visible = !profile.shadows;
    this.ballBlob.visible = !profile.shadows;
    if (shadowsChanged) {
      // 그림자 유무는 셰이더에 구워지므로 재질을 다시 컴파일하게 한다.
      this.scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.needsUpdate = true;
      });
    }
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

    const blob = new THREE.Mesh(this.blobGeometry, this.blobMaterial);
    blob.scale.setScalar(1.25);
    blob.position.y = 0.012;
    blob.renderOrder = 1;
    blob.visible = !this.profile.shadows;
    this.scene.add(blob);

    const slot: PlayerSlot = {
      model,
      animator: new PlayerAnimator(model.rig),
      label,
      labelText: wanted,
      ring,
      blob,
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
    this.clock += dt;
    if (this.adaptive?.sample(dt * 1000)) this.applyProfile(this.adaptive.profile);

    const present = this.present;
    present.clear();
    const myControlled = frame.controlled[view.mySide];
    const myPassTarget = frame.passTarget[view.mySide];
    // 패스 받을 동료 고리는 천천히 숨 쉬듯 밝아졌다 어두워져 눈에 먼저 들어오게 한다.
    const pulse = 0.5 + 0.5 * Math.sin(this.clock * 6.5);

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
      let color: string = player.side === view.mySide ? RING_COLORS.teammate : RING_COLORS.opponent;
      let opacity = 0.34;
      let ringScale = 1;
      if (player.id === myControlled) {
        color = RING_COLORS.controlled;
        opacity = 0.95;
      } else if (player.id === myPassTarget) {
        color = RING_COLORS.passTarget;
        opacity = 0.7 + 0.25 * pulse;
        ringScale = 1 + 0.14 * pulse;
      }
      ringMaterial.color.set(color);
      ringMaterial.opacity = opacity;
      slot.ring.position.set(world.x, 0.02, world.z);
      slot.ring.scale.setScalar(ringScale);
      slot.ring.visible = true;
      slot.blob.position.set(world.x, 0.012, world.z);

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
      this.scene.remove(slot.model.group, slot.ring, slot.blob);
      slot.model.dispose();
      slot.ring.geometry.dispose();
      (slot.ring.material as THREE.Material).dispose();
      this.slots.delete(id);
    }

    const ballWorld = this.pitchScene.toWorld(frame.ball.x, frame.ball.y, this.tmpB);
    this.ball.position.set(ballWorld.x, this.pitch.ballRadius, ballWorld.z);
    this.ballBlob.position.set(ballWorld.x, 0.012, ballWorld.z);
    // 굴러가는 방향에 수직인 축으로 돌린다. 굴러가는 속도와 반지름이 맞아떨어진다.
    const rollAxis = this.tmpA.set(-Math.sin(frame.ball.heading), 0, -Math.cos(frame.ball.heading));
    if (rollAxis.lengthSq() > 1e-6) {
      this.ball.rotateOnWorldAxis(
        rollAxis.normalize(),
        (frame.ball.speed * dt) / Math.max(0.01, this.pitch.ballRadius),
      );
    }

    this.updatePassLane(myControlled, myPassTarget);
    this.updateCamera(frame, view, dt);
    this.updateShadowFocus(view);
    this.renderer.render(this.scene, this.camera);
  }

  /** 조작 선수 발밑에서 패스 받을 동료 발밑까지 옅은 띠를 깐다. 누구에게 공이 갈지 한눈에 보인다. */
  private updatePassLane(fromId: string, toId: string | null): void {
    const from = this.slots.get(fromId);
    const to = toId ? this.slots.get(toId) : undefined;
    if (!from || !to || from === to) {
      this.passLane.visible = false;
      return;
    }
    const a = from.model.group.position;
    const b = to.model.group.position;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    // 두 고리 안쪽은 비워 둔다. 고리와 띠가 겹치면 발밑이 지저분해진다.
    const length = Math.hypot(dx, dz) - 1.3;
    if (length < 0.4) {
      this.passLane.visible = false;
      return;
    }
    this.passLane.visible = true;
    this.passLane.position.set((a.x + b.x) / 2, 0.015, (a.z + b.z) / 2);
    this.passLane.rotation.y = Math.atan2(-dz, dx);
    this.passLane.scale.set(length, 1, 0.16);
  }

  /**
   * 그림자 맵은 카메라가 보는 곳 주변만 덮는다. 중심을 그림자 맵 화소 크기 단위로
   * 끊어 옮겨, 카메라가 조금씩 움직일 때 그림자 가장자리가 반짝이는 것을 줄인다.
   * (빛이 비스듬해 완전한 화소 정렬은 아니다.)
   */
  private updateShadowFocus(view: ViewState): void {
    if (!this.profile.shadows) return;
    const { key, keyOffset } = this.lighting;
    if (view.cameraMode === "broadcast") {
      setShadowSpan(key, Math.max(this.pitch.length, this.pitch.width) * 0.62);
      key.target.position.set(0, 0, 0);
    } else {
      setShadowSpan(key, FOLLOW_SHADOW_SPAN);
      const texel = (FOLLOW_SHADOW_SPAN * 2) / key.shadow.mapSize.x;
      key.target.position.set(
        Math.round(this.camLook.x / texel) * texel,
        0,
        Math.round(this.camLook.z / texel) * texel,
      );
    }
    key.position.copy(key.target.position).add(keyOffset);
  }

  /**
   * 카메라. 기본은 조작 선수 뒤쪽 위에서 공격 방향을 내려다보는 3/4 시점이다.
   *
   * - 달리는 방향으로 화면 중심을 조금 밀어 앞 공간이 보이게 한다. 이 몫은 따로
   *   천천히 따라가서, 방향을 휙 바꿔도 화면이 같이 흔들리지 않는다.
   * - 공이나 패스 받을 동료가 옆으로 멀어지면 그만큼 물러나고 높아져 한 화면에 담는다.
   * - 카메라가 관중석 안으로 들어가지 않게 경기장 둘레 안쪽으로 묶는다.
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
    const targetPos = this.targetPos;
    const targetLook = this.targetLook;

    if (view.cameraMode === "broadcast") {
      // 중계 시점: 옆에서 경기장 전체를 담는다.
      targetPos.set(focus.x * 0.55, this.pitch.width * 0.56, focus.z * 0.3 + this.pitch.width * 0.78);
      targetLook.set(focus.x * 0.75, 0, focus.z * 0.5);
    } else {
      // 앞 공간: 바라보는 방향 × 속도. 서 있으면 0 으로 돌아온다.
      const run = me ? THREE.MathUtils.clamp(me.speed / 7, 0, 1) : 0;
      const lead = this.tmpC.set(0, 0, 0);
      if (me) lead.set(Math.cos(me.facing), 0, Math.sin(me.facing)).multiplyScalar(2.4 * run);
      this.camLead.lerp(lead, 1 - Math.exp(-dt / 0.45));

      // 옆으로 벌어진 정도. 공과 패스 받을 동료 중 더 먼 쪽을 본다.
      const gap = focus.distanceTo(ball);
      let lateral = 0;
      let mateShift = 0;
      const mateId = frame.passTarget[view.mySide];
      const mate = mateId ? frame.players.find((p) => p.id === mateId) : undefined;
      if (mate && me) {
        const dz = mate.y - me.y;
        lateral = Math.abs(dz);
        mateShift = dz * 0.2;
      }
      const spread = Math.max(gap * 0.2, lateral * 0.42);

      // 선수 몸이 또렷하게 보이는 것이 최우선이라 기본 거리를 바짝 붙인다.
      const back = THREE.MathUtils.clamp(7.4 + spread, 7.4, 11.8);
      const height = THREE.MathUtils.clamp(3.4 + spread * 0.55, 3.4, 5.6);
      targetPos.set(
        focus.x - attack * back + this.camLead.x * 0.5,
        height,
        // 공 쪽으로 살짝 비켜서 옆 상황이 보이게 한다.
        focus.z + (ball.z - focus.z) * 0.18 + mateShift * 0.5 + this.camLead.z * 0.5,
      );
      targetLook.set(
        focus.x + attack * 3.4 + (ball.x - focus.x) * 0.18 + this.camLead.x,
        1.05,
        focus.z + (ball.z - focus.z) * 0.3 + mateShift + this.camLead.z,
      );
      // 관중석 첫 줄(경기장 끝에서 9m, 옆줄에서 8m) 안쪽에 머문다.
      const limitX = this.pitch.length / 2 + 7;
      const limitZ = this.pitch.width / 2 + 6;
      targetPos.x = THREE.MathUtils.clamp(targetPos.x, -limitX, limitX);
      targetPos.z = THREE.MathUtils.clamp(targetPos.z, -limitZ, limitZ);
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
    this.blobGeometry.dispose();
    this.blobMaterial.map?.dispose();
    this.blobMaterial.dispose();
    this.passLane.geometry.dispose();
    (this.passLane.material as THREE.Material).dispose();
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
