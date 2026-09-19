/**
 * 경기 화면.
 *
 * 세 가지 박자가 한 화면에서 따로 돈다.
 *  - 60fps: 3D 렌더. `MatchScene` 이 스냅샷 버퍼를 직접 읽는다.
 *  - 30Hz: 입력 전송. **렌더와 묶지 않은 독립 타이머**(`InputPump`)다. 렌더가
 *    느려져도 조작은 제때 서버에 닿는다. 메인 스레드가 막혀 타이머가 굶을 때만
 *    렌더 루프가 대신 보낸다. 서버의 초당 60개 제한 안쪽이다.
 *  - 10Hz: HUD 갱신. 사람 눈에는 충분하고 React 재렌더를 아낀다.
 *
 * 경기 이벤트(슛·패스·개인기·득점·킥오프·종료)는 `MatchEventHub` 로 받아
 * 알림·득점 연출·효과음으로 바꾼다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BannerMessage } from "../App.tsx";
import { GameAudio, readAudioSettings, type AudioSettings } from "../game/audio.ts";
import {
  describeEvent,
  FeedQueue,
  GOAL_CALLOUT_MS,
  goalCallout,
  soundFor,
  type DescribeContext,
  type FeedItem,
  type GoalCallout,
  type MatchEventHub,
} from "../game/feedback.ts";
import { InputController } from "../game/input.ts";
import { emptyFrame, type MatchFrame } from "../game/interpolation.ts";
import type { SnapshotBuffer } from "../game/interpolation.ts";
import type { Connection, LinkStatus } from "../net/connection.ts";
import {
  ROLE_LABEL,
  type JoinedMessage,
  type MatchStats,
  type Phase,
  type RoomMessage,
  type Side,
} from "../net/protocol.ts";
import { readGraphicsQuality, writeGraphicsQuality, type GraphicsQuality } from "../three/quality.ts";
import { MatchScene, type CameraMode } from "../three/scene.ts";
import { EventFeed } from "./EventFeed.tsx";
import { Hud, type HudSnapshot } from "./Hud.tsx";
import { InputPump } from "./inputPump.ts";
import { MatchSettings } from "./MatchSettings.tsx";
import { Minimap } from "./Minimap.tsx";
import { StatCompare } from "./StatCompare.tsx";
import { TouchControls } from "./TouchControls.tsx";

const HUD_HZ = 10;

interface Props {
  connection: Connection;
  buffer: SnapshotBuffer;
  events: MatchEventHub;
  joined: JoinedMessage;
  room: RoomMessage | null;
  link: LinkStatus;
  latency: number | null;
  banner: BannerMessage | null;
  myNickname: string;
  onLeave(): void;
  onRematch(): void;
}

interface HudState extends HudSnapshot {
  stats: MatchStats | null;
}

const EMPTY_HUD: HudState = {
  scoreLeft: 0,
  scoreRight: 0,
  timeLeftMs: 0,
  stamina: 1,
  charge: 0,
  skillCooldownMs: 0,
  tackleCooldownMs: 0,
  controlledRole: "미드필더",
  hasBall: false,
  stats: null,
};

/** 터치가 되는 기기인지. 마우스가 함께 달린 기기에서는 터치 UI 를 띄우지 않는다. */
function isTouchPrimary(): boolean {
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

export function MatchView(props: Props): React.ReactElement {
  const { connection, buffer, events, joined, room, link, latency, banner } = props;
  const pitch = joined.pitch;
  const mySide = joined.side;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<MatchScene | null>(null);
  const frameRef = useRef<MatchFrame>(emptyFrame());
  const cameraModeRef = useRef<CameraMode>("follow");
  const audioRef = useRef<GameAudio | null>(null);
  const pumpRef = useRef<InputPump | null>(null);
  const feedRef = useRef<FeedQueue | null>(null);
  feedRef.current ??= new FeedQueue();
  const feedQueue = feedRef.current;
  /** 득점 자막 key. 구독을 다시 걸어도 이어지게 ref 로 둔다(같은 key 면 등장 연출이 안 나온다). */
  const goalSeqRef = useRef(0);
  const settingsButtonRef = useRef<HTMLButtonElement | null>(null);

  const input = useMemo(() => new InputController(), []);
  const [hud, setHud] = useState<HudState>(EMPTY_HUD);
  const [phase, setPhase] = useState<Phase>(room?.phase ?? "waiting");
  const [countdownMs, setCountdownMs] = useState(0);
  const [touchUi] = useState(isTouchPrimary);
  const [copied, setCopied] = useState<string | null>(null);
  const [feed, setFeed] = useState<readonly FeedItem[]>([]);
  const [goal, setGoal] = useState<GoalCallout | null>(null);
  const [statsOpen, setStatsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [audioSettings, setAudioSettings] = useState<AudioSettings>(() => readAudioSettings());
  const [quality, setQuality] = useState<GraphicsQuality>(() => readGraphicsQuality());
  const qualityRef = useRef(quality);
  qualityRef.current = quality;

  const leftName = useMemo(
    () => room?.players.find((p) => p.side === "left" && !p.bot)?.nickname ?? "왼쪽 팀",
    [room],
  );
  const rightName = useMemo(
    () => room?.players.find((p) => p.side === "right" && !p.bot)?.nickname ?? "오른쪽 팀",
    [room],
  );

  const nicknames = useMemo<Record<Side, string>>(
    () => ({ left: leftName, right: rightName }),
    [leftName, rightName],
  );
  const nicknamesRef = useRef(nicknames);
  nicknamesRef.current = nicknames;

  const readFrame = useCallback(() => frameRef.current, []);

  /** 알림과 득점 연출을 모두 비운다. 새 경기·재접속에서 지난 판의 것이 새지 않게 한다. */
  const clearFeedback = useCallback(() => {
    if (feedQueue.clear()) setFeed([]);
    setGoal(null);
  }, [feedQueue]);

  // 재접속하면 App 이 새 `joined` 를 주고 버퍼를 비운다. 화면에 남은 지난 프레임·기록·알림도 버린다.
  useEffect(() => {
    frameRef.current = emptyFrame();
    setHud(EMPTY_HUD);
    clearFeedback();
  }, [joined, clearFeedback]);

  // 재경기로 새 경기가 시작되면(종료 → 카운트다운) 지난 경기의 알림을 치운다.
  const lastPhaseRef = useRef<Phase>(phase);
  useEffect(() => {
    const previous = lastPhaseRef.current;
    lastPhaseRef.current = phase;
    if (previous === "ended" && phase !== "ended") clearFeedback();
    if (phase === "ended") setStatsOpen(false);
  }, [phase, clearFeedback]);

  // 공격 방향이 정해져야 방향키를 월드 좌표로 바꿀 수 있다.
  useEffect(() => {
    input.setAttackDir(mySide === "left" ? 1 : -1);
  }, [input, mySide]);

  // 키보드 + 30Hz 입력 전송. 렌더 루프와 따로 돈다.
  useEffect(() => {
    const detach = input.attach();
    input.onCameraToggle(() => {
      cameraModeRef.current = cameraModeRef.current === "follow" ? "broadcast" : "follow";
    });

    const pump = new InputPump({
      poll: () => input.poll(),
      send: (payload) => connection.sendInput(payload),
      isOpen: () => connection.linkStatus === "open",
    });
    pump.setHidden(document.visibilityState === "hidden");
    pump.start();
    pumpRef.current = pump;
    // 창을 벗어나거나 탭이 숨으면 "아무것도 누르지 않은 상태" 를 즉시 한 번 보낸다.
    input.onRelease(() => pump.flush());
    const onVisibility = () => pump.setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      pump.stop();
      pumpRef.current = null;
      detach();
      input.onCameraToggle(null);
      input.onRelease(null);
      input.setEnabled(false);
    };
  }, [connection, input]);

  // 카운트다운·종료 중에는 입력을 서버가 무시하므로 화면도 받지 않는다.
  useEffect(() => {
    input.setEnabled(phase === "playing");
  }, [input, phase]);

  // 효과음. 경기 화면에 있는 동안만 살아 있고, 숨으면 멈추고, 나가면 닫는다.
  useEffect(() => {
    const audio = new GameAudio();
    audioRef.current = audio;
    audio.setHidden(document.visibilityState === "hidden");
    // 켜 둔 설정이 저장돼 있어도 사용자 동작이 있기 전에는 소리를 내지 않는다.
    // iOS Safari 는 pointerdown 을 사용자 동작으로 치지 않을 수 있어 뗌·클릭도 함께 본다.
    const gestures = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;
    const onGesture = () => audio.unlock();
    const onVisibility = () => audio.setHidden(document.visibilityState === "hidden");
    for (const type of gestures) window.addEventListener(type, onGesture, { passive: true });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      for (const type of gestures) window.removeEventListener(type, onGesture);
      document.removeEventListener("visibilitychange", onVisibility);
      audio.dispose();
      audioRef.current = null;
    };
  }, []);

  // 서버 경기 이벤트 → 알림 · 득점 연출 · 효과음.
  useEffect(() => {
    const context = (): DescribeContext => ({
      mySide,
      nicknames: nicknamesRef.current,
      lookup: (playerId) => {
        const player = frameRef.current.players.find((p) => p.id === playerId);
        if (!player) return null;
        return {
          side: player.side,
          role: player.role,
          controlled: player.human && frameRef.current.controlled[player.side] === player.id,
        };
      },
    });
    return events.subscribe((event) => {
      const cue = soundFor(event);
      if (cue) audioRef.current?.play(cue);

      if (event.kind === "goal") {
        goalSeqRef.current += 1;
        setGoal(goalCallout(event, context(), goalSeqRef.current));
        return;
      }
      if (event.kind === "matchEnd") {
        // 종료 화면이 결과를 크게 보여 주므로 남은 알림은 치운다.
        if (feedQueue.clear()) setFeed([]);
        return;
      }
      const entry = describeEvent(event, context());
      if (entry && feedQueue.push(entry, performance.now())) {
        setFeed([...feedQueue.list()]);
      }
    });
  }, [events, feedQueue, mySide]);

  // 설정 판은 Escape 로 닫고 포커스를 `설정` 버튼으로 돌려준다. Escape 는 게임 키가 아니다.
  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setSettingsOpen(false);
      settingsButtonRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  useEffect(() => {
    if (!goal) return;
    const timer = window.setTimeout(() => setGoal(null), GOAL_CALLOUT_MS);
    return () => window.clearTimeout(timer);
  }, [goal]);

  // 3D 렌더(60fps) + HUD(10Hz). 입력은 위의 타이머가 보내고, 여기서는 타이머가
  // 메인 스레드에 밀려 늦었을 때만 대신 보낸다(`InputPump.due`).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let scene: MatchScene | null = null;
    try {
      scene = new MatchScene(canvas, pitch, qualityRef.current);
    } catch {
      // WebGL 을 못 쓰면 3D 만 빠진다. HUD 와 입력은 계속 돈다.
      scene = null;
    }
    sceneRef.current = scene;

    let raf = 0;
    let last = performance.now();
    let hudAccum = 0;

    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      pumpRef.current?.due();

      const sampled = buffer.sample(dt * 1000);
      if (sampled) frameRef.current = sampled;
      const frame = frameRef.current;

      if (scene && frame.ready) {
        scene.render(frame, {
          mySide,
          cameraMode: cameraModeRef.current,
          nicknames: nicknamesRef.current,
        }, dt);
      }

      hudAccum += dt;
      if (hudAccum >= 1 / HUD_HZ) {
        hudAccum = 0;
        const mine = frame.players.find((p) => p.id === frame.controlled[mySide]);
        setHud({
          scoreLeft: frame.score.left,
          scoreRight: frame.score.right,
          timeLeftMs: frame.timeLeftMs,
          stamina: mine?.stamina ?? 1,
          charge: mine?.charge ?? 0,
          skillCooldownMs: mine?.cooldowns.skill ?? 0,
          tackleCooldownMs: mine?.cooldowns.tackle ?? 0,
          controlledRole: mine ? ROLE_LABEL[mine.role] : "미드필더",
          hasBall: Boolean(mine && frame.ball.ownerId === mine.id),
          stats: frame.stats,
        });
        if (frame.ready) {
          setPhase(frame.phase);
          setCountdownMs(frame.countdownMs);
        }
        if (feedQueue.prune(now)) setFeed([...feedQueue.list()]);
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onResize = () => scene?.resize();
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      scene?.dispose();
      sceneRef.current = null;
    };
  }, [buffer, feedQueue, mySide, pitch]);

  const inviteLink = useMemo(() => {
    const url = new URL(window.location.href);
    url.search = `?room=${joined.code}`;
    return url.toString();
  }, [joined.code]);

  const copy = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      window.setTimeout(() => setCopied(null), 1800);
    } catch {
      setCopied("복사할 수 없습니다. 직접 선택해 주세요.");
    }
  }, []);

  const toggleCamera = useCallback(() => {
    cameraModeRef.current = cameraModeRef.current === "follow" ? "broadcast" : "follow";
  }, []);

  const toggleSound = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // 이 클릭이 사용자 동작이므로 켜는 순간 오디오를 깨울 수 있다.
    audio.setEnabled(!audio.current.enabled);
    setAudioSettings(audio.current);
  }, []);

  const changeVolume = useCallback((volume: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.setVolume(volume);
    setAudioSettings(audio.current);
  }, []);

  const changeQuality = useCallback((value: GraphicsQuality) => {
    writeGraphicsQuality(value);
    setQuality(value);
    sceneRef.current?.setQuality(value);
  }, []);

  const result = room?.result ?? null;
  const rematchReady = room?.players.filter((p) => !p.bot && p.rematchReady).length ?? 0;
  const humans = room?.players.filter((p) => !p.bot).length ?? 1;
  const inMatch = phase !== "waiting" && phase !== "ended";

  let cornerPanel: React.ReactNode = null;
  if (settingsOpen) {
    cornerPanel = (
      <MatchSettings
        audio={audioSettings}
        quality={quality}
        onToggleSound={toggleSound}
        onVolume={changeVolume}
        onQuality={changeQuality}
        onClose={() => {
          setSettingsOpen(false);
          settingsButtonRef.current?.focus();
        }}
      />
    );
  } else if (statsOpen && inMatch) {
    cornerPanel = (
      <div className="corner-card interactive">
        <p className="corner-card__title">경기 기록</p>
        <StatCompare stats={hud.stats} leftName={leftName} rightName={rightName} compact />
      </div>
    );
  }

  return (
    <div className={touchUi ? "match match--touch" : "match"}>
      <canvas className="match__canvas" ref={canvasRef} />

      <Hud
        hud={hud}
        pitch={pitch}
        mySide={mySide}
        leftName={leftName}
        rightName={rightName}
        link={link}
        latency={latency}
        goalSide={goal?.side ?? null}
        statsOpen={statsOpen && inMatch}
        statsEnabled={inMatch}
        settingsOpen={settingsOpen}
        settingsButtonRef={settingsButtonRef}
        soundOn={audioSettings.enabled}
        onLeave={props.onLeave}
        onToggleCamera={toggleCamera}
        onToggleStats={() => {
          setSettingsOpen(false);
          setStatsOpen((open) => !open);
        }}
        onToggleSettings={() => {
          setStatsOpen(false);
          setSettingsOpen((open) => !open);
        }}
        cornerPanel={cornerPanel}
      >
        <Minimap pitch={pitch} mySide={mySide} readFrame={readFrame} />
      </Hud>

      <EventFeed items={inMatch ? feed : []} goal={inMatch ? goal : null} />

      {/*
        경기 중에는 계속 띄운다. 킥오프 카운트다운마다 사라졌다 나타나면 손이 헤맨다.
        입력 자체는 phase 에 따라 막혀 있으므로 눌려도 서버로 나가지 않는다.
      */}
      {touchUi && inMatch ? <TouchControls input={input} /> : null}

      {banner ? <p className="banner">{banner.text}</p> : null}
      {copied ? <p className="banner">{copied}</p> : null}

      {phase === "countdown" && countdownMs > 0 ? (
        <div className="countdown">
          <span className="countdown__number tnum">{Math.ceil(countdownMs / 1000)}</span>
        </div>
      ) : null}

      {phase === "waiting" ? (
        <div className="overlay">
          <div className="overlay__card">
            <p className="overlay__eyebrow">방 코드</p>
            <p className="code-display tnum">{joined.code}</p>
            <p className="overlay__body">
              상대가 들어오면 바로 킥오프합니다. 한 팀은 나 한 명과 AI 동료 {pitch.teamSize - 1}명
              입니다.
            </p>
            <div className="overlay__actions">
              <button className="btn" type="button" onClick={() => copy(joined.code, "코드를 복사했습니다.")}>
                코드 복사
              </button>
              <button
                className="btn btn--primary"
                type="button"
                onClick={() => copy(inviteLink, "초대 링크를 복사했습니다.")}
              >
                초대 링크 복사
              </button>
              <button className="btn btn--ghost" type="button" onClick={props.onLeave}>
                나가기
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {phase === "ended" ? (
        <div className="overlay">
          <div className="overlay__card overlay__card--wide">
            <p className="overlay__eyebrow">경기 종료</p>
            <h2 className="overlay__title">
              {result === "draw" ? "무승부" : result === mySide ? "승리" : "패배"}
            </h2>
            <p className="code-display tnum">
              {hud.scoreLeft} : {hud.scoreRight}
            </p>
            <StatCompare stats={hud.stats} leftName={leftName} rightName={rightName} />
            <p className="overlay__body">
              재경기는 양쪽이 모두 눌러야 시작합니다. ({rematchReady}/{humans} 준비)
            </p>
            <div className="overlay__actions">
              <button className="btn btn--primary" type="button" onClick={props.onRematch}>
                재경기
              </button>
              <button className="btn btn--ghost" type="button" onClick={props.onLeave}>
                나가기
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {link === "closed" ? (
        <div className="overlay">
          <div className="overlay__card">
            <p className="overlay__eyebrow">연결 끊김</p>
            <h2 className="overlay__title">서버와 연결이 끊겼습니다</h2>
            <p className="overlay__body">
              여러 번 다시 붙어 봤지만 실패했습니다. 로비로 돌아가 새로 시작해 주세요.
            </p>
            <div className="overlay__actions">
              <button className="btn btn--primary" type="button" onClick={props.onLeave}>
                로비로
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
