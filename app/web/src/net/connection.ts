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

/*
 * 재접속 토큰은 sessionStorage 에 둔다.
 * 새로고침해도 같은 탭이면 같은 자리로 돌아갈 수 있고, 탭을 닫으면 사라진다.
 * localStorage 를 쓰면 다른 탭이 같은 자리를 빼앗으려 할 수 있어 쓰지 않는다.
 */
const TOKEN_KEY = "sc-inter:token";

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token === null) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 시크릿 모드에서는 저장이 막힌다. 메모리에 든 토큰만으로도 재접속은 된다.
  }
}

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
    this.setToken(null);
    this.retries = 0;
    this.inputSeq = 0;
    this.open();
  }

  /**
   * 새로고침 직후 부른다. 지난 탭 세션에서 받은 토큰이 있으면 그 자리로 돌아간다.
   * 토큰이 없거나 만료됐으면 아무 일도 일어나지 않고 로비에 머문다.
   */
  resumeIfPossible(): boolean {
    const token = readToken();
    if (!token) return false;
    this.stop();
    this.closedByUser = false;
    this.intent = { t: "resume", token };
    this.token = token;
    this.retries = 0;
    this.inputSeq = 0;
    this.open();
    return true;
  }

  private setToken(token: string | null): void {
    this.token = token;
    writeToken(token);
  }

  /**
   * 사용자가 직접 방을 나갈 때. 자리를 비우고 토큰도 버린다.
   * 새로고침으로 되돌아올 여지를 남기지 않는다.
   */
  leave(): void {
    const socket = this.socket;
    if (socket && socket.readyState === WebSocket.OPEN) {
      this.rawSend(socket, { t: "leave" });
    }
    this.setToken(null);
    this.stop();
  }

  /**
   * 연결만 닫는다. 토큰은 건드리지 않으므로 새로고침 뒤 같은 자리로 돌아올 수 있다.
   * 컴포넌트 정리에서 부른다.
   */
  stop(): void {
    this.closedByUser = true;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    /*
     * 여기서 `leave` 를 보내면 안 된다. 서버가 자리를 즉시 비워 버려서
     * 저장해 둔 토큰이 쓸모없어지고 새로고침 복귀가 깨진다.
     * 연결만 끊으면 서버는 30초 동안 자리를 지켜 준다.
     * 방을 진짜로 떠나는 것은 `leave()` 뿐이다.
     */
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
        this.setToken(msg.token);
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
        if (msg.code === "TOKEN_INVALID") this.setToken(null);
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
