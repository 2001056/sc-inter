/** 실제 HTTP + WebSocket 을 띄워서 두 클라이언트가 같은 경기를 보는지 확인한다. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import { createApp, type AppServer } from "../src/server.ts";
import type { ServerMessage } from "../src/protocol.ts";

let app: AppServer;
let baseUrl = "";
let wsUrl = "";

class TestClient {
  readonly socket: WebSocket;
  readonly received: ServerMessage[] = [];

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (raw) => {
      this.received.push(JSON.parse(String(raw)) as ServerMessage);
    });
  }

  static async connect(url: string): Promise<TestClient> {
    const c = new TestClient(url);
    await new Promise<void>((resolve, reject) => {
      c.socket.once("open", () => resolve());
      c.socket.once("error", reject);
    });
    return c;
  }

  send(msg: unknown): void {
    this.socket.send(JSON.stringify(msg));
  }

  /** 조건에 맞는 메시지가 올 때까지 기다린다. */
  async waitFor<T extends ServerMessage>(
    pred: (m: ServerMessage) => m is T,
    timeoutMs = 4000,
  ): Promise<T> {
    const existing = this.received.find(pred);
    if (existing) return existing;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.socket.off("message", onMessage);
        reject(new Error("기다리던 메시지가 오지 않았습니다."));
      }, timeoutMs);
      const onMessage = (raw: unknown) => {
        const msg = JSON.parse(String(raw)) as ServerMessage;
        if (pred(msg)) {
          clearTimeout(timer);
          this.socket.off("message", onMessage);
          resolve(msg);
        }
      };
      this.socket.on("message", onMessage);
    });
  }

  close(): void {
    this.socket.close();
  }
}

const isJoined = (m: ServerMessage): m is Extract<ServerMessage, { t: "joined" }> =>
  m.t === "joined";
const isSnapshot = (m: ServerMessage): m is Extract<ServerMessage, { t: "snapshot" }> =>
  m.t === "snapshot";
const isError = (m: ServerMessage): m is Extract<ServerMessage, { t: "error" }> =>
  m.t === "error";

before(async () => {
  app = createApp();
  await new Promise<void>((resolve) => app.http.listen(0, "127.0.0.1", () => resolve()));
  const addr = app.http.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
  wsUrl = `ws://127.0.0.1:${addr.port}/ws`;
});

after(async () => {
  await app.close();
});

test("healthz 는 상태를 알려준다", async () => {
  const res = await fetch(`${baseUrl}/healthz`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; rooms: number };
  assert.equal(body.status, "ok");
  assert.equal(typeof body.rooms, "number");
});

test("두 브라우저가 같은 방에서 같은 경기 상태를 본다", async () => {
  const host = await TestClient.connect(wsUrl);
  host.send({ t: "create", nickname: "호스트" });
  const joined = await host.waitFor(isJoined);
  assert.match(joined.code, /^[A-Z0-9]{6}$/);
  assert.equal(joined.side, "left");
  assert.ok(joined.pitch.length > 0);

  const guest = await TestClient.connect(wsUrl);
  guest.send({ t: "join", nickname: "게스트", code: joined.code });
  const guestJoined = await guest.waitFor(isJoined);
  assert.equal(guestJoined.side, "right");

  const snapA = await host.waitFor(isSnapshot);
  const snapB = await guest.waitFor(
    (m): m is Extract<ServerMessage, { t: "snapshot" }> =>
      m.t === "snapshot" && m.tick >= snapA.tick,
  );
  assert.deepEqual(snapA.score, snapB.score);
  assert.equal(snapB.players.length, 6);

  // 입력을 보내면 내가 조작 중인 선수가 움직이고 두 화면 모두 같은 위치를 받는다
  const myId = snapA.controlled.left;
  const before = snapA.players.find((p) => p.id === myId)!.x;
  host.send({
    t: "input",
    seq: 1,
    ax: 1,
    ay: 0,
    sprint: true,
    shoot: false,
    pass: false,
    tackle: false,
    skillDir: null,
    switchPlayer: false,
  });
  const moved = await host.waitFor(
    (m): m is Extract<ServerMessage, { t: "snapshot" }> =>
      m.t === "snapshot" &&
      m.phase === "playing" &&
      (m.players.find((p) => p.id === myId)?.x ?? 0) > before + 0.5,
    8000,
  );
  const mirrored = await guest.waitFor(
    (m): m is Extract<ServerMessage, { t: "snapshot" }> =>
      m.t === "snapshot" && m.tick >= moved.tick,
  );
  const lx = mirrored.players.find((p) => p.id === myId)!.x;
  assert.ok(lx > before + 0.4, `상대 화면에서도 움직여야 한다 (${before} -> ${lx})`);

  host.close();
  guest.close();
});

