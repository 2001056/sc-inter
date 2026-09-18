/**
 * 뼈를 직접 돌려서 동작을 만든다.
 *
 * 애니메이션 파일(clip)을 불러오지 않고 매 프레임 자세를 계산하는 방식이라
 * 좋은 점이 세 가지 있다.
 *  - 달리기 사이클을 "이동 거리" 로 돌리므로 속도가 어떻든 발이 땅에서 미끄러지지 않는다.
 *  - 슛 충전량처럼 0~1 로 오는 값에 자세를 그대로 연결할 수 있다.
 *  - 서버가 새 개인기를 추가해도 함수 하나만 더 쓰면 된다.
 *
 * 축 규약: 모델은 +Z 를 바라보고 서 있다. 아래로 뻗은 뼈 기준으로
 *  - `rotation.x` 가 음수면 앞(+Z)으로, 양수면 뒤(-Z)로 스윙한다.
 *  - `rotation.z` 가 양수면 +X 쪽(모델 기준 왼쪽)으로 벌어진다.
 */
import * as THREE from "three";
import type { AnimState, SkillKind } from "../net/protocol.ts";
import type { BuiltSkeleton } from "./rig.ts";

export interface AnimationInput {
  anim: AnimState;
  /** m/s. 달리기 사이클 속도를 정한다. */
  speed: number;
  /** 0~1 슛 충전량. 차오르는 동안 몸이 뒤로 젖혀진다. */
  charge: number;
  dribbling: boolean;
  skill: SkillKind | null;
  /** 진행 중인 개인기의 남은 시간(ms). 0 에 가까울수록 동작 끝. */
  skillMs: number;
}

