/**
 * 로비의 선수 프리뷰.
 *
 * 경기 화면과 같은 모델·같은 애니메이션 코드를 쓰되, 카메라만 인물 사진처럼
 * 가까이 붙인다. 로비에 들어오자마자 "이 게임의 선수는 이렇게 생겼다" 를
 * 보여 주는 자리라서, 동작을 차례로 돌려 개인기까지 눈에 띄게 한다.
 */
import * as THREE from "three";
import type { AnimState, Side } from "../net/protocol.ts";
import { PlayerAnimator } from "./animation.ts";
import { appearanceFor, createPlayerModel, type PlayerModel } from "./playerModel.ts";
import { AdaptiveQuality, baseProfile, type GraphicsQuality, type RenderProfile } from "./quality.ts";

/** 순서대로 돌려 보여 줄 동작과 각 동작의 길이(초). */
const SHOWCASE: { anim: AnimState; seconds: number; speed: number }[] = [
  { anim: "idle", seconds: 2.6, speed: 0 },
  { anim: "run", seconds: 3.0, speed: 6.2 },
  { anim: "stepover", seconds: 1.1, speed: 1.4 },
  { anim: "feintLeft", seconds: 1.1, speed: 1.2 },
  { anim: "feintRight", seconds: 1.1, speed: 1.2 },
  { anim: "dragback", seconds: 1.2, speed: 0.8 },
  { anim: "sprint", seconds: 2.4, speed: 9 },
  { anim: "shoot", seconds: 1.2, speed: 3.4 },
  { anim: "celebrate", seconds: 2.6, speed: 0 },
];

export class PlayerPreview {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private model: PlayerModel;
  private animator: PlayerAnimator;
  private readonly pedestal: THREE.Mesh;
  private readonly height: number;

  private step = 0;
  private stepTime = 0;
  private spin = 0.5;

  private readonly key: THREE.DirectionalLight;
  private adaptive: AdaptiveQuality | null = null;
  private profile: RenderProfile = { pixelRatio: 1, shadows: true };

