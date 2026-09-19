/**
 * 그래픽 품질 선택(자동 / 고화질 / 성능).
 *
 * 저장과 실제 적용은 렌더 쪽(`three/quality.ts`, `MatchScene.setQuality`,
 * `PlayerPreview.setQuality`)이 맡는다. 여기는 고르는 버튼만 그린다.
 * 라디오 입력 대신 버튼을 쓴 이유: 입력 칸에 포커스가 남으면 방향키가
 * 게임으로 가지 않는다(`InputController.isTyping`).
 */
import type { GraphicsQuality } from "../three/quality.ts";

const OPTIONS: { value: GraphicsQuality; label: string; hint: string }[] = [
  { value: "auto", label: "자동", hint: "기기에 맞춰 조절" },
  { value: "high", label: "고화질", hint: "화질 우선" },
  { value: "low", label: "성능", hint: "프레임 우선" },
];

interface Props {
  value: GraphicsQuality;
  onChange(value: GraphicsQuality): void;
}

export function QualityPicker({ value, onChange }: Props): React.ReactElement {
  return (
    <div className="segmented" role="group" aria-label="그래픽 품질">
      {OPTIONS.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? "segmented__opt segmented__opt--on" : "segmented__opt"}
          aria-pressed={option.value === value}
          title={option.hint}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
