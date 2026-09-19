/**
 * 경기 효과음. 외부 음원 파일 없이 Web Audio 로 그 자리에서 합성한다.
 *
 * 지켜야 하는 것:
 *  - **기본은 꺼짐**, 켜도 작은 소리에서 시작한다. 사무실에서 갑자기 휘슬이 울리면 안 된다.
 *  - `AudioContext` 는 **사용자 동작(클릭·키 입력) 안에서만** 만들거나 깨운다.
 *    브라우저 자동재생 정책도 그렇고, 켜 둔 설정이 저장돼 있어도 첫 입력 전에는 조용하다.
 *  - 탭이 숨거나 끄면 **울리는 중이거나 예약된 소리를 모두 멈추고 끊은 뒤** 멈춘다(`suspend`).
 *    `suspend` 만 하면 컨텍스트 시계도 같이 서서, 예약해 둔 종료 휘슬·함성이 다시 켰을 때
 *    그 자리부터 이어 울린다. 경기 화면을 나가면 닫는다(`dispose`).
 *  - 설정은 `localStorage` 에 두되 읽기·쓰기가 막혀도(시크릿 모드) 예외가 새지 않는다.
 *
 * 소리를 내는 코드는 `SoundCue` 만 안다. 어떤 이벤트에 어떤 소리를 낼지는 `feedback.ts` 가 정한다.
 */
import type { SoundCue } from "./feedback.ts";

export interface AudioSettings {
  enabled: boolean;
  /** 0~1 */
  volume: number;
}

export const DEFAULT_AUDIO: AudioSettings = { enabled: false, volume: 0.35 };

const SETTINGS_KEY = "sc-inter:audio";
/**
 * 동시에 울리는 소리 상한. 슛·패스가 몰려도 소리가 뭉개지지 않게 한다.
 * 휘슬·득점은 경기 흐름을 알리는 소리라 상한에 걸려도 낸다.
 */
const MAX_VOICES = 8;
/** 같은 종류 소리를 이 간격보다 촘촘히 내지 않는다(ms). */
const MIN_GAP_MS: Record<SoundCue["kind"], number> = {
  kick: 70,
  pass: 70,
  whistle: 400,
  finalWhistle: 1500,
  goal: 1500,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** 저장된 설정을 읽는다. 없거나 깨졌거나 저장소가 막혔으면 기본값. */
export function readAudioSettings(storage: Storage | null = safeStorage()): AudioSettings {
  try {
    const raw = storage?.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_AUDIO };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_AUDIO };
    const record = parsed as Record<string, unknown>;
    return {
      enabled: record.enabled === true,
      volume: typeof record.volume === "number" ? clamp01(record.volume) : DEFAULT_AUDIO.volume,
    };
  } catch {
    return { ...DEFAULT_AUDIO };
  }
}

export function writeAudioSettings(
  settings: AudioSettings,
  storage: Storage | null = safeStorage(),
): void {
  try {
    storage?.setItem(
      SETTINGS_KEY,
      JSON.stringify({ enabled: settings.enabled, volume: clamp01(settings.volume) }),
    );
  } catch {
    // 시크릿 모드 등에서 저장이 막힌다. 이번 판 동안은 메모리 값으로 충분하다.
  }
}

type ContextFactory = () => AudioContext | null;

interface Voice {
  /** stop=true 면 발음원을 멈추고, 어느 쪽이든 체인을 끊고 목록에서 뺀다. 멱등. */
  release(stop: boolean): void;
}

