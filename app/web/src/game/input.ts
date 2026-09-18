/**
 * 키보드와 터치를 서버가 아는 입력 한 덩어리로 모은다.
 *
 * 확정된 기본 조작:
 *   이동      방향키(↑↓←→) 만
 *   패스      S       (누른 순간 1회)
 *   슛        D       (누르고 있으면 충전, 떼면 발사)
 *   달리기    E       (누르고 있는 동안)
 *   개인기    Shift + 방향키
 *              ↑ 스텝오버 / ← → 바디페인트 / ↓ 드래그백
 *   태클      Q       (누른 순간 1회)
 *   선수 전환 C       (누른 순간 1회)
 *   시점 전환 V
 *
 * S·D·E 는 동작 키이므로 이동으로 처리하지 않는다(WASD 이동은 폐기됐다).
 *
 * 방향은 화면 기준으로 받는다. 카메라가 늘 내가 공격하는 골대를 보고 있으므로
 * `↑` 는 언제나 "상대 골대 쪽" 이다. 서버에는 월드 좌표로 바꿔서 보내며,
 * 오른쪽 자리에 앉으면 부호만 뒤집으면 된다.
 *
 * 개인기도 "어느 기술" 이 아니라 **방향 벡터**를 보낸다. 앞/좌/우/뒤 중 무엇인지는
 * 그 팀의 공격 방향을 아는 서버가 정한다. 그래야 양쪽 화면의 판정이 어긋나지 않는다.
 */
import type { Vec2 } from "../net/protocol.ts";

export interface InputPayload {
  ax: number;
  ay: number;
  sprint: boolean;
  shoot: boolean;
  pass: boolean;
  tackle: boolean;
  skillDir: Vec2 | null;
  switchPlayer: boolean;
}

type HoldAction = "up" | "down" | "left" | "right" | "shoot" | "sprint";

const MOVE_KEYS: Record<string, "up" | "down" | "left" | "right"> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

const HOLD_KEYS: Record<string, HoldAction> = {
  KeyD: "shoot",
  KeyE: "sprint",
};

/** 화면 기준 방향키 -> (앞으로, 오른쪽으로) 단위 벡터. */
const SCREEN_DIR: Record<"up" | "down" | "left" | "right", [number, number]> = {
  up: [1, 0],
  down: [-1, 0],
  right: [0, 1],
  left: [0, -1],
};

export class InputController {
  private readonly held = new Set<HoldAction>();
  /** 터치 조이스틱 벡터. 화면 기준이며 키보드 입력과 더해진다. */
  private stick = { x: 0, y: 0 };
  /** 다음 전송에 딱 한 번만 실릴 값들. */
  private pendingSkill: Vec2 | null = null;
  private pendingPass = false;
  private pendingTackle = false;
  private pendingSwitch = false;
  /** +1 이면 공격 방향이 +x, -1 이면 -x. */
  private attackDir: 1 | -1 = 1;
  private enabled = false;
  private cameraToggleHandler: (() => void) | null = null;
  /** HUD 가 "지금 개인기 모드" 를 보여 줄 수 있게 Shift 상태를 들고 있는다. */
  private shiftDown = false;
  private shiftListener: ((down: boolean) => void) | null = null;

  attach(target: Window = window): () => void {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === "Shift") {
        this.shiftDown = true;
        this.shiftListener?.(true);
        return;
      }
      if (ev.repeat) return;
      if (ev.code === "KeyV") {
        this.cameraToggleHandler?.();
        return;
      }
      if (!this.enabled) return;

      const move = MOVE_KEYS[ev.code];
      if (move) {
        // 방향키는 페이지를 스크롤시키므로 막는다.
        ev.preventDefault();
        if (this.shiftDown || ev.shiftKey) this.pendingSkill = this.toWorld(SCREEN_DIR[move]);
        else this.held.add(move);
        return;
      }

      const hold = HOLD_KEYS[ev.code];
      if (hold) {
        this.held.add(hold);
        return;
      }

