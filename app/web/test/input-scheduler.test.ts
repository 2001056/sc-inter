/**
 * 입력 전송 타이머(`InputPump`) 회귀 테스트.
 * 렌더와 떨어져 30Hz 로 도는지, 숨김·연결 끊김·정리에서 규칙을 지키는지 본다.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { InputController, type InputPayload } from "../src/game/input.ts";
import { INPUT_HZ, InputPump, MIN_GAP_MS } from "../src/ui/inputPump.ts";

function fakeTimers() {
  let nextId = 1;
  const active = new Map<number, () => void>();
  const clock = { t: 0 };
  return {
    active,
    now: () => clock.t,
    setInterval: (fn: () => void) => {
      const id = nextId++;
      active.set(id, fn);
      return id;
    },
    clearInterval: (id: number) => {
      active.delete(id);
    },
    /** 한 번 부를 때마다 가짜 시계를 한 주기(34ms) 진행시키고 타이머를 울린다. */
    fire(times = 1) {
      for (let i = 0; i < times; i += 1) {
        clock.t += 34;
        for (const fn of [...active.values()]) fn();
      }
    },
  };
}

function setup(open = true) {
  const input = new InputController();
  input.setEnabled(true);
  const sent: InputPayload[] = [];
  const timers = fakeTimers();
  let isOpen = open;
  const pump = new InputPump({
    poll: () => input.poll(),
    send: (p) => sent.push(p),
    isOpen: () => isOpen,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    now: timers.now,
  });
  return { input, sent, timers, pump, setOpen: (v: boolean) => (isOpen = v) };
}

test("시작하면 타이머 하나로 보내고, 멈추면 타이머가 사라진다", () => {
  const { sent, timers, pump } = setup();
  pump.start();
  pump.start();
  assert.equal(timers.active.size, 1, "start 를 두 번 불러도 타이머는 하나");
  timers.fire(5);
  assert.equal(sent.length, 5);
  pump.stop();
  assert.equal(timers.active.size, 0);
  timers.fire(3);
  assert.equal(sent.length, 5);
});

test("탭이 숨으면 멈추고 보이면 다시 돈다. 멈춘 채로 숨김 해제돼도 켜지지 않는다", () => {
  const { timers, pump } = setup();
  pump.setHidden(true);
  pump.start();
  assert.equal(timers.active.size, 0, "숨은 채 시작하면 기다린다");
  pump.setHidden(false);
  assert.equal(timers.active.size, 1);
  pump.setHidden(true);
  assert.equal(timers.active.size, 0);
  pump.stop();
  pump.setHidden(false);
  assert.equal(timers.active.size, 0, "stop 뒤에는 보임 전환으로 되살아나지 않는다");
});

test("연결이 닫혀 있으면 보내지 않고 한 번짜리 값은 버린다 — 재접속 후 뒤늦은 패스 없음", () => {
  const { input, sent, timers, pump, setOpen } = setup(false);
  pump.start();
  input.triggerPass();
  input.triggerTackle();
  input.triggerSkill("up");
  timers.fire();
  assert.equal(sent.length, 0);
  assert.equal(pump.stats.dropped, 1);
  setOpen(true);
  timers.fire();
  assert.equal(sent.length, 1);
  const first = sent[0]!;
  assert.equal(first.pass, false);
  assert.equal(first.tackle, false);
  assert.equal(first.skillDir, null);
});

test("한 번짜리 값은 정확히 한 번만 실린다", () => {
  const { input, sent, timers, pump } = setup();
  pump.start();
  input.triggerPass();
  input.triggerSwitch();
  timers.fire(3);
  assert.deepEqual(
    sent.map((p) => [p.pass, p.switchPlayer]),
    [
      [true, true],
      [false, false],
      [false, false],
    ],
  );
});

test("flush 는 주기를 기다리지 않고 지금 중립 입력을 보낸다(창 이탈)", () => {
  const { input, sent, pump } = setup();
  pump.start();
  input.setStick(0, 1);
  input.releaseAll();
  pump.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.ax, 0);
  assert.equal(sent[0]!.ay, 0);
});

test("비활성(카운트다운) 중에는 눌러도 한 번짜리 값이 쌓이지 않는다", () => {
  const { input, sent, timers, pump } = setup();
  input.setEnabled(false);
  pump.start();
  input.triggerPass();
  timers.fire();
  assert.equal(sent[0]!.pass, false);
});

test("seq 는 Connection.sendInput 이 올린다: 버린 주기는 번호를 쓰지 않아 단조 증가가 유지된다", () => {
  let seq = 0;
  const seqs: number[] = [];
  const timers = fakeTimers();
  let open = true;
  const input = new InputController();
  const pump = new InputPump({
    poll: () => input.poll(),
    send: () => seqs.push(++seq),
    isOpen: () => open,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    now: timers.now,
  });
  pump.start();
  timers.fire(2);
  open = false;
  timers.fire(2);
  open = true;
  timers.fire(2);
  assert.deepEqual(seqs, [1, 2, 3, 4]);
});

test("렌더 루프의 due() 와 타이머가 겹쳐도 최소 간격을 지켜 두 번 보내지 않는다", () => {
  let now = 0;
  const sent: number[] = [];
  const timers = fakeTimers();
  const input = new InputController();
  const pump = new InputPump({
    poll: () => input.poll(),
    send: () => sent.push(now),
    isOpen: () => true,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    now: () => now,
  });
  pump.start();
  timers.fire(); // t=0 전송
  now = 10;
  pump.due(); // 너무 이르다
  now = 34;
  pump.due(); // 한 주기 지남 → 렌더 루프가 대신 보냄
  now = 36;
  timers.fire(); // 타이머가 뒤늦게 와도 2ms 뒤라 보내지 않음
  now = 80;
  timers.fire();
  assert.deepEqual(sent, [0, 34, 80]);
  for (let i = 1; i < sent.length; i += 1) assert.ok(sent[i]! - sent[i - 1]! >= MIN_GAP_MS);
});

test("due() 는 숨김·정지 상태에서 아무것도 보내지 않는다", () => {
  let now = 1000;
  const sent: number[] = [];
  const input = new InputController();
  const timers = fakeTimers();
  const pump = new InputPump({
    poll: () => input.poll(),
    send: () => sent.push(now),
    isOpen: () => true,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    now: () => now,
  });
  pump.due();
  pump.start();
  pump.setHidden(true);
  now += 100;
  pump.due();
  pump.setHidden(false);
  pump.stop();
  now += 100;
  pump.due();
  assert.equal(sent.length, 0);
});

test("실제 타이머: 메인 스레드가 한가하면 약 30Hz 로 보낸다", async () => {
  const stamps: number[] = [];
  const input = new InputController();
  const pump = new InputPump({
    poll: () => input.poll(),
    send: () => stamps.push(performance.now()),
    isOpen: () => true,
    setInterval: (fn, ms) => setInterval(fn, ms) as unknown as number,
    clearInterval: (id) => clearInterval(id),
  });
  pump.start();
  await new Promise((r) => setTimeout(r, 1000));
  pump.stop();
  assert.ok(stamps.length >= INPUT_HZ - 4 && stamps.length <= INPUT_HZ + 1, `1초 ${stamps.length}회`);
});
