/**
 * 그래픽 품질(`three/quality.ts`) 회귀 테스트.
 * 저장소 읽기·쓰기의 실패 처리와 `auto` 의 단계 조절 순서를 본다. 렌더러는 띄우지 않는다.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AdaptiveQuality,
  baseProfile,
  isGraphicsQuality,
  readGraphicsQuality,
  writeGraphicsQuality,
} from "../src/three/quality.ts";

function withStorage(storage: unknown, run: () => void): void {
  const holder = globalThis as { window?: unknown };
  const previous = holder.window;
  holder.window = { localStorage: storage, devicePixelRatio: 2 };
  try {
    run();
  } finally {
    holder.window = previous;
  }
}

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    map,
  };
}

test("저장한 품질을 다시 읽는다", () => {
  const storage = memoryStorage();
  withStorage(storage, () => {
    assert.equal(readGraphicsQuality(), "auto");
    writeGraphicsQuality("low");
    assert.equal(readGraphicsQuality(), "low");
    writeGraphicsQuality("high");
    assert.equal(readGraphicsQuality(), "high");
  });
});

test("이상한 값이나 저장소 오류는 auto 로 떨어진다", () => {
  const storage = memoryStorage();
  storage.map.set("sc-inter.graphicsQuality", "ultra");
  withStorage(storage, () => assert.equal(readGraphicsQuality(), "auto"));

  const broken = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  withStorage(broken, () => {
    assert.equal(readGraphicsQuality(), "auto");
    assert.doesNotThrow(() => writeGraphicsQuality("low"));
  });
});

test("타입 가드는 세 값만 받는다", () => {
  assert.ok(isGraphicsQuality("auto"));
  assert.ok(isGraphicsQuality("high"));
  assert.ok(isGraphicsQuality("low"));
  assert.ok(!isGraphicsQuality("medium"));
  assert.ok(!isGraphicsQuality(null));
});

test("고정 품질 설정", () => {
  assert.deepEqual(baseProfile("high", 2), { pixelRatio: 2, shadows: true });
  assert.deepEqual(baseProfile("low", 2), { pixelRatio: 1, shadows: false });
  assert.deepEqual(baseProfile("low", 0.8), { pixelRatio: 0.8, shadows: false });
  assert.deepEqual(baseProfile("auto", 1.5), { pixelRatio: 1.5, shadows: true });
});

/** 같은 간격의 프레임을 seconds 동안 넣고, 바뀐 설정을 차례로 모은다. */
function feed(adaptive: AdaptiveQuality, frameMs: number, seconds: number): string[] {
  const changes: string[] = [];
  for (let t = 0; t < seconds * 1000; t += frameMs) {
    if (adaptive.sample(frameMs)) {
      changes.push(`${adaptive.profile.pixelRatio}/${adaptive.profile.shadows ? "S" : "-"}`);
    }
  }
  return changes;
}

test("auto: 느리면 화소 비율부터, 바닥에 닿으면 그림자를 끈다", () => {
  const adaptive = new AdaptiveQuality(2);
  const changes = feed(adaptive, 50, 40);
  assert.ok(changes.length >= 2, changes.join(","));
  // 그림자는 화소 비율이 바닥(0.6)에 닿은 뒤에만 꺼진다.
  const firstShadowOff = changes.findIndex((c) => c.endsWith("-"));
  assert.ok(firstShadowOff > 0);
  assert.equal(changes[firstShadowOff], "0.6/-");
  for (const c of changes.slice(0, firstShadowOff)) assert.ok(c.endsWith("S"));
  assert.deepEqual(adaptive.profile, { pixelRatio: 0.6, shadows: false });
});

test("auto: 여유가 생기면 그림자부터 되살리고 기기 비율을 넘지 않는다", () => {
  const adaptive = new AdaptiveQuality(2);
  feed(adaptive, 50, 40);
  const changes = feed(adaptive, 8.3, 200);
  assert.equal(changes[0], "0.6/S");
  assert.deepEqual(adaptive.profile, { pixelRatio: 2, shadows: true });
});

test("auto: 60fps 안팎에서는 바꾸지 않고, 탭 복귀 같은 긴 간격은 무시한다", () => {
  const adaptive = new AdaptiveQuality(2);
  assert.deepEqual(feed(adaptive, 16.7, 30), []);
  assert.equal(adaptive.sample(2000), false);
  assert.equal(adaptive.sample(0), false);
  assert.deepEqual(adaptive.profile, { pixelRatio: 2, shadows: true });
});
