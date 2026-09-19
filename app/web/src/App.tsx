/**
 * 화면 전환과 서버 연결을 한곳에서 들고 있는 뿌리 컴포넌트.
 *
 * 스냅샷은 여기서 React 상태로 올리지 않는다. 20Hz 로 컴포넌트를 다시 그리면
 * 손해라서 `SnapshotBuffer` 로 흘려보내고, 3D 렌더 루프가 직접 읽어 간다.
 * React 는 로비/대기/경기/종료 같은 "상태가 드물게 바뀌는 것" 만 맡는다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Connection, type LinkStatus } from "./net/connection.ts";
import {
  ERROR_TEXT,
  FALLBACK_PITCH,
  type ErrorCode,
  type JoinedMessage,
  type RoomMessage,
  type ServerEvent,
} from "./net/protocol.ts";
import { isMatchEvent, MatchEventHub } from "./game/feedback.ts";
import { SnapshotBuffer } from "./game/interpolation.ts";
import { LobbyView } from "./ui/LobbyView.tsx";
import { MatchView } from "./ui/MatchView.tsx";
import { WebGLNotice } from "./ui/WebGLNotice.tsx";

const NICKNAME_KEY = "sc-inter:nickname";

/** 서버에 보내기 전에 한 번 다듬는다. 서버도 같은 규칙으로 다시 검사한다. */
export function cleanNickname(raw: string): string {
  /*
   * 제어문자를 코드포인트 값으로 걸러낸다.
   * 정규식에 제어문자를 직접 쓰면 소스 파일 안에 진짜 NUL 바이트가
   * 들어가 넣을 수 있어(실제로 한 번 들어갔다) 그 패턴 자체를 쓰지 않는다.
   * 서버도 같은 규칙으로 다시 검사한다.
   */
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || code === 127) continue;
    out += ch;
  }
  return out.trim().slice(0, 12);
}

function readStoredNickname(): string {
  try {
    return localStorage.getItem(NICKNAME_KEY) ?? "";
  } catch {
    return "";
  }
}

/** 주소창의 `?room=CODE` 를 읽는다. 초대 링크로 들어온 경우다. */
function readInviteCode(): string {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("room") ?? "";
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(
      canvas.getContext("webgl2") ??
        canvas.getContext("webgl") ??
        canvas.getContext("experimental-webgl"),
    );
  } catch {
    return false;
  }
}

export interface BannerMessage {
  id: number;
  text: string;
}

