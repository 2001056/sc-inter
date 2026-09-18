/**
 * 경기 중 정보 표시.
 *
 * 값이 20Hz 로 바뀌므로 `MatchView` 가 10Hz 로 추려서 넘겨준다.
 * 여기서는 받은 것만 그린다.
 */
import type { LinkStatus } from "../net/connection.ts";
import type { PitchInfo, Side } from "../net/protocol.ts";

export interface HudSnapshot {
  scoreLeft: number;
  scoreRight: number;
  timeLeftMs: number;
  /** 0~1 */
  stamina: number;
  charge: number;
  /** 남은 쿨다운(ms) */
  skillCooldownMs: number;
  tackleCooldownMs: number;
  /** 지금 조작 중인 선수의 역할 이름. */
  controlledRole: string;
  hasBall: boolean;
}

interface Props {
  hud: HudSnapshot;
  pitch: PitchInfo;
  mySide: Side;
  leftName: string;
  rightName: string;
  link: LinkStatus;
  latency: number | null;
  onLeave(): void;
  onToggleCamera(): void;
  /** 미니맵처럼 HUD 아래줄 오른쪽에 붙일 것. */
  children?: React.ReactNode;
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function linkChip(link: LinkStatus, latency: number | null): { text: string; tone: string } {
  if (link === "open") {
    const text = latency === null ? "연결됨" : `${latency}ms`;
    const tone = latency !== null && latency > 160 ? "chip__dot--warn" : "";
    return { text, tone };
  }
  if (link === "reconnecting" || link === "connecting") {
    return { text: "다시 연결하는 중", tone: "chip__dot--warn" };
  }
  return { text: "연결 끊김", tone: "chip__dot--bad" };
}

/** 남은 쿨다운을 0~1 의 "준비됨" 비율로 바꾼다. */
function readiness(remainMs: number, totalMs: number): number {
  if (totalMs <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - remainMs / totalMs));
}

export function Hud(props: Props): React.ReactElement {
  const { hud, pitch, mySide, leftName, rightName, link, latency } = props;
  const chip = linkChip(link, latency);
  const urgent = hud.timeLeftMs <= 15_000;

  return (
    <div className="hud">
      <div className="hud__top">
        <div className="scoreboard interactive">
          <div className="scoreboard__team">
            <span className="scoreboard__dot" style={{ background: "var(--team-left)" }} />
            <span className="scoreboard__name">{leftName}</span>
          </div>
          <div className="scoreboard__center">
            <span className="scoreboard__score tnum">
              {hud.scoreLeft} : {hud.scoreRight}
            </span>
            <span className={`scoreboard__clock tnum${urgent ? " scoreboard__clock--urgent" : ""}`}>
              {clock(hud.timeLeftMs)}
            </span>
          </div>
          <div className="scoreboard__team scoreboard__team--right">
            <span className="scoreboard__name">{rightName}</span>
            <span className="scoreboard__dot" style={{ background: "var(--team-right)" }} />
          </div>
        </div>

        <div className="hud__corner">
          <span className="chip interactive">
            <span className={`chip__dot ${chip.tone}`} />
            {chip.text}
          </span>
          <button className="btn btn--ghost" type="button" onClick={props.onToggleCamera}>
            시점 (V)
          </button>
          <button className="btn btn--ghost" type="button" onClick={props.onLeave}>
            나가기
          </button>
        </div>
      </div>

      <div className="hud__bottom">
        <div className="gauges interactive">
          <div className="gauge">
            <span>체력</span>
            <span className="gauge__track">
              <span
                className="gauge__fill gauge__fill--stamina"
                style={{ width: `${Math.round(hud.stamina * 100)}%` }}
              />
            </span>
          </div>
          <div className="gauge">
            <span>슛 충전</span>
            <span className="gauge__track">
              <span className="gauge__fill" style={{ width: `${Math.round(hud.charge * 100)}%` }} />
            </span>
          </div>
          <div className="gauge">
            <span>개인기</span>
            <span className="gauge__track">
              <span
                className="gauge__fill gauge__fill--cooldown"
                style={{
                  width: `${Math.round(readiness(hud.skillCooldownMs, pitch.skillCooldownMs) * 100)}%`,
                }}
              />
            </span>
          </div>
          <div className="gauge">
            <span>태클</span>
            <span className="gauge__track">
              <span
                className="gauge__fill gauge__fill--cooldown"
                style={{
                  width: `${Math.round(readiness(hud.tackleCooldownMs, pitch.tackleCooldownMs) * 100)}%`,
                }}
              />
            </span>
          </div>
          <p className="hint" style={{ margin: 0 }}>
            조작 중: {hud.controlledRole}
            {hud.hasBall ? " · 공 소유" : ""} · 공격 방향 {mySide === "left" ? "오른쪽" : "왼쪽"}
          </p>
        </div>

        {props.children}
      </div>
    </div>
  );
}
