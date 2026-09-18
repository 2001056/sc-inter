/**
 * 전체 미니맵.
 *
 * 3/4 시점은 선수를 크게 보여 주는 대신 시야가 좁다. 여섯 명과 공이 지금 어디
 * 있는지는 이 작은 지도가 대신 알려 준다. React 로 점을 그리면 20Hz 로
 * 다시 그려야 하므로 캔버스에 직접 찍는다.
 */
import { useEffect, useRef } from "react";
import type { MatchFrame } from "../game/interpolation.ts";
import type { PitchInfo, Side } from "../net/protocol.ts";

interface Props {
  pitch: PitchInfo;
  mySide: Side;
  /** 최신 프레임을 돌려주는 함수. 렌더 루프와 같은 자료를 본다. */
  readFrame(): MatchFrame | null;
}

export function Minimap({ pitch, mySide, readFrame }: Props): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const draw = () => {
      const dpr = Math.min(window.devicePixelRatio, 2);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
        canvas.width = w * dpr;
        canvas.height = h * dpr;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // 내가 오른쪽 팀이면 지도를 뒤집어, 내 공격 방향이 늘 화면 오른쪽이 되게 한다.
      const flip = mySide === "right";
      const toX = (x: number) => (flip ? w - (x / pitch.length) * w : (x / pitch.length) * w);
      const toY = (y: number) => (flip ? h - (y / pitch.width) * h : (y / pitch.width) * h);

      ctx.fillStyle = "rgba(24, 58, 38, 0.85)";
      ctx.fillRect(0, 0, w, h);

      ctx.strokeStyle = "rgba(235, 245, 238, 0.35)";
      ctx.lineWidth = 1;
      ctx.strokeRect(1, 1, w - 2, h - 2);
      ctx.beginPath();
      ctx.moveTo(w / 2, 0);
      ctx.lineTo(w / 2, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, h * 0.16, 0, Math.PI * 2);
      ctx.stroke();

      // 내가 공격하는 골대 쪽을 밝게 표시한다.
      ctx.fillStyle = "rgba(182, 255, 58, 0.22)";
      ctx.fillRect(w - 5, h * 0.33, 5, h * 0.34);
      ctx.fillStyle = "rgba(255, 255, 255, 0.14)";
      ctx.fillRect(0, h * 0.33, 5, h * 0.34);

      const frame = readFrame();
      if (frame?.ready) {
        const controlled = frame.controlled[mySide];
        const passTarget = frame.passTarget[mySide];
        for (const player of frame.players) {
          const px = toX(player.x);
          const py = toY(player.y);
          const mine = player.side === mySide;
          ctx.beginPath();
          ctx.arc(px, py, player.id === controlled ? 4.4 : 3.2, 0, Math.PI * 2);
          ctx.fillStyle =
            player.id === controlled
              ? "#b6ff3a"
              : player.id === passTarget
                ? "#ffd24a"
                : mine
                  ? "#5b8cff"
                  : "#ff6b6b";
          ctx.fill();
        }
        ctx.beginPath();
        ctx.arc(toX(frame.ball.x), toY(frame.ball.y), 2.4, 0, Math.PI * 2);
        ctx.fillStyle = "#f7f8fa";
        ctx.fill();
      }

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [pitch, mySide, readFrame]);

  return (
    <div
      className="minimap interactive"
      style={{ aspectRatio: `${pitch.length} / ${pitch.width}` }}
    >
      <canvas className="minimap__canvas" ref={canvasRef} aria-label="경기장 전체 지도" />
    </div>
  );
}
