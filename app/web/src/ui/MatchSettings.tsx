/**
 * 경기 중 설정 패널: 소리 켜기/끄기 · 음량 · 그래픽 품질.
 *
 * 모달이 아니다. 오른쪽 위 버튼 아래에 붙는 작은 판이고 경기는 그대로 돈다.
 * 소리 켜기는 이 클릭 자체가 사용자 동작이라 그 자리에서 오디오를 깨운다.
 */
import type { AudioSettings } from "../game/audio.ts";
import type { GraphicsQuality } from "../three/quality.ts";
import { QualityPicker } from "./QualityPicker.tsx";

interface Props {
  audio: AudioSettings;
  quality: GraphicsQuality;
  onToggleSound(): void;
  onVolume(volume: number): void;
  onQuality(value: GraphicsQuality): void;
  onClose(): void;
}

export function MatchSettings(props: Props): React.ReactElement {
  const { audio, quality } = props;
  return (
    <div className="settings interactive" role="group" aria-label="경기 설정">
      <div className="settings__row">
        <span className="settings__label">효과음</span>
        <button
          type="button"
          className={audio.enabled ? "toggle toggle--on" : "toggle"}
          aria-pressed={audio.enabled}
          onClick={props.onToggleSound}
        >
          {audio.enabled ? "켜짐" : "꺼짐"}
        </button>
      </div>
      <label className="settings__row">
        <span className="settings__label">음량</span>
        <input
          className="range"
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(audio.volume * 100)}
          disabled={!audio.enabled}
          onChange={(event) => props.onVolume(Number(event.target.value) / 100)}
          // 슬라이더에 포커스가 남으면 방향키가 선수 대신 슬라이더를 움직인다.
          onPointerUp={(event) => event.currentTarget.blur()}
          aria-valuetext={`${Math.round(audio.volume * 100)}%`}
        />
        <span className="settings__value tnum">{Math.round(audio.volume * 100)}</span>
      </label>
      <div className="settings__row settings__row--stack">
        <span className="settings__label">그래픽</span>
        <QualityPicker value={quality} onChange={props.onQuality} />
      </div>
      <button type="button" className="btn btn--ghost btn--small" onClick={props.onClose}>
        닫기
      </button>
    </div>
  );
}
