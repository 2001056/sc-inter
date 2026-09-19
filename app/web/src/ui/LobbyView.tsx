/**
 * 로비.
 *
 * 왼쪽은 경기 화면과 똑같은 3D 선수가 큼직하게 도는 무대이고, 오른쪽이 실제 조작이다.
 * 들어오자마자 "이 게임의 선수는 이렇게 생겼고 이런 개인기를 쓴다" 가 먼저 보이게 했다.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CONTROL_HELP } from "../game/input.ts";
import type { AnimState } from "../net/protocol.ts";
import { PlayerPreview } from "../three/preview.ts";
import { readGraphicsQuality, writeGraphicsQuality, type GraphicsQuality } from "../three/quality.ts";
import { cleanNickname } from "../App.tsx";
import { QualityPicker } from "./QualityPicker.tsx";

const ANIM_CAPTION: Partial<Record<AnimState, string>> = {
  idle: "대기",
  run: "드리블 런",
  sprint: "전력 질주",
  stepover: "스텝오버",
  feintLeft: "왼쪽 바디페인트",
  feintRight: "오른쪽 바디페인트",
  dragback: "드래그백",
  shoot: "충전 슛",
  celebrate: "골 세리머니",
};

interface Props {
  nickname: string;
  inviteCode: string;
  connecting: boolean;
  error: string | null;
  pitchHeight: number;
  onNicknameChange(value: string): void;
  onCreate(nickname: string): void;
  onJoin(nickname: string, code: string): void;
  onPractice(nickname: string): void;
}

export function LobbyView(props: Props): React.ReactElement {
  const { nickname, inviteCode, connecting, error, pitchHeight } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewRef = useRef<PlayerPreview | null>(null);
  const [caption, setCaption] = useState<AnimState>("idle");
  const [code, setCode] = useState(inviteCode);
  const [formError, setFormError] = useState<string | null>(null);
  const [quality, setQuality] = useState<GraphicsQuality>(() => readGraphicsQuality());
  const qualityRef = useRef(quality);
  qualityRef.current = quality;

  // 프리뷰는 한 번만 만들고 rAF 로 돌린다. 닉네임이 바뀌면 유니폼만 다시 뽑는다.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let preview: PlayerPreview;
    try {
      preview = new PlayerPreview(canvas, "left", nickname, pitchHeight, qualityRef.current);
    } catch {
      // WebGL 컨텍스트를 못 만드는 환경은 App 이 따로 안내하므로 조용히 넘어간다.
      return;
    }
    previewRef.current = preview;

    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      preview.update(dt);
      setCaption((current) => (current === preview.currentAnim ? current : preview.currentAnim));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onResize = () => preview.resize();
    window.addEventListener("resize", onResize);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      preview.dispose();
      previewRef.current = null;
    };
    // 최초 1회만 만든다. 닉네임 반영은 아래 effect 가 맡는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pitchHeight]);

  // 닉네임을 바꾸면 등번호와 피부·머리색이 따라 바뀐다. 자주 부르지 않도록 늦춘다.
  useEffect(() => {
    const timer = window.setTimeout(() => previewRef.current?.restyle("left", nickname), 350);
    return () => window.clearTimeout(timer);
  }, [nickname]);

  const changeQuality = (value: GraphicsQuality) => {
    writeGraphicsQuality(value);
    setQuality(value);
    previewRef.current?.setQuality(value);
  };

  const submit = (event: FormEvent, action: "create" | "join" | "practice") => {
    event.preventDefault();
    const name = cleanNickname(nickname);
    if (name.length < 1) {
      setFormError("닉네임을 1자 이상 적어 주세요.");
      return;
    }
    if (action === "join") {
      const normalized = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (normalized.length !== 6) {
        setFormError("방 코드는 영문·숫자 6자입니다.");
        return;
      }
      setFormError(null);
      props.onJoin(name, normalized);
      return;
    }
    setFormError(null);
    if (action === "create") props.onCreate(name);
    else props.onPractice(name);
  };

  return (
    <div className="lobby">
      <section className="lobby__stage">
        <canvas className="lobby__canvas" ref={canvasRef} aria-hidden="true" />
        <div className="lobby__stage-glow" />
        <header className="lobby__brand">
          <h1 className="lobby__wordmark">
            SC <span>INTER</span>
          </h1>
          <p className="lobby__tagline">
            브라우저만 있으면 되는 3대3 온라인 축구. 당신이 한 명을 맡고 AI 동료 두 명이 함께
            뜁니다.
          </p>
        </header>
        <div className="lobby__caption">
          <strong>{ANIM_CAPTION[caption] ?? "대기"}</strong>
          <span>실제 경기에 쓰이는 선수 모델</span>
        </div>
      </section>

      <section className="lobby__panel">
        {error ? <p className="notice">{error}</p> : null}
        {formError ? <p className="notice">{formError}</p> : null}

        <div className="panel-card">
          <h2 className="panel-card__title">경기 시작</h2>
          <form className="start-grid" onSubmit={(event) => submit(event, "create")}>
            <label className="field">
              <span className="field__label">닉네임 (1~12자)</span>
              <input
                className="input"
                value={nickname}
                maxLength={12}
                placeholder="예: 이병찬"
                autoComplete="nickname"
                onChange={(event) => props.onNicknameChange(event.target.value)}
              />
            </label>

            <button className="btn btn--primary btn--block" type="submit" disabled={connecting}>
              {connecting ? "연결하는 중…" : "방 만들기"}
            </button>

            <div className="join-row">
              <input
                className="input input--code"
                value={code}
                maxLength={6}
                placeholder="방 코드"
                aria-label="방 코드"
                onChange={(event) => setCode(event.target.value.toUpperCase())}
              />
              <button
                className="btn"
                type="button"
                disabled={connecting}
                onClick={(event) => submit(event, "join")}
              >
                코드로 참가
              </button>
            </div>

            <button
              className="btn btn--ghost btn--block"
              type="button"
              disabled={connecting}
              onClick={(event) => submit(event, "practice")}
            >
              혼자 연습하기
            </button>
          </form>
          {inviteCode ? (
            <p className="hint">초대 링크로 들어왔습니다. 코드 {inviteCode} 가 채워져 있습니다.</p>
          ) : (
            <p className="hint">방을 만들면 6자리 코드와 초대 링크가 나옵니다.</p>
          )}
        </div>

        <div className="panel-card">
          <h2 className="panel-card__title">그래픽</h2>
          <QualityPicker value={quality} onChange={changeQuality} />
          <p className="hint">
            자동은 기기에 맞춰 조절합니다. 화면이 끊기면 성능을 고르세요. 경기 중에도 설정에서
            바꿀 수 있습니다.
          </p>
        </div>

        <div className="panel-card">
          <h2 className="panel-card__title">조작</h2>
          <dl className="control-table">
            {CONTROL_HELP.map((row) => (
              <div key={row.action} style={{ display: "contents" }}>
                <dt>
                  {row.keys.split(" ").map((key) => (
                    <kbd className="keycap" key={key}>
                      {key}
                    </kbd>
                  ))}
                </dt>
                <dd>{row.action}</dd>
              </div>
            ))}
          </dl>
          <p className="hint">
            휴대폰에서는 왼쪽 조이스틱과 오른쪽 버튼으로 같은 동작을 할 수 있습니다.
          </p>
        </div>
      </section>
    </div>
  );
}
