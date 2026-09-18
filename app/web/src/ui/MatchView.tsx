/**
 * 경기 화면.
 *
 * 세 가지 박자가 한 화면에서 돈다.
 *  - 60fps: 3D 렌더. `MatchScene` 이 스냅샷 버퍼를 직접 읽는다.
 *  - 30Hz: 입력 전송. 서버의 초당 60개 제한 안쪽이다.
 *  - 10Hz: HUD 갱신. 사람 눈에는 충분하고 React 재렌더를 아낀다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BannerMessage } from "../App.tsx";
import { InputController } from "../game/input.ts";
import { emptyFrame, type MatchFrame } from "../game/interpolation.ts";
import type { SnapshotBuffer } from "../game/interpolation.ts";
import type { Connection, LinkStatus } from "../net/connection.ts";
import { ROLE_LABEL, type JoinedMessage, type RoomMessage, type Side } from "../net/protocol.ts";
import { MatchScene, type CameraMode } from "../three/scene.ts";
import { Hud, type HudSnapshot } from "./Hud.tsx";
import { Minimap } from "./Minimap.tsx";
import { TouchControls } from "./TouchControls.tsx";

const INPUT_HZ = 30;
const HUD_HZ = 10;

interface Props {
  connection: Connection;
  buffer: SnapshotBuffer;
  joined: JoinedMessage;
  room: RoomMessage | null;
  link: LinkStatus;
  latency: number | null;
  banner: BannerMessage | null;
  goalFlash: { id: number; side: Side } | null;
  myNickname: string;
  onLeave(): void;
  onRematch(): void;
}

const EMPTY_HUD: HudSnapshot = {
  scoreLeft: 0,
  scoreRight: 0,
  timeLeftMs: 0,
  stamina: 1,
  charge: 0,
  skillCooldownMs: 0,
  tackleCooldownMs: 0,
  controlledRole: "미드필더",
  hasBall: false,
};

/** 터치가 되는 기기인지. 마우스가 함께 달린 기기에서는 터치 UI 를 띄우지 않는다. */
function isTouchPrimary(): boolean {
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

export function MatchView(props: Props): React.ReactElement {
  const { connection, buffer, joined, room, link, latency, banner, goalFlash } = props;
  const pitch = joined.pitch;
  const mySide = joined.side;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sceneRef = useRef<MatchScene | null>(null);
  const frameRef = useRef<MatchFrame>(emptyFrame());
  const cameraModeRef = useRef<CameraMode>("follow");

  const input = useMemo(() => new InputController(), []);
  const [hud, setHud] = useState<HudSnapshot>(EMPTY_HUD);
  const [phase, setPhase] = useState(room?.phase ?? "waiting");
  const [countdownMs, setCountdownMs] = useState(0);
  const [touchUi] = useState(isTouchPrimary);
  const [copied, setCopied] = useState<string | null>(null);

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

  // 공격 방향이 정해져야 방향키를 월드 좌표로 바꿀 수 있다.
  useEffect(() => {
    input.setAttackDir(mySide === "left" ? 1 : -1);
  }, [input, mySide]);

  useEffect(() => {
    const detach = input.attach();
    input.onCameraToggle(() => {
      cameraModeRef.current = cameraModeRef.current === "follow" ? "broadcast" : "follow";
    });
    return () => {
      detach();
      input.onCameraToggle(null);
      input.setEnabled(false);
    };
  }, [input]);

  // 카운트다운·종료 중에는 입력을 서버가 무시하므로 화면도 받지 않는다.
  useEffect(() => {
    input.setEnabled(phase === "playing");
  }, [input, phase]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let scene: MatchScene;
    try {
      scene = new MatchScene(canvas, pitch);
    } catch {
      return;
    }
    sceneRef.current = scene;

    let raf = 0;
    let last = performance.now();
    let inputAccum = 0;
    let hudAccum = 0;

    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;

      const sampled = buffer.sample(dt * 1000);
      if (sampled) frameRef.current = sampled;
      const frame = frameRef.current;

      if (frame.ready) {
        scene.render(frame, {
          mySide,
          cameraMode: cameraModeRef.current,
          nicknames: nicknamesRef.current,
        }, dt);
      }

      inputAccum += dt;
      if (inputAccum >= 1 / INPUT_HZ) {
        inputAccum = 0;
        connection.sendInput(input.poll());
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
        });
        setPhase(frame.phase);
        setCountdownMs(frame.countdownMs);
      }

      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onResize = () => scene.resize();
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      scene.dispose();
      sceneRef.current = null;
    };
  }, [buffer, connection, input, mySide, pitch]);

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

  const result = room?.result ?? null;
  const rematchReady = room?.players.filter((p) => !p.bot && p.rematchReady).length ?? 0;
  const humans = room?.players.filter((p) => !p.bot).length ?? 1;

  return (
    <div className="match">
      <canvas className="match__canvas" ref={canvasRef} />

      <Hud
        hud={hud}
        pitch={pitch}
        mySide={mySide}
        leftName={leftName}
        rightName={rightName}
        link={link}
        latency={latency}
        onLeave={props.onLeave}
        onToggleCamera={toggleCamera}
      >
        <Minimap pitch={pitch} mySide={mySide} readFrame={readFrame} />
      </Hud>

      {touchUi && phase === "playing" ? <TouchControls input={input} /> : null}

      {banner ? <p className="banner">{banner.text}</p> : null}
      {copied ? <p className="banner">{copied}</p> : null}

      {phase === "countdown" && countdownMs > 0 ? (
        <div className="countdown">
          <span className="countdown__number tnum">{Math.ceil(countdownMs / 1000)}</span>
        </div>
      ) : null}

      {goalFlash ? (
        <div className="goal-flash">
          <span className="goal-flash__text">GOAL</span>
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
          <div className="overlay__card">
            <p className="overlay__eyebrow">경기 종료</p>
            <h2 className="overlay__title">
              {result === "draw" ? "무승부" : result === mySide ? "승리" : "패배"}
            </h2>
            <p className="code-display tnum">
              {hud.scoreLeft} : {hud.scoreRight}
            </p>
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
