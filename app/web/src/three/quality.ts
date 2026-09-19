/**
 * 그래픽 품질 선택과 자동 해상도 조절.
 *
 * 사용자가 고르는 값은 세 가지뿐이다.
 *  - `high`: 기기 화소 비율(최대 2)과 그림자를 그대로 쓴다.
 *  - `low` : 화소 비율 1 이하, 그림자 맵 없이 발밑 그림자 원판만 쓴다.
 *  - `auto`: `high` 로 시작해 실제 프레임 시간을 보고 화소 비율을 내리고, 그래도
 *            느리면 그림자 맵을 끈다. 여유가 생기면 천천히 되돌린다.
 *
 * 선수 메시·얼굴·유니폼 텍스처는 품질과 무관하게 같다. 사람 비율과 등번호가
 * 흐려지는 쪽으로는 줄이지 않는다.
 */

export type GraphicsQuality = "auto" | "high" | "low";

const STORAGE_KEY = "sc-inter.graphicsQuality";

export function isGraphicsQuality(value: unknown): value is GraphicsQuality {
  return value === "auto" || value === "high" || value === "low";
}

/** 저장된 선택을 읽는다. 저장소를 못 쓰거나 값이 이상하면 `auto`. */
export function readGraphicsQuality(): GraphicsQuality {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isGraphicsQuality(stored) ? stored : "auto";
  } catch {
    return "auto";
  }
}

/** 선택을 저장한다. 사생활 보호 모드처럼 저장소를 못 쓰면 조용히 넘어간다. */
export function writeGraphicsQuality(quality: GraphicsQuality): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, quality);
  } catch {
    // 저장하지 못해도 이번 화면에는 이미 적용됐다.
  }
}

/** 렌더러가 실제로 따르는 설정 한 벌. */
export interface RenderProfile {
  pixelRatio: number;
  shadows: boolean;
}

/** 기기 화소 비율 상한. 2 를 넘으면 화면 차이는 거의 없고 채우기 비용만 는다. */
const MAX_PIXEL_RATIO = 2;

export function devicePixelRatioCap(): number {
  const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
  return Math.min(dpr, MAX_PIXEL_RATIO);
}

/** 고정 품질일 때의 설정. `auto` 는 `high` 에서 출발한다. */
export function baseProfile(quality: GraphicsQuality, deviceRatio = devicePixelRatioCap()): RenderProfile {
  if (quality === "low") return { pixelRatio: Math.min(1, deviceRatio), shadows: false };
  return { pixelRatio: deviceRatio, shadows: true };
}

/**
 * `auto` 에서 화소 비율과 그림자를 조절한다.
 *
 * 프레임 간격(rAF 사이 시간)을 지수 평균으로 본다. 한두 프레임 튀는 것에는
 * 반응하지 않도록, 평균이 기준을 넘은 상태가 일정 시간 이어질 때만 한 단계
 * 내리고, 올릴 때는 더 오래 여유가 있어야 한다. 단계가 자주 바뀌면 화면이
 * 번쩍이므로 한 번 바꾼 뒤에는 잠시 쉰다.
 */
export class AdaptiveQuality {
  /** 이 간격(ms)보다 느리면 내린다. 약 45fps. */
  static readonly SLOW_MS = 22;
  /** 이 간격(ms)보다 빠르면 올릴 여유가 있다. 약 58fps. */
  static readonly FAST_MS = 17.2;
  static readonly MIN_RATIO = 0.6;

  private average = 16.7;
  private slowFor = 0;
  private fastFor = 0;
  private cooldown = 0;
  private readonly ceiling: number;
  profile: RenderProfile;

  constructor(deviceRatio = devicePixelRatioCap()) {
    this.ceiling = deviceRatio;
    this.profile = { pixelRatio: deviceRatio, shadows: true };
  }

  /**
   * 한 프레임을 알린다. 설정이 바뀌었으면 true.
   * `frameMs` 는 rAF 간격이다. 탭이 숨었다 돌아온 긴 간격은 버린다.
   */
  sample(frameMs: number): boolean {
    if (!(frameMs > 0) || frameMs > 250) return false;
    this.average += (frameMs - this.average) * 0.08;
    const seconds = frameMs / 1000;
    if (this.cooldown > 0) {
      this.cooldown -= seconds;
      return false;
    }
    if (this.average > AdaptiveQuality.SLOW_MS) {
      this.slowFor += seconds;
      this.fastFor = 0;
    } else if (this.average < AdaptiveQuality.FAST_MS) {
      this.fastFor += seconds;
      this.slowFor = 0;
    } else {
      this.slowFor = 0;
      this.fastFor = 0;
    }

    if (this.slowFor > 1.2) return this.step(-1);
    if (this.fastFor > 6) return this.step(1);
    return false;
  }

  /** 내릴 때: 화소 비율 → 그림자 순. 올릴 때는 그 반대. */
  private step(direction: -1 | 1): boolean {
    this.slowFor = 0;
    this.fastFor = 0;
    const { pixelRatio, shadows } = this.profile;
    let next: RenderProfile | null = null;
    if (direction < 0) {
      if (pixelRatio > AdaptiveQuality.MIN_RATIO + 1e-3) {
        next = { pixelRatio: Math.max(AdaptiveQuality.MIN_RATIO, round2(pixelRatio * 0.8)), shadows };
      } else if (shadows) {
        next = { pixelRatio, shadows: false };
      }
    } else if (!shadows) {
      next = { pixelRatio, shadows: true };
    } else if (pixelRatio < this.ceiling - 1e-3) {
      next = { pixelRatio: Math.min(this.ceiling, round2(pixelRatio * 1.15)), shadows };
    }
    if (!next) return false;
    this.profile = next;
    this.cooldown = 1.5;
    // 새 설정의 첫 프레임들은 셰이더 재컴파일로 튄다. 평균을 중립으로 되돌린다.
    this.average = (AdaptiveQuality.SLOW_MS + AdaptiveQuality.FAST_MS) / 2;
    return true;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
