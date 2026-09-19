/**
 * 입력 전송 박자(30Hz)를 렌더 루프에서 떼어 낸 타이머.
 *
 * 예전에는 `requestAnimationFrame` 루프 안에서 입력을 보냈다. 그러면 렌더가 느린
 * 기기(초당 15프레임)에서는 입력도 초당 15번으로 떨어져 조작이 굼떠진다. 3D 가 느려도
 * 조작만큼은 서버에 제때 닿아야 하므로 입력은 따로 도는 타이머로 보낸다.
 *
 * 지키는 것:
 *  - 탭이 숨으면 타이머를 세운다. 숨기 직전의 중립 입력은 `InputController` 의
 *    `onRelease` 가 이미 한 번 보낸다(`flush`).
 *  - 연결이 열려 있지 않으면 보내지 않고, 한 번만 나가야 하는 값(패스·태클·개인기·전환)은
 *    **버린다**. 재접속한 뒤 몇 초 전에 누른 패스가 뒤늦게 나가면 안 된다.
 *    보내지 않은 입력에는 `seq` 도 쓰지 않는다(번호는 `Connection.sendInput` 이 올린다).
 *  - `seq` 단조 증가는 `Connection` 이 맡는다. 여기서는 번호를 만들지 않는다.
 *
 * 타이머만 두면 생기는 구멍: 자바스크립트 메인 스레드가 프레임마다 오래 막히면
 * 브라우저가 렌더 콜백을 먼저 돌리느라 타이머가 굶는다(측정: 프레임당 80ms 막힘에서
 * 초당 3회). 그래서 렌더 루프도 매 프레임 `due()` 를 불러 "마지막 전송 뒤 한 주기가
 * 지났으면" 보낸다. 두 길 모두 같은 최소 간격(`MIN_GAP_MS`)을 지키므로 합쳐도 초당
 * 약 34회를 넘지 않는다(서버 제한 60회 안쪽, ping 포함).
 */
import type { InputPayload } from "../game/input.ts";

export const INPUT_HZ = 30;
/** 두 전송 사이 최소 간격. 타이머 흔들림(몇 ms)을 봐주려고 주기보다 조금 짧다. */
export const MIN_GAP_MS = 1000 / INPUT_HZ - 4;

export interface InputPumpDeps {
  poll(): InputPayload;
  send(payload: InputPayload): void;
  isOpen(): boolean;
  /** 테스트에서 가짜 타이머를 넣는다. */
  setInterval?(fn: () => void, ms: number): number;
  clearInterval?(id: number): void;
  now?(): number;
}

export class InputPump {
  private readonly deps: InputPumpDeps;
  private timer: number | null = null;
  private running = false;
  private hidden = false;
  private sent = 0;
  private dropped = 0;
  private lastTick = Number.NEGATIVE_INFINITY;

  constructor(deps: InputPumpDeps) {
    this.deps = deps;
  }

  /** 전송을 시작한다. 탭이 숨어 있으면 보일 때까지 기다린다. */
  start(): void {
    this.running = true;
    this.arm();
  }

  stop(): void {
    this.running = false;
    this.disarm();
  }

  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    if (hidden) this.disarm();
    else this.arm();
  }

  /** 다음 주기를 기다리지 않고 지금 한 번 보낸다(창 이탈 시 중립 입력 등). */
  flush(): void {
    this.tick();
  }

  /** 렌더 루프에서 매 프레임 부른다. 마지막 전송 뒤 한 주기가 지났을 때만 보낸다. */
  due(): void {
    if (!this.running || this.hidden) return;
    this.tickIfDue();
  }

  /** 검증용 카운터. */
  get stats(): { sent: number; dropped: number; active: boolean } {
    return { sent: this.sent, dropped: this.dropped, active: this.timer !== null };
  }

  private clock(): number {
    return this.deps.now ? this.deps.now() : performance.now();
  }

  private tickIfDue(): void {
    if (this.clock() - this.lastTick < MIN_GAP_MS) return;
    this.tick();
  }

  private tick(): void {
    this.lastTick = this.clock();
    const payload = this.deps.poll();
    if (!this.deps.isOpen()) {
      this.dropped += 1;
      return;
    }
    this.sent += 1;
    this.deps.send(payload);
  }

  private arm(): void {
    if (!this.running || this.hidden || this.timer !== null) return;
    const set = this.deps.setInterval ?? ((fn, ms) => window.setInterval(fn, ms));
    this.timer = set(() => this.tickIfDue(), 1000 / INPUT_HZ);
  }

  private disarm(): void {
    if (this.timer === null) return;
    const clear = this.deps.clearInterval ?? ((id) => window.clearInterval(id));
    clear(this.timer);
    this.timer = null;
  }
}
