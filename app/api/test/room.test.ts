import { test } from "node:test";
import assert from "node:assert/strict";
import { Room, RoomManager, makeRoomCode, type ClientConn } from "../src/game/room.ts";
import { ROOM } from "../src/game/constants.ts";
import type { ServerMessage } from "../src/protocol.ts";

function fakeConn(id: string): ClientConn & { sent: ServerMessage[]; closed: boolean } {
  const sent: ServerMessage[] = [];
  return {
    id,
    sent,
    closed: false,
    send(msg) {
      sent.push(msg);
    },
    close() {
      this.closed = true;
    },
  };
}

test("방 코드는 6자 대문자·숫자다", () => {
  for (let i = 0; i < 50; i += 1) {
    assert.match(makeRoomCode(), /^[A-Z0-9]{6}$/);
  }
});

test("한 방에는 두 명까지만 앉는다", () => {
  const room = new Room("ABC123", "versus");
  assert.ok(room.addHuman(fakeConn("a"), "가"));
  assert.ok(room.addHuman(fakeConn("b"), "나"));
  assert.equal(room.isFull, true);
  assert.equal(room.addHuman(fakeConn("c"), "다"), null);
});

test("두 명이 차면 킥오프 카운트다운이 시작된다", () => {
  const room = new Room("ABC123", "versus");
  room.addHuman(fakeConn("a"), "가");
  assert.equal(room.maybeStart(), false);
  assert.equal(room.match.phase, "waiting");
  room.addHuman(fakeConn("b"), "나");
  assert.equal(room.maybeStart(), true);
  assert.equal(room.match.phase, "countdown");
});

test("재경기는 양쪽이 다 눌러야 시작된다", () => {
  const room = new Room("ABC123", "versus");
  room.addHuman(fakeConn("a"), "가");
  room.addHuman(fakeConn("b"), "나");
  room.maybeStart();
  room.match.phase = "ended";
  assert.equal(room.setRematch("left", true), false);
  assert.equal(room.match.phase, "ended");
  assert.equal(room.setRematch("right", true), true);
  assert.equal(room.match.phase, "countdown");
  assert.equal(room.match.score.left, 0);
});

test("연결이 끊기면 자리는 남고 유예 뒤에 사라진다", () => {
  const room = new Room("ABC123", "versus");
  const conn = fakeConn("a");
  const seat = room.addHuman(conn, "가");
  assert.ok(seat);
  room.addHuman(fakeConn("b"), "나");

  room.detach(conn);
  assert.equal(room.seats.size, 2);
  assert.equal(room.metaPlayers()[0]?.connected, false);

  assert.deepEqual(room.expireDisconnected(Date.now()), []);
  const later = Date.now() + ROOM.reconnectGraceMs + 1000;
  assert.deepEqual(room.expireDisconnected(later), ["left"]);
  assert.equal(room.seats.size, 1);
});

test("같은 토큰으로 재접속하면 같은 자리로 돌아온다", () => {
  const room = new Room("ABC123", "versus");
  const conn = fakeConn("a");
  const seat = room.addHuman(conn, "가");
  assert.ok(seat);
  room.addHuman(fakeConn("b"), "나");
  room.maybeStart();
  room.match.score.left = 2;

  room.detach(conn);
  const again = fakeConn("a2");
  const restored = room.resume(seat.token, again);
  assert.equal(restored?.side, "left");
  assert.equal(room.match.score.left, 2);
  assert.equal(room.resume("deadbeef", fakeConn("x")), null);
});

test("연습 방은 봇이 상대를 채운다", () => {
  const room = new Room("ABC123", "practice");
  room.addHuman(fakeConn("a"), "가");
  const free = room.freeSide();
  assert.equal(free, "right");
  room.addBot("right");
  assert.equal(room.maybeStart(), true);
  assert.equal(room.humanCount, 1);
  assert.equal(room.metaPlayers()[1]?.bot, true);
});

test("아무도 없는 방은 정리된다", () => {
  const rooms = new RoomManager();
  const room = rooms.create("versus");
  const conn = fakeConn("a");
  room.addHuman(conn, "가");
  room.detach(conn);
  assert.equal(rooms.size, 1);
  rooms.sweep(Date.now() + ROOM.emptyRoomTtlMs + 1000, () => {});
  assert.equal(rooms.size, 0);
});

test("브로드캐스트는 접속 중인 자리에만 간다", () => {
  const room = new Room("ABC123", "versus");
  const a = fakeConn("a");
  const b = fakeConn("b");
  room.addHuman(a, "가");
  room.addHuman(b, "나");
  room.broadcast({ t: "event", kind: "kickoff" }, a);
  assert.equal(a.sent.length, 0);
  assert.equal(b.sent.length, 1);
});

test("루프를 돌리면 스냅샷이 양쪽에 같은 내용으로 나간다", () => {
  const room = new Room("ABC123", "versus");
  const a = fakeConn("a");
  const b = fakeConn("b");
  room.addHuman(a, "가");
  room.addHuman(b, "나");
  room.maybeStart();
  for (let i = 0; i < 60; i += 1) room.advance(1000 / 60, Date.now());
  const snapA = a.sent.filter((m) => m.t === "snapshot");
  const snapB = b.sent.filter((m) => m.t === "snapshot");
  assert.ok(snapA.length > 0);
  assert.equal(snapA.length, snapB.length);
  assert.deepEqual(snapA.at(-1), snapB.at(-1));
});
