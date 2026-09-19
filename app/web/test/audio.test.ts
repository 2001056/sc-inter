/**
 * 효과음(`GameAudio`) 수명 회귀 테스트. 진짜 소리 대신 가짜 AudioContext 로
 * "언제 만들고, 언제 깨우고, 언제 멈추고, 언제 닫는지" 를 본다.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AUDIO, GameAudio, readAudioSettings, writeAudioSettings } from "../src/game/audio.ts";

class FakeParam {
  value = 0;
  setValueAtTime() { return this; }
  exponentialRampToValueAtTime() { return this; }
  setTargetAtTime(v: number) { this.value = v; return this; }
}
const allNodes: FakeNode[] = [];
class FakeNode {
  disconnected = false;
  constructor() { allNodes.push(this); }
  gain = new FakeParam();
  frequency = new FakeParam();
  Q = new FakeParam();
  type = "";
  buffer: unknown = null;
  loop = false;
  onended: (() => void) | null = null;
  connect(n: unknown) { return n; }
  disconnect() { this.disconnected = true; }
  started = false;
  stops = 0;
  start() { this.started = true; }
  stop() { this.stops += 1; }
}
class FakeContext {
  state: "suspended" | "running" | "closed" = "suspended";
  currentTime = 0;
  sampleRate = 8000;
  destination = new FakeNode();
  calls: string[] = [];
  voices = 0;
  resume() { this.calls.push("resume"); this.state = "running"; return Promise.resolve(); }
  suspend() { this.calls.push("suspend"); this.state = "suspended"; return Promise.resolve(); }
  close() { this.calls.push("close"); this.state = "closed"; return Promise.resolve(); }
  createGain() { return new FakeNode(); }
  createOscillator() { this.voices += 1; return new FakeNode(); }
  createBufferSource() { this.voices += 1; return new FakeNode(); }
  createBiquadFilter() { return new FakeNode(); }
  createBuffer(_c: number, len: number) { const d = new Float32Array(len); return { getChannelData: () => d }; }
}

class MemoryStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

function make(storage: unknown = new MemoryStorage()) {
  const created: FakeContext[] = [];
  let clock = 0;
  const audio = new GameAudio({
    storage: storage as Storage,
    createContext: () => {
      const c = new FakeContext();
      created.push(c);
      return c as unknown as AudioContext;
    },
    now: () => clock,
  });
  return { audio, created, advance: (ms: number) => (clock += ms) };
}

test("기본은 꺼짐·낮은 음량이고, 꺼진 상태에서는 사용자 동작이 와도 AudioContext 를 만들지 않는다", () => {
  const { audio, created } = make();
  assert.equal(audio.current.enabled, false);
  assert.ok(audio.current.volume <= 0.4);
  audio.unlock();
  assert.equal(created.length, 0);
  assert.equal(audio.play({ kind: "whistle" }), false);
});

test("켜는 순간(클릭 핸들러) 만들고 깨우며, 그 뒤에만 소리가 난다", async () => {
  const { audio, created } = make();
  audio.setEnabled(true);
  assert.equal(created.length, 1);
  await Promise.resolve();
  assert.deepEqual(created[0]!.calls, ["resume"]);
  assert.equal(audio.play({ kind: "kick", strength: 1 }), true);
});

test("켜 둔 설정이 저장돼 있어도 사용자 동작(unlock) 전에는 만들지도 울리지도 않는다", () => {
  const storage = new MemoryStorage();
  writeAudioSettings({ enabled: true, volume: 0.5 }, storage as unknown as Storage);
  const { audio, created } = make(storage);
  assert.equal(audio.current.enabled, true);
  assert.equal(audio.play({ kind: "goal" }), false);
  assert.equal(created.length, 0);
  audio.unlock();
  assert.equal(created.length, 1);
  assert.equal(audio.play({ kind: "goal" }), true);
});

test("같은 소리는 촘촘하게 겹치지 않는다", () => {
  const { audio, advance } = make();
  audio.setEnabled(true);
  assert.equal(audio.play({ kind: "pass" }), true);
  assert.equal(audio.play({ kind: "pass" }), false);
  advance(100);
  assert.equal(audio.play({ kind: "pass" }), true);
});

test("탭이 숨으면 멈추고 조용하며, 보이면 이어서 켜진다", () => {
  const { audio, created } = make();
  audio.setEnabled(true);
  audio.setHidden(true);
  assert.equal(created[0]!.state, "suspended");
  assert.equal(audio.play({ kind: "whistle" }), false);
  audio.setHidden(false);
  assert.equal(created[0]!.state, "running");
  assert.equal(audio.play({ kind: "whistle" }), true);
});

test("끄면 멈추고, dispose 하면 닫히며 이후 호출은 무시된다", () => {
  const { audio, created } = make();
  audio.setEnabled(true);
  audio.setEnabled(false);
  assert.equal(created[0]!.state, "suspended");
  audio.dispose();
  assert.equal(created[0]!.state, "closed");
  audio.setEnabled(true);
  audio.unlock();
  assert.equal(created.length, 1, "dispose 뒤에는 새로 만들지 않는다");
  assert.equal(audio.play({ kind: "kick", strength: 1 }), false);
});

test("localStorage 가 막혀도(시크릿 모드) 예외 없이 기본값으로 돈다", () => {
  const broken = {
    getItem() { throw new Error("SecurityError"); },
    setItem() { throw new Error("QuotaExceeded"); },
  };
  assert.deepEqual(readAudioSettings(broken as unknown as Storage), DEFAULT_AUDIO);
  const { audio } = make(broken);
  assert.doesNotThrow(() => audio.setEnabled(true));
  assert.doesNotThrow(() => audio.setVolume(0.9));
  assert.equal(audio.current.volume, 0.9);
});

test("깨진 저장값·범위를 벗어난 음량은 바로잡는다", () => {
  const s = new MemoryStorage();
  s.setItem("sc-inter:audio", "{not json");
  assert.deepEqual(readAudioSettings(s as unknown as Storage), DEFAULT_AUDIO);
  s.setItem("sc-inter:audio", JSON.stringify({ enabled: "yes", volume: 7 }));
  assert.deepEqual(readAudioSettings(s as unknown as Storage), { enabled: false, volume: 1 });
});

test("소리가 끝나면 그 소리의 노드 체인을 전부 끊는다", () => {
  const { audio } = make();
  audio.setEnabled(true);
  const before = allNodes.length;
  assert.equal(audio.play({ kind: "whistle" }), true);
  const made = allNodes.slice(before);
  assert.ok(made.length >= 4, "휘슬은 발음원 2 + 떨림 깊이 + 게인");
  const sources = made.filter((n) => n.onended);
  assert.equal(sources.length, 2);
  sources[0]!.onended!();
  assert.ok(made.every((n) => !n.disconnected), "발음원이 하나 남아 있으면 끊지 않는다");
  sources[1]!.onended!();
  assert.ok(made.every((n) => n.disconnected));
});

test("킥이 상한까지 차 있어도 휘슬·득점은 난다", () => {
  const { audio, advance } = make();
  audio.setEnabled(true);
  let kicks = 0;
  for (let i = 0; i < 20; i += 1) {
    if (audio.play({ kind: "kick", strength: 1 })) kicks += 1;
    advance(100);
  }
  assert.ok(kicks < 20, "끝나지 않은 킥이 쌓이면 상한에 걸린다");
  assert.equal(audio.play({ kind: "kick", strength: 1 }), false);
  assert.equal(audio.play({ kind: "finalWhistle" }), true);
  assert.equal(audio.play({ kind: "goal" }), true);
});

function playedSince(before: number) {
  const made = allNodes.slice(before);
  return { made, sources: made.filter((n) => n.started) };
}

for (const [label, mute] of [
  ["끄기", (a: GameAudio) => a.setEnabled(false)],
  ["탭 숨김", (a: GameAudio) => a.setHidden(true)],
] as const) {
  test(`${label}: 예약된 종료 휘슬·함성을 멈추고 끊어, 다시 켜도 옛 소리가 이어지지 않는다`, () => {
    const { audio } = make();
    audio.setEnabled(true);
    const before = allNodes.length;
    assert.equal(audio.play({ kind: "finalWhistle" }), true);
    assert.equal(audio.play({ kind: "goal" }), true);
    const { made, sources } = playedSince(before);
    assert.equal(audio.activeVoices, 5, "휘슬 3 + 함성 2");
    // 예약할 때 이미 stop(끝 시각)을 한 번 건다. 그 뒤 몇 번 더 멈췄는지를 센다.
    const base = sources.map((n) => n.stops);
    const extraStops = () => sources.map((n, i) => n.stops - base[i]!);
    mute(audio);
    assert.equal(audio.activeVoices, 0);
    assert.ok(extraStops().every((d) => d === 1), "모든 발음원을 지금 멈춘다");
    assert.ok(made.every((n) => n.disconnected), "체인 전체를 끊는다");
    assert.ok(sources.every((n) => n.onended === null), "늦게 오는 onended 도 떼어 낸다");

    // 다시 켠다: 옛 노드는 그대로 끊긴 채, 새 소리는 곧바로 난다(간격 제한도 초기화).
    if (label === "끄기") audio.setEnabled(true);
    else audio.setHidden(false);
    const again = allNodes.length;
    assert.equal(audio.play({ kind: "finalWhistle" }), true);
    assert.ok(allNodes.length > again);
    assert.equal(audio.activeVoices, 3);
    assert.ok(extraStops().every((d) => d === 1), "옛 발음원을 다시 건드리지 않는다");
  });
}

test("연속 끄기·숨김·dispose 는 멱등이고 카운터가 음수로 가지 않는다", () => {
  const { audio, created } = make();
  audio.setEnabled(true);
  const before = allNodes.length;
  audio.play({ kind: "kick", strength: 1 });
  const { sources } = playedSince(before);
  const lateEnded = sources.map((n) => n.onended);
  const base = sources.map((n) => n.stops);
  audio.setHidden(true);
  audio.setEnabled(false);
  audio.setEnabled(false);
  audio.setHidden(false);
  audio.setHidden(true);
  audio.dispose();
  audio.dispose();
  for (const fn of lateEnded) fn?.();
  assert.equal(audio.activeVoices, 0);
  assert.ok(sources.every((n, i) => n.stops - base[i]! === 1), "여러 번 정리해도 한 번만 멈춘다");
  assert.equal(created[0]!.calls.filter((c) => c === "close").length, 1);
});

test("정상 종료(onended)된 소리는 멈추지 않고 목록에서만 빠진다", () => {
  const { audio } = make();
  audio.setEnabled(true);
  const before = allNodes.length;
  audio.play({ kind: "pass" });
  const { sources } = playedSince(before);
  const base = sources.map((n) => n.stops);
  for (const n of sources) n.onended!();
  assert.equal(audio.activeVoices, 0);
  audio.setEnabled(false);
  assert.ok(sources.every((n, i) => n.stops === base[i]), "이미 끝난 소리는 다시 멈추지 않는다");
});

test("컨텍스트의 resume·suspend·close 가 거부돼도 처리되지 않은 rejection 이 없다", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const audio = new GameAudio({
      storage: new MemoryStorage() as unknown as Storage,
      createContext: () => {
        const c = new FakeContext();
        c.resume = () => Promise.reject(new Error("NotAllowedError"));
        c.suspend = () => Promise.reject(new Error("InvalidStateError"));
        c.close = () => Promise.reject(new Error("InvalidStateError"));
        return c as unknown as AudioContext;
      },
    });
    audio.setEnabled(true);
    audio.setHidden(true);
    audio.setHidden(false);
    audio.setEnabled(false);
    audio.dispose();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(rejections, []);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});
