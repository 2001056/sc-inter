/** HTTP(정적 웹 + /healthz) 와 WebSocket 을 같은 포트에서 서빙한다. */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { MATCH, type Side } from "./game/constants.ts";
import { PITCH_INFO, Room, RoomManager, type ClientConn } from "./game/room.ts";
import { parseClientMessage } from "./validate.ts";
import type { ErrorCode, ServerMessage } from "./protocol.ts";
import { serveStatic } from "./static.ts";

const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_MESSAGES_PER_SEC = 60;
const HEARTBEAT_MS = 30_000;

interface Session extends ClientConn {
  socket: WebSocket;
  room: Room | null;
  side: Side | null;
  alive: boolean;
  windowStart: number;
  windowCount: number;
}

export interface AppServer {
  http: Server;
  close(): Promise<void>;
  roomCount(): number;
}

export function createApp(): AppServer {
  const rooms = new RoomManager();
  const sessions = new Set<Session>();
  const startedAt = Date.now();
  let shuttingDown = false;

  const http = createServer((req, res) => {
    if (req.url === "/healthz" || req.url === "/healthz/") {
      const body = JSON.stringify({
        status: shuttingDown ? "shutting_down" : "ok",
        uptimeMs: Date.now() - startedAt,
        rooms: rooms.size,
        connections: sessions.size,
      });
      res.writeHead(shuttingDown ? 503 : 200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    if (serveStatic(req, res)) return;
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("찾을 수 없습니다.");
  });

  const wss = new WebSocketServer({
    server: http,
    path: "/ws",
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  function fail(session: Session, code: ErrorCode, message: string): void {
    session.send({ t: "error", code, message });
  }

  function leaveRoom(session: Session, notify: boolean): void {
    const room = session.room;
    const side = session.side;
    session.room = null;
    session.side = null;
    if (room === null || side === null) return;
    room.removeSeat(side);
    if (notify) {
      room.broadcast({ t: "event", kind: "opponentLeft" });
      room.broadcast(room.roomMessage());
    }
    if (room.humanCount === 0) rooms.delete(room.code);
  }

  function enterRoom(session: Session, room: Room, nickname: string): void {
    const seat = room.addHuman(session, nickname);
    if (seat === null) {
      fail(session, "ROOM_FULL", "방이 가득 찼습니다.");
      return;
    }
    session.room = room;
    session.side = seat.side;
    session.send({
      t: "joined",
      token: seat.token,
      code: room.code,
      side: seat.side,
      mode: room.mode,
      pitch: PITCH_INFO,
    });
    room.broadcast(
      { t: "event", kind: "opponentJoined", nickname },
      session,
    );
    room.maybeStart();
    room.broadcast(room.roomMessage());
  }

  wss.on("connection", (socket: WebSocket) => {
    const session: Session = {
      id: randomUUID(),
      socket,
      room: null,
      side: null,
      alive: true,
      windowStart: Date.now(),
      windowCount: 0,
      send(msg: ServerMessage) {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      },
      close() {
        socket.close();
      },
    };
    sessions.add(session);

    if (shuttingDown) {
      session.send({ t: "event", kind: "serverShutdown" });
      socket.close();
      return;
    }

    socket.on("pong", () => {
      session.alive = true;
    });

    socket.on("message", (raw: unknown, isBinary: boolean) => {
      if (isBinary) {
        fail(session, "BAD_MESSAGE", "텍스트 메시지만 받습니다.");
        return;
      }
      const now = Date.now();
      if (now - session.windowStart >= 1000) {
        session.windowStart = now;
        session.windowCount = 0;
      }
      session.windowCount += 1;
      if (session.windowCount > MAX_MESSAGES_PER_SEC) {
        fail(session, "RATE_LIMITED", "메시지를 너무 빠르게 보냈습니다.");
        socket.close();
        return;
      }

      const msg = parseClientMessage(String(raw));
      if (msg === null) {
        fail(session, "BAD_MESSAGE", "알 수 없는 메시지 형식입니다.");
        return;
      }

      switch (msg.t) {
        case "ping":
          session.send({ t: "pong", ts: msg.ts });
          return;
        case "create": {
          if (session.room !== null) leaveRoom(session, true);
          if (rooms.atCapacity) {
            fail(session, "SERVER_BUSY", "서버가 혼잡합니다. 잠시 후 다시 시도하세요.");
            return;
          }
          enterRoom(session, rooms.create("versus"), msg.nickname);
          return;
        }
        case "practice": {
          if (session.room !== null) leaveRoom(session, true);
          if (rooms.atCapacity) {
            fail(session, "SERVER_BUSY", "서버가 혼잡합니다. 잠시 후 다시 시도하세요.");
            return;
          }
          const room = rooms.create("practice");
          enterRoom(session, room, msg.nickname);
          const free = room.freeSide();
          if (free !== null) room.addBot(free);
          room.maybeStart();
          room.broadcast(room.roomMessage());
          return;
        }
        case "join": {
          const room = rooms.get(msg.code);
          if (!room || room.mode !== "versus") {
            fail(session, "ROOM_NOT_FOUND", "그런 코드의 방이 없습니다.");
            return;
          }
          if (room.isFull) {
            fail(session, "ROOM_FULL", "이미 두 명이 들어가 있습니다.");
            return;
          }
          if (session.room !== null) leaveRoom(session, true);
          enterRoom(session, room, msg.nickname);
          return;
        }
        case "resume": {
          let restored = false;
          for (const room of rooms.all()) {
            const seat = room.resume(msg.token, session);
            if (seat !== null) {
              session.room = room;
              session.side = seat.side;
              session.send({
                t: "joined",
                token: seat.token,
                code: room.code,
                side: seat.side,
                mode: room.mode,
                pitch: PITCH_INFO,
              });
              room.broadcast(
                { t: "event", kind: "opponentReconnected" },
                session,
              );
              room.broadcast(room.roomMessage());
              restored = true;
              break;
            }
          }
          if (!restored) fail(session, "TOKEN_INVALID", "다시 이어갈 경기가 없습니다.");
          return;
        }
        case "input": {
          if (session.room === null || session.side === null) {
            fail(session, "NOT_IN_ROOM", "방에 들어가 있지 않습니다.");
            return;
          }
          session.room.setInput(session.side, msg);
          return;
        }
        case "rematch": {
          if (session.room === null || session.side === null) {
            fail(session, "NOT_IN_ROOM", "방에 들어가 있지 않습니다.");
            return;
          }
          const started = session.room.setRematch(session.side, true);
          session.room.broadcast(session.room.roomMessage());
          if (started) session.room.broadcast({ t: "event", kind: "kickoff" });
          return;
        }
        case "leave": {
          leaveRoom(session, true);
          return;
        }
      }
    });

    socket.on("close", () => {
      sessions.delete(session);
      const room = session.room;
      if (room !== null) {
        room.detach(session);
        room.broadcast({ t: "event", kind: "opponentDisconnected" });
        room.broadcast(room.roomMessage());
        if (room.humanCount === 0) rooms.delete(room.code);
      }
    });

    socket.on("error", () => {
      socket.close();
    });
  });

  // 전역 시뮬레이션 루프
  let lastTickAt = Date.now();
  const loop = setInterval(() => {
    const now = Date.now();
    const elapsed = now - lastTickAt;
    lastTickAt = now;
    for (const room of rooms.all()) room.advance(elapsed, now);
  }, 1000 / MATCH.tickHz);

  // 재접속 유예 만료와 방 정리
  const sweep = setInterval(() => {
    const now = Date.now();
    rooms.sweep(now, (room) => {
      room.broadcast({ t: "event", kind: "opponentLeft" });
      room.broadcast(room.roomMessage());
    });
  }, 5_000);

  // 죽은 연결 감지
  const heartbeat = setInterval(() => {
    for (const session of sessions) {
      if (!session.alive) {
        session.socket.terminate();
        continue;
      }
      session.alive = false;
      session.socket.ping();
    }
  }, HEARTBEAT_MS);

  async function close(): Promise<void> {
    shuttingDown = true;
    clearInterval(loop);
    clearInterval(sweep);
    clearInterval(heartbeat);
    for (const session of sessions) {
      session.send({ t: "event", kind: "serverShutdown" });
      session.socket.close(1001, "server shutting down");
    }
    await new Promise<void>((done) => {
      wss.close(() => done());
    });
    await new Promise<void>((done) => {
      http.close(() => done());
    });
  }

  return { http, close, roomCount: () => rooms.size };
}