export function App(): React.ReactElement {
  const [webglReady] = useState(supportsWebGL);
  const [nickname, setNickname] = useState(readStoredNickname);
  const [inviteCode] = useState(readInviteCode);

  const [joined, setJoined] = useState<JoinedMessage | null>(null);
  const [room, setRoom] = useState<RoomMessage | null>(null);
  const [link, setLink] = useState<LinkStatus>("idle");
  const [latency, setLatency] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<BannerMessage | null>(null);
  const buffer = useMemo(() => new SnapshotBuffer(), []);
  /** 슛·패스·득점 같은 경기 이벤트는 React 상태를 거치지 않고 경기 화면으로 곧장 넘긴다. */
  const matchEvents = useMemo(() => new MatchEventHub(), []);
  const connectionRef = useRef<Connection | null>(null);
  const bannerSeq = useRef(0);

  const showBanner = useCallback((text: string) => {
    bannerSeq.current += 1;
    setBanner({ id: bannerSeq.current, text });
  }, []);

  useEffect(() => {
    const connection = new Connection({
      onStatus: (status) => {
        setLink(status);
        if (status === "reconnecting") showBanner("연결이 끊겼습니다. 다시 접속하는 중…");
        if (status === "open") setError(null);
        if (status === "closed") {
          showBanner("서버에 다시 연결하지 못했습니다. 로비에서 새로 시작해 주세요.");
        }
      },
      onJoined: (message) => {
        setJoined(message);
        setError(null);
        buffer.reset();
      },
      onRoom: setRoom,
      onSnapshot: (snapshot) => buffer.push(snapshot),
      onEvent: (event) => handleEvent(event),
      onError: (code: ErrorCode, message) => {
        setError(ERROR_TEXT[code] ?? message);
        // 방에 못 들어가는 종류의 오류는 로비로 되돌린다.
        if (code === "ROOM_NOT_FOUND" || code === "ROOM_FULL" || code === "SERVER_BUSY") {
          setJoined(null);
          setRoom(null);
        }
      },
      onLatency: setLatency,
    });
    connectionRef.current = connection;
    // 새로고침으로 돌아온 경우 지난 자리로 되돌린다. 토큰이 없으면 로비에 머문다.
    connection.resumeIfPossible();

    function handleEvent(event: ServerEvent): void {
      if (isMatchEvent(event)) {
        matchEvents.emit(event);
        return;
      }
      switch (event.kind) {
        case "opponentJoined":
          showBanner(`${event.nickname} 님이 들어왔습니다.`);
          return;
        case "opponentLeft":
          showBanner("상대가 방을 나갔습니다.");
          return;
        case "opponentDisconnected":
          showBanner("상대의 연결이 끊겼습니다. 30초 동안 기다립니다.");
          return;
        case "opponentReconnected":
          showBanner("상대가 다시 접속했습니다.");
          return;
        case "serverShutdown":
          showBanner("서버가 곧 종료됩니다. 경기를 마칩니다.");
          return;
        default:
          return;
      }
    }

    return () => {
      connection.stop();
      connectionRef.current = null;
    };
  }, [buffer, matchEvents, showBanner]);

  // 배너는 잠깐만 보여 준다.
  useEffect(() => {
    if (!banner) return;
    const timer = window.setTimeout(() => setBanner(null), 4200);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const persistNickname = useCallback((value: string) => {
    setNickname(value);
    try {
      localStorage.setItem(NICKNAME_KEY, value);
    } catch {
      // 시크릿 모드에서는 저장이 막힌다. 이번 판만 쓰면 되므로 넘어간다.
    }
  }, []);

  const startCreate = useCallback(
    (name: string) => {
      persistNickname(name);
      connectionRef.current?.start({ t: "create", nickname: name });
    },
    [persistNickname],
  );

  const startJoin = useCallback(
    (name: string, code: string) => {
      persistNickname(name);
      connectionRef.current?.start({ t: "join", nickname: name, code });
    },
    [persistNickname],
  );

  const startPractice = useCallback(
    (name: string) => {
      persistNickname(name);
      connectionRef.current?.start({ t: "practice", nickname: name });
    },
    [persistNickname],
  );

  const leave = useCallback(() => {
    connectionRef.current?.leave();
    setJoined(null);
    setRoom(null);
    setLatency(null);
    buffer.reset();
    // 초대 링크로 들어왔더라도 나간 뒤에는 주소를 깨끗하게 둔다.
    if (window.location.search) {
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, [buffer]);

  const rematch = useCallback(() => {
    connectionRef.current?.send({ t: "rematch" });
  }, []);

  if (!webglReady) return <WebGLNotice />;

  if (joined && connectionRef.current) {
    return (
      <MatchView
        connection={connectionRef.current}
        buffer={buffer}
        events={matchEvents}
        joined={joined}
        room={room}
        link={link}
        latency={latency}
        banner={banner}
        myNickname={nickname}
        onLeave={leave}
        onRematch={rematch}
      />
    );
  }

  return (
    <LobbyView
      nickname={nickname}
      inviteCode={inviteCode}
      connecting={link === "connecting" || link === "reconnecting"}
      error={error}
      pitchHeight={FALLBACK_PITCH.playerHeight}
      onNicknameChange={setNickname}
      onCreate={startCreate}
      onJoin={startJoin}
      onPractice={startPractice}
    />
  );
}
