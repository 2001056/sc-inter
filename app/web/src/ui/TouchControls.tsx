/**
 * 휴대폰용 조작.
 *
 * 키보드와 같은 동작을 그대로 낸다. 왼쪽 조이스틱이 방향키, 오른쪽 버튼이
 * 패스·슛·달리기·태클, 그 위 십자 패드가 개인기(Shift+방향) 자리다.
 * 입력은 React 상태를 거치지 않고 `InputController` 로 곧장 들어가므로
 * 손가락을 움직여도 컴포넌트가 다시 그려지지 않는다.
 */
import { useEffect, useRef } from "react";
import type { InputController } from "../game/input.ts";

interface Props {
  input: InputController;
}

const SKILL_PAD: { dir: "up" | "left" | "right" | "down"; label: string; column: number; row: number }[] =
  [
    { dir: "up", label: "스텝", column: 2, row: 1 },
    { dir: "left", label: "페인트←", column: 1, row: 2 },
    { dir: "right", label: "페인트→", column: 3, row: 2 },
    { dir: "down", label: "드래그", column: 2, row: 2 },
  ];

export function TouchControls({ input }: Props): React.ReactElement {
  const stickRef = useRef<HTMLDivElement | null>(null);
  const knobRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const stick = stickRef.current;
    const knob = knobRef.current;
    if (!stick || !knob) return;

    let pointerId: number | null = null;

    const update = (event: PointerEvent) => {
      const rect = stick.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const radius = rect.width / 2;
      let dx = (event.clientX - cx) / radius;
      // 화면 위쪽이 +1 이 되도록 부호를 뒤집는다.
      let dy = -(event.clientY - cy) / radius;
      const len = Math.hypot(dx, dy);
      if (len > 1) {
        dx /= len;
        dy /= len;
      }
      input.setStick(dx, dy);
      knob.style.transform = `translate(${dx * radius * 0.52}px, ${-dy * radius * 0.52}px)`;
    };

    const onDown = (event: PointerEvent) => {
      if (pointerId !== null) return;
      pointerId = event.pointerId;
      stick.setPointerCapture(event.pointerId);
      update(event);
    };
    const onMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      update(event);
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      input.setStick(0, 0);
      knob.style.transform = "translate(0px, 0px)";
    };

    stick.addEventListener("pointerdown", onDown);
    stick.addEventListener("pointermove", onMove);
    stick.addEventListener("pointerup", onUp);
    stick.addEventListener("pointercancel", onUp);
    return () => {
      stick.removeEventListener("pointerdown", onDown);
      stick.removeEventListener("pointermove", onMove);
      stick.removeEventListener("pointerup", onUp);
      stick.removeEventListener("pointercancel", onUp);
    };
  }, [input]);

  const holdProps = (action: "shoot" | "sprint") => ({
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      input.setTouchHold(action, true);
    },
    onPointerUp: () => input.setTouchHold(action, false),
    onPointerCancel: () => input.setTouchHold(action, false),
  });

  return (
    <div className="touch">
      <div className="touch__stick" ref={stickRef} aria-label="이동 조이스틱">
        <div className="touch__knob" ref={knobRef} />
      </div>

      <div className="touch__skills" aria-label="개인기">
        {SKILL_PAD.map((skill) => (
          <button
            key={skill.dir}
            className="touch__skill"
            type="button"
            style={{ gridColumn: skill.column, gridRow: skill.row }}
            onPointerDown={() => input.triggerSkill(skill.dir)}
          >
            {skill.label}
          </button>
        ))}
      </div>

      <div className="touch__actions">
        <button className="touch__btn" type="button" onPointerDown={() => input.triggerPass()}>
          패스
        </button>
        <button className="touch__btn touch__btn--shoot" type="button" {...holdProps("shoot")}>
          슛
        </button>
        <button className="touch__btn" type="button" onPointerDown={() => input.triggerTackle()}>
          태클
        </button>
        <button className="touch__btn" type="button" {...holdProps("sprint")}>
          달리기
        </button>
      </div>
    </div>
  );
}