const TAU = Math.PI * 2;
/** 한 걸음의 보폭(m). 이 값으로 달리기 사이클 속도를 정한다. */
const STRIDE = 1.65;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export class PlayerAnimator {
  private readonly bones: THREE.Bone[];
  private readonly index = new Map<string, number>();
  private readonly target: Float32Array;
  private readonly current: Float32Array;
  /** [높이 오프셋, pitch, yaw, roll] */
  private readonly rootTarget = new Float32Array(4);
  private readonly rootCurrent = new Float32Array(4);
  private readonly hipsRestY: number;

  private stridePhase = Math.random();
  private clock = Math.random() * 10;
  /** 킥은 서버에서 한 순간만 오므로 여기서 짧은 클립으로 늘려 준다. */
  private shootTimer = 0;
  private passTimer = 0;
  private lastAnim: AnimState = "idle";
  /** 개인기 전체 길이. 서버 상수를 몰라도 처음 본 값으로 스스로 맞춘다. */
  private skillSpan = new Map<string, number>();

  constructor(rig: BuiltSkeleton) {
    this.bones = rig.bones;
    rig.bones.forEach((bone, i) => this.index.set(bone.name, i));
    this.target = new Float32Array(rig.bones.length * 3);
    this.current = new Float32Array(rig.bones.length * 3);
    this.hipsRestY = rig.byName.get("hips")?.position.y ?? 0.98;
  }

  private set(name: string, x: number, y: number, z: number): void {
    const i = this.index.get(name);
    if (i === undefined) return;
    this.target[i * 3] = x;
    this.target[i * 3 + 1] = y;
    this.target[i * 3 + 2] = z;
  }

  private add(name: string, x: number, y: number, z: number): void {
    const i = this.index.get(name);
    if (i === undefined) return;
    this.target[i * 3] = (this.target[i * 3] ?? 0) + x;
    this.target[i * 3 + 1] = (this.target[i * 3 + 1] ?? 0) + y;
    this.target[i * 3 + 2] = (this.target[i * 3 + 2] ?? 0) + z;
  }

  update(dt: number, input: AnimationInput): void {
    this.clock += dt;

    // 슛과 패스는 서버에서 한 순간만 오므로 여기서 짧은 클립으로 늘려 준다.
    if (input.anim !== this.lastAnim) {
      if (input.anim === "shoot") this.shootTimer = 0.44;
      else if (input.anim === "pass") this.passTimer = 0.3;
    }
    this.lastAnim = input.anim;
    this.shootTimer = Math.max(0, this.shootTimer - dt);
    this.passTimer = Math.max(0, this.passTimer - dt);

    // 달리기 사이클은 시간이 아니라 이동 거리로 돈다. 그래야 발이 미끄러지지 않는다.
    if (input.speed > 0.12) this.stridePhase = (this.stridePhase + (input.speed * dt) / STRIDE) % 1;

    this.target.fill(0);
    this.rootTarget.fill(0);

    let snap = false;
    switch (input.anim) {
      case "run":
        this.poseLocomotion(input.speed, 1);
        break;
      case "sprint":
        this.poseLocomotion(input.speed, 1.28);
        break;
      case "dribble":
        this.poseLocomotion(input.speed, 0.8);
        this.poseDribbleOverlay();
        break;
      case "shoot":
      case "pass":
        this.poseLocomotion(input.speed, 0.85);
        snap = true;
        break;
      case "stepover":
        this.poseStepover(this.skillProgress("stepover", input.skillMs));
        snap = true;
        break;
      // 서버가 좌우를 따로 내려 준다. 하나로 합쳐 받으면 한쪽이 idle 로 떨어진다.
      case "feintLeft":
        this.poseBodyFeint(1, this.skillProgress("feintLeft", input.skillMs));
        snap = true;
        break;
      case "feintRight":
        this.poseBodyFeint(-1, this.skillProgress("feintRight", input.skillMs));
        snap = true;
        break;
      case "dragback":
        this.poseDragBack(this.skillProgress("dragback", input.skillMs));
        snap = true;
        break;
      case "tackle":
        this.poseSlide(this.skillProgress("tackle", input.skillMs));
        snap = true;
        break;
      case "prone":
        this.poseProne();
        break;
      case "celebrate":
        this.poseCelebrate();
        break;
      case "idle":
      default:
        this.poseIdle();
        break;
    }

    // 충전·슛·패스는 다른 동작 위에 얹는다. 달리면서도 몸이 그 자세를 잡는다.
    if (input.charge > 0.02 && this.shootTimer <= 0 && this.passTimer <= 0) {
      this.poseCharge(input.charge);
    }
    if (this.passTimer > 0) {
      this.posePass(1 - this.passTimer / 0.3);
      snap = true;
    }
    if (this.shootTimer > 0) {
      this.poseKick(1 - this.shootTimer / 0.44);
      snap = true;
    }

    this.blend(dt, snap ? 0.035 : 0.09);
    this.apply();
  }

  /** 서버가 개인기 길이 상수를 안 알려 주므로 관측한 최대값을 길이로 삼는다. */
  private skillProgress(kind: string, remainMs: number): number {
    const seen = this.skillSpan.get(kind) ?? 0;
    if (remainMs > seen) this.skillSpan.set(kind, remainMs);
    const span = Math.max(1, this.skillSpan.get(kind) ?? remainMs);
    return clamp(1 - remainMs / span, 0, 1);
  }

  private poseIdle(): void {
    const breathe = Math.sin(this.clock * 1.5);
    const sway = Math.sin(this.clock * 0.7);
    this.set("hips", -0.02, sway * 0.03, 0);
    this.set("spine", 0.03 + breathe * 0.012, 0, 0);
    this.set("chest", 0.02, sway * 0.02, 0);
    this.set("head", -0.02 + breathe * 0.01, sway * 0.06, 0);

    this.set("upperLegL", -0.05, 0, 0.03);
    this.set("upperLegR", -0.05, 0, -0.03);
    this.set("lowerLegL", 0.1, 0, 0);
    this.set("lowerLegR", 0.1, 0, 0);
    this.set("footL", -0.05, 0, 0);
    this.set("footR", -0.05, 0, 0);

    this.set("upperArmL", -0.08 + breathe * 0.02, 0, 0.14);
    this.set("upperArmR", -0.08 + breathe * 0.02, 0, -0.14);
    this.set("lowerArmL", -0.34, 0, 0.06);
    this.set("lowerArmR", -0.34, 0, -0.06);
    this.rootTarget[0] = -0.01;
  }

  /**
   * 걷기·달리기·전력질주를 한 함수로 만든다. `gain` 이 커질수록 보폭·팔치기가 커진다.
   * 왼발과 오른발은 위상이 반 바퀴 어긋나 있다.
   */
  private poseLocomotion(speed: number, gain: number): void {
    const phi = this.stridePhase * TAU;
    // 느리게 움직일 때는 동작을 줄여 걷기처럼 보이게 한다.
    const intensity = clamp(speed / 5.5, 0.25, 1) * gain;
    const swing = 0.62 * intensity;

    const leg = (side: "L" | "R", offset: number) => {
      const p = phi + offset;
      const thigh = Math.sin(p) * swing;
      // 무릎은 다리를 뒤로 보낼 때와 들어 올릴 때 크게 접힌다.
      const knee = (0.16 + 0.95 * Math.max(0, -Math.cos(p + 0.9))) * intensity + 0.12;
      const ankle = -0.12 + Math.sin(p + 0.7) * 0.32 * intensity;
      this.set(`upperLeg${side}`, -thigh, 0, side === "L" ? 0.02 : -0.02);
      this.set(`lowerLeg${side}`, knee, 0, 0);
      this.set(`foot${side}`, ankle, 0, 0);
    };
    leg("L", 0);
    leg("R", Math.PI);

    const armSwing = swing * 0.78;
    const elbow = -0.55 - 0.5 * intensity;
    this.set("upperArmL", Math.sin(phi + Math.PI) * armSwing, 0, 0.16 + 0.06 * intensity);
    this.set("upperArmR", Math.sin(phi) * armSwing, 0, -0.16 - 0.06 * intensity);
    this.set("lowerArmL", elbow, 0, 0.1);
    this.set("lowerArmR", elbow, 0, -0.1);

    // 상체는 앞으로 기울고, 골반과 어깨는 서로 반대로 비틀린다.
    const lean = 0.1 + 0.16 * intensity;
    this.set("hips", -lean * 0.35, Math.sin(phi) * 0.1 * intensity, 0);
    this.set("spine", -lean * 0.4, -Math.sin(phi) * 0.12 * intensity, 0);
    this.set("chest", -lean * 0.25, -Math.sin(phi) * 0.14 * intensity, 0);
    this.set("head", lean * 0.55, 0, 0);

    // 두 발이 땅을 밀 때마다 몸이 살짝 떴다 내려온다.
    this.rootTarget[0] = -0.035 * intensity + Math.abs(Math.cos(phi)) * 0.045 * intensity;
    this.rootTarget[3] = Math.sin(phi) * 0.05 * intensity;
  }

  /** 공을 몰 때는 팔을 더 벌리고 시선을 아래로 둔다. */
  private poseDribbleOverlay(): void {
    this.add("upperArmL", 0, 0, 0.22);
    this.add("upperArmR", 0, 0, -0.22);
    this.add("lowerArmL", -0.2, 0, 0);
    this.add("lowerArmR", -0.2, 0, 0);
    this.add("head", 0.16, 0, 0);
    this.add("spine", -0.06, 0, 0);
  }

  /** 슛 버튼을 누르고 있는 동안. 오른 다리를 뒤로 당기고 상체를 젖힌다. */
  private poseCharge(charge: number): void {
    const c = smoothstep(0, 1, charge);
    this.add("upperLegR", 0.55 * c, 0, 0);
    this.add("lowerLegR", 0.75 * c, 0, 0);
    this.add("hips", 0.1 * c, -0.18 * c, 0);
    this.add("spine", 0.12 * c, -0.2 * c, 0);
    this.add("chest", 0.06 * c, -0.16 * c, 0);
    this.add("upperArmL", -0.5 * c, 0, 0.3 * c);
    this.add("upperArmR", 0.35 * c, 0, -0.2 * c);
    this.rootTarget[0] = (this.rootTarget[0] ?? 0) - 0.03 * c;
  }

  /** 실제로 차는 0.44초. 당기기 -> 때리기 -> 따라 나가기. */
  private poseKick(p: number): void {
    const windUp = smoothstep(0, 0.28, p) * (1 - smoothstep(0.28, 0.46, p));
    const strike = smoothstep(0.26, 0.5, p);
    const follow = smoothstep(0.5, 1, p);

    this.set("upperLegR", 0.75 * windUp - 0.95 * strike + 0.35 * follow, 0, -0.05);
    this.set("lowerLegR", 1.0 * windUp + 0.15 * (1 - strike) + 0.25 * follow, 0, 0);
    this.set("footR", -0.35 * strike, 0, 0);

    // 디딤발은 무릎을 굽혀 버틴다.
    this.set("upperLegL", -0.2 - 0.18 * strike, 0, 0.06);
    this.set("lowerLegL", 0.35 + 0.25 * strike, 0, 0);
    this.set("footL", -0.1, 0, 0);

    const twist = -0.3 * windUp + 0.32 * strike;
    this.set("hips", 0.1 * windUp - 0.16 * strike, twist, 0);
    this.set("spine", 0.14 * windUp - 0.2 * strike, twist * 1.1, 0);
    this.set("chest", -0.1 * strike, twist * 0.9, 0);
    this.set("head", 0.18 * strike, -twist * 0.4, 0);

    this.set("upperArmL", -0.9 * strike, 0, 0.7 * strike + 0.2);
    this.set("upperArmR", 0.6 * strike, 0, -0.45 * strike - 0.2);
    this.set("lowerArmL", -0.5, 0, 0.2);
    this.set("lowerArmR", -0.4, 0, -0.2);

    this.rootTarget[0] = -0.05 - 0.05 * strike;
    this.rootTarget[3] = 0.16 * strike;
  }

  /**
   * 스텝오버: 한 발이 공 위를 바깥으로 크게 돌아 넘어가고 몸이 반대로 흔들린다.
   * 앞뒤 스윙(x)과 벌림(z)을 90도 어긋난 사인으로 섞으면 원을 그린다.
   */
  private poseStepover(p: number): void {
    const arc = Math.sin(p * Math.PI);
    const circle = Math.sin(p * TAU);

    this.set("upperLegR", -0.5 * circle - 0.25 * arc, 0, -0.75 * arc);
    this.set("lowerLegR", 0.55 + 0.45 * arc, 0, 0);
    this.set("footR", -0.25 * arc, 0, 0);

    this.set("upperLegL", -0.12, 0, 0.05);
    this.set("lowerLegL", 0.35 + 0.25 * arc, 0, 0);
    this.set("footL", -0.1, 0, 0);

    // 상체를 반대쪽으로 기울여 페인트 느낌을 준다.
    this.set("hips", -0.06, -0.28 * arc, -0.2 * arc);
    this.set("spine", -0.1, 0.34 * arc, 0.24 * arc);
    this.set("chest", -0.04, 0.18 * arc, 0.14 * arc);
    this.set("head", 0.25, -0.2 * arc, 0);

    this.set("upperArmL", -0.3 * arc, 0, 0.85 * arc + 0.2);
    this.set("upperArmR", -0.5 * arc, 0, -0.55 * arc - 0.2);
    this.set("lowerArmL", -0.55, 0, 0.25);
    this.set("lowerArmR", -0.75, 0, -0.25);

    this.rootTarget[0] = -0.04 - 0.05 * arc;
    this.rootTarget[3] = -0.22 * arc;
  }

  /**
   * 바디페인트: 발이 아니라 상체를 쓴다.
   * 한쪽으로 체중을 확 실었다가 반대로 빠져나가는 동작이라 스텝오버와 실루엣이 다르다.
   * `dir` 이 +1 이면 모델 기준 왼쪽(+X)으로 속인다.
   */
  private poseBodyFeint(dir: 1 | -1, p: number): void {
    // 앞의 60%는 속이는 쪽으로 크게, 나머지는 반대로 튕겨 나간다.
    const fake = Math.sin(clamp(p / 0.62, 0, 1) * Math.PI);
    const escape = smoothstep(0.58, 1, p);
    const bend = dir * (fake - escape * 0.8);

    this.set("hips", -0.08, -bend * 0.45, bend * 0.5);
    this.set("spine", -0.06, -bend * 0.4, bend * 0.42);
    this.set("chest", -0.04, -bend * 0.3, bend * 0.3);
    this.set("head", 0.14, -bend * 0.5, bend * 0.18);

    // 체중을 받는 다리는 깊게 굽고, 반대 다리는 바깥으로 뻗어 버틴다.
    const plantSide = dir > 0 ? "L" : "R";
    const freeSide = dir > 0 ? "R" : "L";
    this.set(`upperLeg${plantSide}`, -0.2 - 0.25 * fake, 0, dir * (0.1 + 0.3 * fake));
    this.set(`lowerLeg${plantSide}`, 0.45 + 0.6 * fake, 0, 0);
    this.set(`foot${plantSide}`, -0.15, 0, 0);
    this.set(`upperLeg${freeSide}`, -0.35 * fake + 0.3 * escape, 0, -dir * 0.45 * fake);
    this.set(`lowerLeg${freeSide}`, 0.3 + 0.4 * escape, 0, 0);
    this.set(`foot${freeSide}`, -0.1, 0, 0);

    // 팔로 균형을 잡는다. 속이는 쪽 팔이 크게 벌어진다.
    this.set("upperArmL", -0.35 - 0.3 * fake, 0, 0.35 + dir * 0.75 * fake);
    this.set("upperArmR", -0.35 - 0.3 * fake, 0, -0.35 + dir * 0.75 * fake);
    this.set("lowerArmL", -0.6, 0, 0.2);
    this.set("lowerArmR", -0.6, 0, -0.2);

    this.rootTarget[0] = -0.06 - 0.09 * fake;
    this.rootTarget[3] = bend * 0.3;
  }

  /**
   * 드래그백: 발바닥으로 공을 뒤로 끌면서 몸도 같이 물러난다.
   * 앞으로 뻗었다가 끌어당기는 한 방향 동작이라 스텝오버의 원 운동과 겹치지 않는다.
   */
  private poseDragBack(p: number): void {
    const reach = smoothstep(0, 0.34, p);
    const pull = smoothstep(0.3, 0.72, p);
    const settle = smoothstep(0.7, 1, p);

    // 오른발이 공 위로 뻗었다가 뒤로 끌린다.
    this.set("upperLegR", -0.75 * reach + 1.0 * pull - 0.35 * settle, 0, -0.05);
    this.set("lowerLegR", 0.1 + 0.85 * pull - 0.3 * settle, 0, 0);
    // 발끝을 세워 발바닥으로 누르는 모양을 만든다.
    this.set("footR", -0.5 * reach + 0.25 * pull, 0, 0);

    // 디딤발은 굽혀 버티고 골반은 뒤로 빠진다.
    this.set("upperLegL", -0.1 + 0.3 * pull, 0, 0.08);
    this.set("lowerLegL", 0.45 + 0.35 * pull, 0, 0);
    this.set("footL", -0.12, 0, 0);

    this.set("hips", 0.22 * pull - 0.05, 0.12 * reach, 0);
    this.set("spine", 0.2 * pull, 0.1 * reach, 0);
    this.set("chest", 0.1 * pull, 0.08 * reach, 0);
    this.set("head", 0.3 - 0.1 * pull, 0, 0);

    this.set("upperArmL", -0.55 - 0.35 * pull, 0, 0.55 + 0.25 * pull);
    this.set("upperArmR", -0.3 - 0.2 * pull, 0, -0.45 - 0.2 * pull);
    this.set("lowerArmL", -0.7, 0, 0.25);
    this.set("lowerArmR", -0.55, 0, -0.25);

    this.rootTarget[0] = -0.05 - 0.08 * pull;
    this.rootTarget[1] = 0.1 * reach;
  }

  /** 인사이드 패스: 슛보다 짧고 낮게, 발 안쪽으로 밀어 준다. */
  private posePass(p: number): void {
    const back = smoothstep(0, 0.3, p) * (1 - smoothstep(0.3, 0.55, p));
    const push = smoothstep(0.28, 0.62, p);
    const after = smoothstep(0.6, 1, p);

    // 발목을 바깥으로 열어 발 안쪽으로 미는 모양.
    this.set("upperLegR", 0.32 * back - 0.5 * push + 0.2 * after, 0, -0.3 * push);
    this.set("lowerLegR", 0.5 * back + 0.12, 0, 0);
    this.set("footR", -0.12, -0.5 * push, 0);

    this.set("upperLegL", -0.16 - 0.1 * push, 0, 0.08);
    this.set("lowerLegL", 0.3 + 0.12 * push, 0, 0);

    this.set("hips", -0.04, -0.14 * push, 0);
    this.set("spine", -0.06, -0.16 * push, 0);
    this.set("chest", -0.04, -0.12 * push, 0);
    this.set("head", 0.22, -0.1 * push, 0);

    this.set("upperArmL", -0.45 * push, 0, 0.42 + 0.2 * push);
    this.set("upperArmR", 0.25 * push, 0, -0.32);
    this.set("lowerArmL", -0.55, 0, 0.2);
    this.set("lowerArmR", -0.45, 0, -0.2);

    this.rootTarget[0] = -0.04;
    this.rootTarget[3] = 0.08 * push;
  }

  /** 슬라이딩 태클: 몸을 눕히면서 한 다리를 앞으로 길게 뻗는다. */
  private poseSlide(p: number): void {
    const down = smoothstep(0, 0.22, p);
    const up = smoothstep(0.78, 1, p);
    const lying = down * (1 - up);

    this.set("upperLegR", -1.0 * lying - 0.1, 0, -0.1 * lying);
    this.set("lowerLegR", 0.08, 0, 0);
    this.set("footR", -0.2, 0, 0);

    this.set("upperLegL", -0.25 * lying, 0, 0.35 * lying);
    this.set("lowerLegL", 1.7 * lying + 0.15, 0, 0);
    this.set("footL", -0.15, 0, 0);

    this.set("hips", 0.2 * lying, 0.2 * lying, 0.35 * lying);
    this.set("spine", 0.22 * lying, 0.16 * lying, 0.2 * lying);
    this.set("chest", 0.12 * lying, 0.1 * lying, 0.1 * lying);
    this.set("head", -0.3 * lying, -0.2 * lying, 0);

    this.set("upperArmL", 1.1 * lying, 0, 0.6 * lying + 0.2);
    this.set("upperArmR", 0.9 * lying, 0, -0.5 * lying - 0.2);
    this.set("lowerArmL", -0.3, 0, 0.2);
    this.set("lowerArmR", -0.3, 0, -0.2);

    // 몸 전체를 눕히고 낮춘다.
    this.rootTarget[0] = -0.62 * lying;
    this.rootTarget[1] = 1.15 * lying;
    this.rootTarget[3] = 0.28 * lying;
  }

  /** 넘어져 있는 상태. 일어나기 전까지 땅에 붙어 있는다. */
  private poseProne(): void {
    this.set("upperLegL", -0.3, 0, 0.25);
    this.set("upperLegR", -0.15, 0, -0.2);
    this.set("lowerLegL", 0.9, 0, 0);
    this.set("lowerLegR", 0.5, 0, 0);
    this.set("hips", 0.15, 0.25, 0.4);
    this.set("spine", 0.2, 0.2, 0.25);
    this.set("head", -0.4, -0.25, 0);
    this.set("upperArmL", 1.4, 0, 0.8);
    this.set("upperArmR", 1.1, 0, -0.6);
    this.set("lowerArmL", -0.6, 0, 0.3);
    this.set("lowerArmR", -0.6, 0, -0.3);
    this.rootTarget[0] = -0.78;
    this.rootTarget[1] = 1.42;
    this.rootTarget[3] = 0.3;
  }

  /** 득점 세리머니: 두 팔을 들고 가볍게 뛴다. */
  private poseCelebrate(): void {
    const bounce = Math.abs(Math.sin(this.clock * 4.2));
    const sway = Math.sin(this.clock * 2.1);

    this.set("upperArmL", -0.2, 0, 2.15 + sway * 0.12);
    this.set("upperArmR", -0.2, 0, -2.15 + sway * 0.12);
    this.set("lowerArmL", -0.35, 0, 0.25);
    this.set("lowerArmR", -0.35, 0, -0.25);

    this.set("upperLegL", -0.1 - bounce * 0.2, 0, 0.06);
    this.set("upperLegR", -0.1 - bounce * 0.2, 0, -0.06);
    this.set("lowerLegL", 0.15 + bounce * 0.45, 0, 0);
    this.set("lowerLegR", 0.15 + bounce * 0.45, 0, 0);
    this.set("footL", -0.25 * bounce, 0, 0);
    this.set("footR", -0.25 * bounce, 0, 0);

    this.set("hips", 0.05, sway * 0.16, 0);
    this.set("spine", 0.14, sway * 0.12, 0);
    this.set("chest", 0.1, sway * 0.1, 0);
    this.set("head", -0.2, sway * 0.2, 0);

    this.rootTarget[0] = -0.06 + bounce * 0.14;
  }

  /** 목표 자세로 서서히 이동한다. `tau` 가 작을수록 딱딱 끊어 붙는다. */
  private blend(dt: number, tau: number): void {
    const k = 1 - Math.exp(-dt / Math.max(0.001, tau));
    for (let i = 0; i < this.current.length; i += 1) {
      this.current[i]! += (this.target[i]! - this.current[i]!) * k;
    }
    for (let i = 0; i < this.rootCurrent.length; i += 1) {
      this.rootCurrent[i]! += (this.rootTarget[i]! - this.rootCurrent[i]!) * k;
    }
  }

  private apply(): void {
    for (let i = 0; i < this.bones.length; i += 1) {
      const bone = this.bones[i]!;
      bone.rotation.set(this.current[i * 3]!, this.current[i * 3 + 1]!, this.current[i * 3 + 2]!);
    }
    const hips = this.bones[this.index.get("hips") ?? 0];
    if (!hips) return;
    hips.position.y = this.hipsRestY + this.rootCurrent[0]!;
    // 루트에 얹는 기울기는 hips 자체 회전에 더한다.
    hips.rotation.x += this.rootCurrent[1]!;
    hips.rotation.y += this.rootCurrent[2]!;
    hips.rotation.z += this.rootCurrent[3]!;
  }
}
