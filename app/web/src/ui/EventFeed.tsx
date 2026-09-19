/**
 * 경기 알림(슛·패스·개인기·킥오프)과 득점 연출.
 *
 * 경기장을 가리지 않는 것이 첫째다. 알림은 왼쪽 가장자리에 작은 띠로 최대 세 줄,
 * 득점은 화면 위쪽 3분의 1 에 중계 자막처럼 잠깐 띄운다. 둘 다 클릭을 가로채지 않는다.
 * 움직임 줄이기를 켠 사용자에게는 들어오는 움직임 없이 바로 나타난다(styles.css).
 */
import type { FeedItem, GoalCallout } from "../game/feedback.ts";

interface Props {
  items: readonly FeedItem[];
  goal: GoalCallout | null;
}

export function EventFeed({ items, goal }: Props): React.ReactElement {
  return (
    <>
      <ol className="feed" aria-live="polite" aria-label="경기 알림">
        {items.map((item) => (
          <li
            key={item.id}
            className={`feed__item feed__item--${item.tone}${item.mine ? " feed__item--mine" : ""}`}
            data-side={item.side ?? "none"}
          >
            <span className="feed__title">{item.title}</span>
            <span className="feed__detail">{item.detail}</span>
          </li>
        ))}
      </ol>

      {/* 화면 읽기 프로그램용 득점 알림. 늘 붙어 있어야 내용이 바뀔 때 읽힌다. */}
      <p className="sr-only" role="status">
        {goal
          ? `${goal.teamName} 득점, ${goal.scorer}, ${goal.score.left} 대 ${goal.score.right}`
          : ""}
      </p>

      {goal ? (
        <div className="goal-callout" key={goal.id} data-side={goal.side} aria-hidden="true">
          <span className="goal-callout__eyebrow">{goal.mine ? "우리 팀 득점" : "실점"}</span>
          <span className="goal-callout__word">GOAL</span>
          <span className="goal-callout__line">
            <span className="goal-callout__team">{goal.teamName}</span>
            <span className="goal-callout__scorer">{goal.scorer}</span>
            <span className="goal-callout__score tnum">
              {goal.score.left} : {goal.score.right}
            </span>
          </span>
        </div>
      ) : null}
    </>
  );
}