  constructor(
    canvas: HTMLCanvasElement,
    side: Side,
    nickname: string,
    height = 1.8,
    quality: GraphicsQuality = "auto",
  ) {
    this.height = height;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.25;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.camera = new THREE.PerspectiveCamera(34, 1, 0.1, 60);
    this.scene.add(this.camera);

    // 인물 사진 조명: 앞 위쪽 주광 + 뒤쪽 림라이트 + 옅은 환경광.
    this.scene.add(new THREE.HemisphereLight("#cfe2ff", "#2c3f26", 1.45));

    const key = new THREE.DirectionalLight("#fff4e2", 3.4);
    this.key = key;
    key.position.set(2.4, 3.6, 3.2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = -2;
    key.shadow.camera.right = 2;
    key.shadow.camera.top = 3;
    key.shadow.camera.bottom = -0.5;
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 14;
    key.shadow.bias = -0.0009;
    key.shadow.normalBias = 0.03;
    this.scene.add(key);

    const rim = new THREE.DirectionalLight("#7fc6ff", 2.2);
    rim.position.set(-2.8, 2.4, -3.0);
    this.scene.add(rim);

    const fill = new THREE.DirectionalLight("#ffe6c4", 1.3);
    fill.position.set(-1.4, 1.5, 3.4);

    // 얼굴 전용 정면광. 머리카락 그림자로 이목구비가 죽는 것을 막는다.
    const faceLight = new THREE.DirectionalLight("#fff3e6", 2.1);
    faceLight.position.set(0.5, 1.9, 4.2);
    this.scene.add(faceLight);
    this.scene.add(fill);

    // 발밑 잔디 원판. 선수가 허공에 뜬 것처럼 보이지 않게 한다.
    this.pedestal = new THREE.Mesh(
      new THREE.CircleGeometry(1.15, 48),
      new THREE.MeshStandardMaterial({ color: "#26623a", roughness: 1 }),
    );
    this.pedestal.rotation.x = -Math.PI / 2;
    this.pedestal.receiveShadow = true;
    this.scene.add(this.pedestal);

    this.model = createPlayerModel(appearanceFor(side, nickname || "SC INTER"), height);
    this.animator = new PlayerAnimator(this.model.rig);
    this.scene.add(this.model.group);

    this.setQuality(quality);
  }

  /** 그래픽 품질을 바꾼다. 즉시 적용하며 저장은 하지 않는다. */
  setQuality(quality: GraphicsQuality): void {
    this.adaptive = quality === "auto" ? new AdaptiveQuality() : null;
    this.applyProfile(this.adaptive ? this.adaptive.profile : baseProfile(quality));
  }

  private applyProfile(profile: RenderProfile): void {
    const shadowsChanged = profile.shadows !== this.profile.shadows;
    this.profile = profile;
    this.renderer.setPixelRatio(profile.pixelRatio);
    this.resize();
    this.renderer.shadowMap.enabled = profile.shadows;
    this.key.castShadow = profile.shadows;
    if (shadowsChanged) {
      this.scene.traverse((object) => {
        if (!(object instanceof THREE.Mesh)) return;
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.needsUpdate = true;
      });
    }
  }

  /** 닉네임·팀이 바뀌면 유니폼과 체형을 다시 뽑는다. */
  restyle(side: Side, nickname: string): void {
    const appearance = appearanceFor(side, nickname || "SC INTER");
    this.model.dispose();
    this.scene.remove(this.model.group);
    this.model = createPlayerModel(appearance, this.height);
    this.animator = new PlayerAnimator(this.model.rig);
    this.scene.add(this.model.group);
    // 새 재질은 지금 그림자 설정으로 처음 컴파일되므로 따로 할 일이 없다.
  }

  update(dt: number): void {
    if (this.adaptive?.sample(dt * 1000)) this.applyProfile(this.adaptive.profile);
    this.stepTime += dt;
    const current = SHOWCASE[this.step] ?? SHOWCASE[0]!;
    if (this.stepTime > current.seconds) {
      this.stepTime = 0;
      this.step = (this.step + 1) % SHOWCASE.length;
    }
    const showcase = SHOWCASE[this.step] ?? SHOWCASE[0]!;

    this.animator.update(dt, {
      anim: showcase.anim,
      speed: showcase.speed,
      charge: showcase.anim === "shoot" ? Math.min(1, this.stepTime / 0.4) : 0,
      dribbling: showcase.anim === "dribble",
      skill: null,
      // 개인기 클립은 진행도를 남은 시간으로 주므로 역산해서 넘긴다.
      skillMs: Math.max(0, (showcase.seconds - this.stepTime) * 1000),
    });

    // 천천히 돌려 앞뒤(등번호)를 모두 보여 준다.
    this.spin += dt * 0.42;
    this.model.group.rotation.y = this.spin;

    // 카메라는 머리끝부터 축구화까지 여유 있게 담는다.
    // 세로로 긴 무대에서도 발이 잘리지 않도록 화면 비율에 맞춰 거리를 잡는다.
    const bob = Math.sin(this.spin * 0.7) * 0.04;
    const framed = this.height * 1.5;
    const vertical = 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const needed = framed / vertical;
    const byWidth = framed / (vertical * Math.max(0.55, this.camera.aspect));
    const distance = Math.max(needed, byWidth);
    this.camera.position.set(0, this.height * 0.72 + bob, distance);
    this.camera.lookAt(0, this.height * 0.6, 0);

    this.renderer.render(this.scene, this.camera);
  }

  resize(): void {
    const canvas = this.renderer.domElement;
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** 지금 보여 주는 동작 이름. 프리뷰 옆 캡션에 쓴다. */
  get currentAnim(): AnimState {
    return (SHOWCASE[this.step] ?? SHOWCASE[0]!).anim;
  }

  dispose(): void {
    this.model.dispose();
    this.pedestal.geometry.dispose();
    (this.pedestal.material as THREE.Material).dispose();
    this.renderer.dispose();
    /*
     * dispose() 만으로는 WebGL 컨텍스트가 반납되지 않는다.
     * 로비와 경기를 오갈 때마다 렌더러를 새로 만들기 때문에, 이걸 빼먹으면
     * 브라우저의 컨텍스트 상한(보통 16개)에 걸려 프레임이 1fps 까지 떨어진다.
     */
    this.renderer.forceContextLoss();
  }
}
