/**
 * WebSocket 연결 한 개를 관리한다.
 *
 * - 웹을 서빙한 것과 같은 origin 의 `/ws` 로 붙는다(개발 서버에서는 Vite 프록시가 8787 로 넘긴다).
 * - 끊기면 지수 백오프로 다시 붙고, `joined` 에서 받은 토큰으로 `resume` 을 먼저 시도한다.
 * - 스냅샷은 React 상태로 올리지 않는다. 20Hz 로 컴포넌트를 다시 그리면 손해라
 *   렌더 루프가 직접 읽는 `SnapshotBuffer` 로 흘려보낸다.
 */
import type {
  ClientMessage,
  ErrorCode,
  InputState,
  JoinedMessage,
  RoomMessage,
  ServerEvent,
  ServerMessage,
  Snapshot,
} from "./protocol.ts";

export type LinkStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface ConnectionHandlers {
  onStatus(status: LinkStatus): void;
  onJoined(msg: JoinedMessage): void;
  onRoom(msg: RoomMessage): void;
  onSnapshot(msg: Snapshot): void;
  onEvent(msg: ServerEvent): void;
  onError(code: ErrorCode, message: string): void;
  onLatency(ms: number): void;
}

/** 재접속을 포기하기 전까지의 시도 횟수. 서버의 30초 유예보다 넉넉하다. */
const MAX_RETRIES = 8;
const PING_INTERVAL_MS = 3_000;

function socketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

export class Connection {
  private socket: WebSocket | null = null;
  private status: LinkStatus = "idle";
  private token: string | null = null;
  /** 최초 접속에서 보낼 메시지. 재접속 때는 `resume` 이 이 자리를 대신한다. */
  private intent: ClientMessage | null = null;
  private retries = 0;
  private retryTimer: number | null = null;
  private pingTimer: number | null = null;
  private closedByUser = false;
  private inputSeq = 0;

  constructor(private readonly handlers: ConnectionHandlers) {}

  /** 로비에서 고른 시작 동작으로 접속을 연다. */
  start(intent: ClientMessage): void {
    this.stop();
    this.closedByUser = false;
    this.intent = intent;
    this.token = null;
    this.retries = 0;
    this.inputSeq = 0;
    this.open();
  }

  /** 사용자가 직접 방을 나갈 때. 재접속하지 않는다. */
  stop(): void {
    this.closedByUser = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      this.rawSend(socket, { t: "leave" });
    }
    socket?.close();
    this.setStatus("idle");
  }

  send(message: ClientMessage): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    this.rawSend(socket, message);
  }

  /** 입력은 서버가 보는 `seq` 가 단조 증가해야 한다. 번호 관리를 여기서 맡는다. */
  sendInput(input: Omit<InputState, "seq">): void {
    this.inputSeq += 1;
    this.send({ t: "input", seq: this.inputSeq, ...input });
  }

  get linkStatus(): LinkStatus {
    return this.status;
  }

  private open(): void {
    this.setStatus(this.retries === 0 ? "connecting" : "reconnecting");
    let socket: WebSocket;
    try {
      socket = new WebSocket(socketUrl());
    } catch {
      this.scheduleRetry();
      return;
    }
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.retries = 0;
      this.setStatus("open");
      const first: ClientMessage | null = this.token
        ? { t: "resume", token: this.token }
        : this.intent;
      if (first) this.rawSend(socket, first);
      this.startPing();
    });

    socket.addEventListener("message", (ev) => {
      if (this.socket !== socket) return;
      if (typeof ev.data !== "string") return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.dispatch(parsed as ServerMessage);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearTimers();
      if (this.closedByUser) {
        this.setStatus("idle");
        return;
      }
      this.scheduleRetry();
    });

    socket.addEventListener("error", () => {
      // close 이벤트가 이어서 오므로 여기서는 아무것도 하지 않는다.
    });
  }

  private dispatch(msg: ServerMessage): void {
    switch (msg.t) {
      case "joined":
        this.token = msg.token;
        this.handlers.onJoined(msg);
        return;
      case "room":
        this.handlers.onRoom(msg);
        return;
      case "snapshot":
        this.handlers.onSnapshot(msg);
        return;
      case "event":
        this.handlers.onEvent(msg);
        return;
      case "pong":
        this.handlers.onLatency(Math.max(0, Math.round(Date.now() - msg.ts)));
        return;
      case "error":
        // 토큰이 만료됐으면 재접속으로는 못 살린다. 처음 의도로 되돌린다.
        if (msg.code === "TOKEN_INVALID") this.token = null;
        if (msg.code === "RATE_LIMITED" || msg.code === "SERVER_BUSY") {
          this.closedByUser = true;
        }
        this.handlers.onError(msg.code, msg.message);
        return;
      default:
        return;
    }
  }

  private scheduleRetry(): void {
    if (this.retries >= MAX_RETRIES) {
      this.setStatus("closed");
      return;
    }
    this.retries += 1;
    this.setStatus("reconnecting");
    const delay = Math.min(8_000, 400 * 2 ** (this.retries - 1));
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    const tick = () => this.send({ t: "ping", ts: Date.now() });
    tick();
    this.pingTimer = window.setInterval(tick, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      window.clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimers(): void {
    this.stopPing();
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private setStatus(status: LinkStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus(status);
  }

  private rawSend(socket: WebSocket, message: ClientMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // 전송 실패는 곧 close 로 이어진다. 여기서는 조용히 넘긴다.
    }
  }
}