function defaultContextFactory(): AudioContext | null {
  const Ctor =
    typeof window === "undefined"
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

export interface GameAudioOptions {
  createContext?: ContextFactory;
  storage?: Storage | null;
  now?: () => number;
}

export class GameAudio {
  private settings: AudioSettings;
  private readonly createContext: ContextFactory;
  private readonly storage: Storage | null;
  private readonly now: () => number;

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  /** 울리는 중이거나 예약된 소리. 끄기·숨김·정리 때 한꺼번에 멈추려고 들고 있는다. */
  private readonly active = new Set<Voice>();
  private readonly lastPlayed = new Map<SoundCue["kind"], number>();
  private hidden = false;
  private disposed = false;

  constructor(options: GameAudioOptions = {}) {
    this.createContext = options.createContext ?? defaultContextFactory;
    this.storage = options.storage === undefined ? safeStorage() : options.storage;
    this.now = options.now ?? (() => performance.now());
    this.settings = readAudioSettings(this.storage);
  }

  get current(): AudioSettings {
    return { ...this.settings };
  }

  /** 소리가 실제로 나갈 수 있는 상태인지(켜짐 + 사용자 동작으로 깨어남 + 탭 보임). */
  get audible(): boolean {
    return (
      !this.disposed &&
      !this.hidden &&
      this.settings.enabled &&
      this.ctx !== null &&
      this.ctx.state === "running"
    );
  }

  /**
   * 사용자 동작 핸들러 안에서만 부른다. 켜져 있을 때만 컨텍스트를 만들거나 깨운다.
   * 꺼져 있으면 아무것도 만들지 않는다(쓰지도 않을 오디오 장치를 잡지 않는다).
   */
  unlock(): void {
    if (this.disposed || this.hidden || !this.settings.enabled) return;
    if (!this.ctx) {
      const ctx = this.createContext();
      if (!ctx) return;
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = this.masterLevel();
      master.connect(ctx.destination);
      this.master = master;
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {
        // 사용자 동작 밖에서 불렸거나 장치가 없다. 다음 동작에서 다시 시도한다.
      });
    }
  }

  /** 켜고 끄기. 켜는 쪽은 클릭 핸들러에서 부르므로 그 자리에서 바로 깨운다. */
  setEnabled(enabled: boolean): void {
    if (this.disposed) return;
    this.settings = { ...this.settings, enabled };
    writeAudioSettings(this.settings, this.storage);
    if (enabled) {
      this.unlock();
      return;
    }
    this.silenceAll();
    this.ctx?.suspend().catch(() => undefined);
  }

  setVolume(volume: number): void {
    if (this.disposed) return;
    this.settings = { ...this.settings, volume: clamp01(volume) };
    writeAudioSettings(this.settings, this.storage);
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(this.masterLevel(), this.ctx.currentTime, 0.02);
    }
  }

  /** 탭이 숨으면 멈춘다. 다시 보일 때는 이미 깨운 적이 있을 때만 이어서 켠다. */
  setHidden(hidden: boolean): void {
    if (this.disposed || this.hidden === hidden) return;
    this.hidden = hidden;
    if (!this.ctx) return;
    if (hidden) {
      this.silenceAll();
      this.ctx.suspend().catch(() => undefined);
    } else if (this.settings.enabled) {
      this.ctx.resume().catch(() => undefined);
    }
  }

  /** 경기 화면을 떠날 때. 오디오 장치를 놓아준다. 이후 호출은 모두 무시된다. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.silenceAll();
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.noise = null;
    ctx?.close().catch(() => undefined);
  }

  /** 효과음 한 번. 낼 수 없는 상태거나 너무 촘촘하면 조용히 넘어가고 false. */
  play(cue: SoundCue): boolean {
    if (!this.audible || !this.ctx || !this.master) return false;
    const essential = cue.kind === "whistle" || cue.kind === "finalWhistle" || cue.kind === "goal";
    if (!essential && this.active.size >= MAX_VOICES) return false;
    const now = this.now();
    const last = this.lastPlayed.get(cue.kind);
    if (last !== undefined && now - last < MIN_GAP_MS[cue.kind]) return false;
    this.lastPlayed.set(cue.kind, now);

    const ctx = this.ctx;
    const out = this.master;
    const t = ctx.currentTime + 0.005;
    switch (cue.kind) {
      case "kick":
        this.thump(ctx, out, t, 150, 48, 0.16, 0.9 * cue.strength);
        this.burst(ctx, out, t, 0.045, 2200, 0.35 * cue.strength);
        return true;
      case "pass":
        this.thump(ctx, out, t, 230, 95, 0.08, 0.45);
        this.burst(ctx, out, t, 0.025, 3200, 0.16);
        return true;
      case "whistle":
        this.whistle(ctx, out, t, 0.42);
        return true;
      case "finalWhistle":
        this.whistle(ctx, out, t, 0.24);
        this.whistle(ctx, out, t + 0.36, 0.24);
        this.whistle(ctx, out, t + 0.72, 0.7);
        return true;
      case "goal":
        this.crowd(ctx, out, t, 1.9);
        this.thump(ctx, out, t, 120, 55, 0.3, 0.6);
        return true;
      default:
        return false;
    }
  }

  private masterLevel(): number {
    // 귀는 소리 크기를 로그로 느낀다. 제곱으로 눌러 낮은 쪽을 세밀하게 한다.
    return this.settings.volume * this.settings.volume * 0.7;
  }

  /** 지금 울리는 중이거나 예약된 소리 수(검증용). */
  get activeVoices(): number {
    return this.active.size;
  }

  /**
   * 울리는 중이거나 예약된 소리를 모두 멈추고 노드를 끊는다. 여러 번 불러도 안전하다.
   * 끝난 뒤 늦게 오는 `onended` 는 이미 풀린 목소리라 아무것도 하지 않는다.
   */
  private silenceAll(): void {
    for (const voice of [...this.active]) voice.release(true);
    // 다시 켠 직후 첫 소리가 간격 제한에 걸리지 않게 한다.
    this.lastPlayed.clear();
  }

  /**
   * 소리 한 번(=한 목소리)을 이루는 노드들을 묶는다. 마지막 발음원이 끝나면 체인 전체를
   * 끊는다. 오래된 WebKit 은 끝난 노드를 스스로 치우지 않을 수 있다.
   */
  private voice(sources: AudioScheduledSourceNode[], nodes: AudioNode[]): void {
    let pending = sources.length;
    let released = false;
    const voice: Voice = {
      release: (stop) => {
        if (released) return;
        released = true;
        this.active.delete(voice);
        for (const source of sources) {
          source.onended = null;
          if (stop) {
            try {
              source.stop();
            } catch {
              // 아직 시작 전이거나 이미 멈췄다.
            }
          }
        }
        for (const node of [...sources, ...nodes]) {
          try {
            node.disconnect();
          } catch {
            // 이미 끊긴 노드다.
          }
        }
      },
    };
    this.active.add(voice);
    const done = () => {
      pending -= 1;
      if (pending <= 0) voice.release(false);
    };
    for (const source of sources) source.onended = done;
  }

  private noiseBuffer(ctx: AudioContext): AudioBuffer {
    if (this.noise) return this.noise;
    const length = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    this.noise = buffer;
    return buffer;
  }

  /** 공을 차는 둔탁한 소리: 음높이가 빠르게 떨어지는 사인파. */
  private thump(
    ctx: AudioContext,
    out: AudioNode,
    t: number,
    from: number,
    to: number,
    length: number,
    level: number,
  ): void {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + length);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.001, level), t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain).connect(out);
    this.voice([osc], [gain]);
    osc.start(t);
    osc.stop(t + length + 0.02);
  }

  /** 가죽이 맞는 짧은 마찰음: 걸러 낸 잡음 한 조각. */
  private burst(
    ctx: AudioContext,
    out: AudioNode,
    t: number,
    length: number,
    cutoff: number,
    level: number,
  ): void {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = cutoff;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0.001, level), t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    src.connect(filter).connect(gain).connect(out);
    this.voice([src], [filter, gain]);
    src.start(t, Math.random());
    src.stop(t + length + 0.01);
  }

  /** 심판 호루라기: 높은 음에 빠른 떨림(콩 호루라기의 구르는 소리)을 얹는다. */
  private whistle(ctx: AudioContext, out: AudioNode, t: number, length: number): void {
    const osc = ctx.createOscillator();
    const trill = ctx.createOscillator();
    const trillDepth = ctx.createGain();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 2750;
    trill.type = "sine";
    trill.frequency.value = 26;
    trillDepth.gain.value = 110;
    trill.connect(trillDepth).connect(osc.frequency);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.02);
    gain.gain.setValueAtTime(0.16, t + length - 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    osc.connect(gain).connect(out);
    this.voice([osc, trill], [trillDepth, gain]);
    osc.start(t);
    trill.start(t);
    osc.stop(t + length + 0.02);
    trill.stop(t + length + 0.02);
  }

  /** 관중 함성: 사람 목소리 대역만 남긴 잡음이 부풀었다가 가라앉는다. */
  private crowd(ctx: AudioContext, out: AudioNode, t: number, length: number): void {
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer(ctx);
    src.loop = true;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 850;
    band.Q.value = 0.7;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.5, t + 0.28);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + length);
    src.connect(band).connect(gain).connect(out);
    this.voice([src], [band, gain]);
    src.start(t);
    src.stop(t + length + 0.05);
  }
}