test("세 번째 참가자는 거절된다", async () => {
  const a = await TestClient.connect(wsUrl);
  a.send({ t: "create", nickname: "가" });
  const joined = await a.waitFor(isJoined);
  const b = await TestClient.connect(wsUrl);
  b.send({ t: "join", nickname: "나", code: joined.code });
  await b.waitFor(isJoined);

  const c = await TestClient.connect(wsUrl);
  c.send({ t: "join", nickname: "다", code: joined.code });
  const err = await c.waitFor(isError);
  assert.equal(err.code, "ROOM_FULL");

  a.close();
  b.close();
  c.close();
});

test("없는 코드로 참가하면 ROOM_NOT_FOUND", async () => {
  const c = await TestClient.connect(wsUrl);
  c.send({ t: "join", nickname: "가", code: "ZZZZZZ" });
  const err = await c.waitFor(isError);
  assert.equal(err.code, "ROOM_NOT_FOUND");
  c.close();
});

test("형식이 틀린 메시지는 BAD_MESSAGE 로 거절한다", async () => {
  const c = await TestClient.connect(wsUrl);
  c.send({ t: "create" });
  const err = await c.waitFor(isError);
  assert.equal(err.code, "BAD_MESSAGE");
  c.close();
});

test("방에 없는 상태의 입력은 NOT_IN_ROOM", async () => {
  const c = await TestClient.connect(wsUrl);
  c.send({
    t: "input",
    seq: 1,
    ax: 0,
    ay: 0,
    sprint: false,
    shoot: false,
    pass: false,
    tackle: false,
    skillDir: null,
    switchPlayer: false,
  });
  const err = await c.waitFor(isError);
  assert.equal(err.code, "NOT_IN_ROOM");
  c.close();
});

test("상대가 끊기면 남은 사람에게 알린다", async () => {
  const a = await TestClient.connect(wsUrl);
  a.send({ t: "create", nickname: "가" });
  const joined = await a.waitFor(isJoined);
  const b = await TestClient.connect(wsUrl);
  b.send({ t: "join", nickname: "나", code: joined.code });
  await b.waitFor(isJoined);
  b.close();

  const ev = await a.waitFor(
    (m): m is Extract<ServerMessage, { t: "event" }> =>
      m.t === "event" && m.kind === "opponentDisconnected",
  );
  assert.equal(ev.kind, "opponentDisconnected");
  a.close();
});

test("토큰으로 다시 이어붙을 수 있다", async () => {
  const a = await TestClient.connect(wsUrl);
  a.send({ t: "create", nickname: "가" });
  const joined = await a.waitFor(isJoined);
  const b = await TestClient.connect(wsUrl);
  b.send({ t: "join", nickname: "나", code: joined.code });
  const bJoined = await b.waitFor(isJoined);
  b.close();

  const b2 = await TestClient.connect(wsUrl);
  b2.send({ t: "resume", token: bJoined.token });
  const back = await b2.waitFor(isJoined);
  assert.equal(back.code, joined.code);
  assert.equal(back.side, "right");

  a.close();
  b2.close();
});

test("쓸 수 없는 토큰이면 TOKEN_INVALID", async () => {
  const c = await TestClient.connect(wsUrl);
  c.send({ t: "resume", token: "0123456789abcdef0123456789abcdef" });
  const err = await c.waitFor(isError);
  assert.equal(err.code, "TOKEN_INVALID");
  c.close();
});

test("연습 모드는 혼자서도 경기가 시작된다", async () => {
  const c = await TestClient.connect(wsUrl);
  c.send({ t: "practice", nickname: "혼자" });
  const joined = await c.waitFor(isJoined);
  assert.equal(joined.mode, "practice");
  const snap = await c.waitFor(
    (m): m is Extract<ServerMessage, { t: "snapshot" }> =>
      m.t === "snapshot" && m.players.length === 6,
  );
  assert.equal(snap.players.filter((p) => p.side === "right" && !p.human).length, 3);
  c.close();
});

test("ping 은 같은 ts 로 돌아온다", async () => {
  const c = await TestClient.connect(wsUrl);
  c.send({ t: "ping", ts: 4242 });
  const pong = await c.waitFor(
    (m): m is Extract<ServerMessage, { t: "pong" }> => m.t === "pong",
  );
  assert.equal(pong.ts, 4242);
  c.close();
});

test("메시지를 너무 빨리 보내면 끊는다", async () => {
  const c = await TestClient.connect(wsUrl);
  for (let i = 0; i < 80; i += 1) c.send({ t: "ping", ts: i });
  const err = await c.waitFor(isError);
  assert.equal(err.code, "RATE_LIMITED");
  c.close();
});
