/**
 * 두 팀 기록 비교(슛 · 패스 성공 · 점유율).
 *
 * 경기 중 `기록` 패널과 종료 화면이 같은 컴포넌트를 쓴다. 숫자 계산과 0 나누기
 * 처리는 `feedback.ts` 의 `statRows` 가 맡고 여기서는 그리기만 한다.
 */
import { statRows } from "../game/feedback.ts";
import type { MatchStats } from "../net/protocol.ts";

interface Props {
  stats: MatchStats | null;
  leftName: string;
  rightName: string;
  compact?: boolean;
}

export function StatCompare({ stats, leftName, rightName, compact = false }: Props): React.ReactElement {
  const rows = statRows(stats);
  if (rows.length === 0) {
    return <p className="stats__empty">이 서버는 경기 기록을 보내지 않습니다.</p>;
  }
  return (
    <div className={compact ? "stats stats--compact" : "stats"}>
      <div className="stats__head">
        <span className="stats__team stats__team--left">{leftName}</span>
        <span className="stats__team stats__team--right">{rightName}</span>
      </div>
      {rows.map((row) => (
        <div className="stats__row" key={row.key}>
          <span className="stats__value tnum">{row.left}</span>
          <span className="stats__label">{row.label}</span>
          <span className="stats__value stats__value--right tnum">{row.right}</span>
          <span className="stats__bar" aria-hidden="true">
            {row.leftShare === null ? (
              <span className="stats__bar-empty" />
            ) : (
              <>
                <span className="stats__bar-left" style={{ flexGrow: row.leftShare }} />
                <span className="stats__bar-right" style={{ flexGrow: 1 - row.leftShare }} />
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