      if (ev.code === "KeyS") this.pendingPass = true;
      else if (ev.code === "KeyQ") this.pendingTackle = true;
      else if (ev.code === "KeyC") this.pendingSwitch = true;
    };

    const onKeyUp = (ev: KeyboardEvent) => {
      if (ev.key === "Shift") {
        this.shiftDown = false;
        this.shiftListener?.(false);
        return;
      }
      const move = MOVE_KEYS[ev.code];
      if (move) {
        this.held.delete(move);
        return;
      }
      const hold = HOLD_KEYS[ev.code];
      if (hold) this.held.delete(hold);
    };

    // 탭을 벗어나면 키를 누른 채로 멈춰 버리므로 전부 놓은 것으로 본다.
    const onBlur = () => {
      this.shiftDown = false;
      this.shiftListener?.(false);
      this.releaseAll();
    };

    target.addEventListener("keydown", onKeyDown);
    target.addEventListener("keyup", onKeyUp);
    target.addEventListener("blur", onBlur);
    return () => {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", onBlur);
    };
  }

  /** 화면 기준 (앞, 오른쪽) 을 경기장 월드 좌표 (x, y) 로 바꾼다. */
  private toWorld([forward, strafe]: [number, number]): Vec2 {
    return { x: forward * this.attackDir, y: strafe * this.attackDir };
  }

  onCameraToggle(handler: (() => void) | null): void {
    this.cameraToggleHandler = handler;
  }

  onShiftChange(handler: ((down: boolean) => void) | null): void {
    this.shiftListener = handler;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  setAttackDir(dir: 1 | -1): void {
    this.attackDir = dir;
  }

  /** 터치 조이스틱에서 -1~1 벡터를 받는다. y 는 화면 위쪽이 +1 이다. */
  setStick(x: number, y: number): void {
    this.stick = { x, y };
  }

  setTouchHold(action: "shoot" | "sprint", down: boolean): void {
    if (down) this.held.add(action);
    else this.held.delete(action);
  }

  /** 모바일 개인기 패드. 화면 기준 방향을 그대로 받는다. */
  triggerSkill(direction: "up" | "down" | "left" | "right"): void {
    if (this.enabled) this.pendingSkill = this.toWorld(SCREEN_DIR[direction]);
  }

  triggerPass(): void {
    if (this.enabled) this.pendingPass = true;
  }

  triggerTackle(): void {
    if (this.enabled) this.pendingTackle = true;
  }

  triggerSwitch(): void {
    if (this.enabled) this.pendingSwitch = true;
  }

  releaseAll(): void {
    this.held.clear();
    this.stick = { x: 0, y: 0 };
    this.pendingSkill = null;
    this.pendingPass = false;
    this.pendingTackle = false;
    this.pendingSwitch = false;
  }

  /** 지금 상태를 읽고, 한 번만 보내야 하는 값들은 비운다. */
  poll(): InputPayload {
    let forward = 0;
    let strafe = 0;
    if (this.held.has("up")) forward += 1;
    if (this.held.has("down")) forward -= 1;
    if (this.held.has("right")) strafe += 1;
    if (this.held.has("left")) strafe -= 1;
    forward += this.stick.y;
    strafe += this.stick.x;

    // 대각선이 빨라지지 않도록 길이를 1로 자른다.
    const len = Math.hypot(forward, strafe);
    if (len > 1) {
      forward /= len;
      strafe /= len;
    }

    const payload: InputPayload = {
      ax: forward * this.attackDir,
      ay: strafe * this.attackDir,
      sprint: this.held.has("sprint"),
      shoot: this.held.has("shoot"),
      pass: this.pendingPass,
      tackle: this.pendingTackle,
      skillDir: this.pendingSkill,
      switchPlayer: this.pendingSwitch,
    };
    this.pendingSkill = null;
    this.pendingPass = false;
    this.pendingTackle = false;
    this.pendingSwitch = false;
    return payload;
  }

  /** HUD 가 눌린 버튼을 표시하기 위한 읽기 전용 상태. */
  snapshotHeld(): { shoot: boolean; sprint: boolean; moving: boolean; skillMode: boolean } {
    return {
      shoot: this.held.has("shoot"),
      sprint: this.held.has("sprint"),
      skillMode: this.shiftDown,
      moving:
        this.held.has("up") ||
        this.held.has("down") ||
        this.held.has("left") ||
        this.held.has("right") ||
        Math.hypot(this.stick.x, this.stick.y) > 0.05,
    };
  }
}

/** 화면과 도움말에 같은 문구를 쓰기 위한 표. */
export const CONTROL_HELP: { keys: string; action: string }[] = [
  { keys: "← ↑ → ↓", action: "이동" },
  { keys: "S", action: "패스" },
  { keys: "D", action: "슛 (길게 누르면 강하게)" },
  { keys: "E", action: "달리기" },
  { keys: "Shift + ↑", action: "스텝오버" },
  { keys: "Shift + ← →", action: "바디페인트" },
  { keys: "Shift + ↓", action: "드래그백" },
  { keys: "Q", action: "태클" },
  { keys: "C", action: "조작 선수 바꾸기" },
  { keys: "V", action: "시점 바꾸기" },
];
