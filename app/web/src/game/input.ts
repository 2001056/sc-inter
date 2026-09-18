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
  /** 모든 키를 놓은 상태가 됐을 때 부르는 콜백. 서버에 즉시 중립 입력을 보내는 데 쓴다. */
  private releaseListener: (() => void) | null = null;

  /**
   * 글자를 입력하는 칸에 포커스가 있으면 게임 조작으로 가로채지 않는다.
   * 닉네임 칸에서 D 를 눌렀는데 슛이 나가면 안 된다.
   */
  private isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
  }

  attach(target: Window = window): () => void {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (this.isTyping(ev.target)) return;
      // Shift 상태는 매 이벤트마다 다시 읽는다. 창을 오갈 때 눌림/뗌을 놓쳐도 어긋나지 않는다.
      this.syncShift(ev.shiftKey);
      if (ev.key === "Shift") return;

      if (ev.code === "KeyV") {
        if (!ev.repeat) this.cameraToggleHandler?.();
        return;
      }
      if (!this.enabled) return;

      const move = MOVE_KEYS[ev.code];
      if (move) {
        // 방향키는 페이지를 스크롤시키므로 막는다.
        ev.preventDefault();
        /*
         * 자동 반복(ev.repeat)도 버리지 않고 눌림 상태를 다시 세운다.
         * 어떤 이유로든 keyup 을 놓쳐 상태가 어긋나도 다음 반복에서 스스로 복구된다.
         * 예전에는 Shift 를 누른 채 방향키를 쓰면 그 방향키가 `held` 에 들어가지
         * 못한 채 keyup 만 처리돼, 키를 계속 누르고 있는데도 이동이 0 으로 멈췄다.
         */
        this.held.add(move);
        // 개인기는 누르는 순간 한 번만. 다만 이동은 그대로 이어진다
        // (실제 축구에서도 달리면서 스텝오버를 한다).
        if (!ev.repeat && ev.shiftKey) this.pendingSkill = this.toWorld(SCREEN_DIR[move]);
        return;
      }

      const hold = HOLD_KEYS[ev.code];
      if (hold) {
        this.held.add(hold);
        return;
      }

      if (ev.repeat) return;
      if (ev.code === "KeyS") this.pendingPass = true;
      else if (ev.code === "KeyQ") this.pendingTackle = true;
      else if (ev.code === "KeyC") this.pendingSwitch = true;
    };

    const onKeyUp = (ev: KeyboardEvent) => {
      /*
       * 뗌은 글자 입력 칸에서 올라와도 반드시 처리한다.
       * 방향키를 누른 채 입력 칸을 클릭하고 거기서 손을 떼면 keyup 이 그 칸에서
       * 올라오는데, 이때 무시해 버리면 그 방향이 영영 눌린 채로 남는다.
       * 가로채지 않는 것은 "누름" 뿐이다.
       */
      this.syncShift(ev.key === "Shift" ? false : ev.shiftKey);
      if (ev.key === "Shift") return;
      const move = MOVE_KEYS[ev.code];
      if (move) {
        this.held.delete(move);
        return;
      }
      const hold = HOLD_KEYS[ev.code];
      if (hold) this.held.delete(hold);
    };

    /*
     * 창을 벗어나면 keyup 이 오지 않는다. 그대로 두면 선수가 계속 달린다.
     * 전부 놓은 것으로 보고, 다음 전송 주기를 기다리지 않고 바로 중립 입력을 내보낸다.
     * 탭을 숨기면 requestAnimationFrame 이 멈춰 전송 자체가 서지 않으므로
     * visibilitychange 도 같이 본다.
     */
    const onBlur = () => {
      this.syncShift(false);
      this.releaseAll();
      this.releaseListener?.();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onBlur();
    };

    target.addEventListener("keydown", onKeyDown);
    target.addEventListener("keyup", onKeyUp);
    target.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
      target.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }

  /** 입력이 전부 풀렸을 때 즉시 알림을 받는다. */
  onRelease(handler: (() => void) | null): void {
    this.releaseListener = handler;
  }

  private syncShift(down: boolean): void {
    if (this.shiftDown === down) return;
    this.shiftDown = down;
    /*
     * 방향키를 이미 누르고 있다가 Shift 를 나중에 누르는 것이 실제로 가장 흔한 순서다
     * ("달리다가 스텝오버"). 이때는 새 방향키 keydown 이 오지 않으므로
     * Shift 가 눌리는 순간 지금 향하고 있는 방향으로 개인기를 건다.
     * 반대 순서(Shift 먼저, 방향키 나중)는 방향키 keydown 쪽에서 처리한다.
     */
    if (down && this.enabled) {
      const direction = this.heldDirection();
      if (direction) this.pendingSkill = this.toWorld(direction);
    }
    this.shiftListener?.(down);
  }

  /** 지금 눌려 있는 방향키를 화면 기준 단위 벡터 하나로 모은다. 없으면 null. */
  private heldDirection(): [number, number] | null {
    let forward = 0;
    let strafe = 0;
    if (this.held.has("up")) forward += 1;
    if (this.held.has("down")) forward -= 1;
    if (this.held.has("right")) strafe += 1;
    if (this.held.has("left")) strafe -= 1;
    const len = Math.hypot(forward, strafe);
    if (len < 1e-6) return null;
    return [forward / len, strafe / len];
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
