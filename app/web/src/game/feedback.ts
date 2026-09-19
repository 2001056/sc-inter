/**
 * 경기 중 일어난 일을 사람이 읽는 짧은 알림과 효과음 이름으로 바꾼다.
 *
 * React 도 Web Audio 도 모르는 순수 로직만 둔다. 화면(`MatchView`)은 여기서 나온
 * 알림을 그리고, 소리(`audio.ts`)는 여기서 고른 효과음 이름을 낸다.
 *
 * 서버 이벤트는 `App` 의 연결 콜백에서 들어오지만 알림을 그리는 곳은 `MatchView` 다.
 * 둘을 React 상태로 잇지 않고 `MatchEventHub` 로 잇는다. 이벤트가 몰려도 App 이
 * 다시 그려지지 않고, 경기 화면이 없을 때 온 이벤트는 그냥 흘려보낸다.
 */
import {
  ROLE_LABEL,
  SKILL_LABEL,
  type MatchStats,
  type Role,
  type Score,
  type ServerEvent,
  type Side,
} from "../net/protocol.ts";

/** 경기 화면이 관심 있는 이벤트. 입장·이탈 같은 방 알림은 App 의 배너가 맡는다. */
export type MatchEvent = Extract<
  ServerEvent,
  { kind: "goal" | "kickoff" | "matchEnd" | "shoot" | "pass" | "skill" }
>;

const MATCH_KINDS = new Set<ServerEvent["kind"]>([
  "goal",
  "kickoff",
  "matchEnd",
  "shoot",
  "pass",
  "skill",
]);

export function isMatchEvent(event: ServerEvent): event is MatchEvent {
  return MATCH_KINDS.has(event.kind);
}

/** App → MatchView 로 경기 이벤트를 넘기는 얇은 통로. */
export class MatchEventHub {
  private readonly listeners = new Set<(event: MatchEvent) => void>();

  emit(event: MatchEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: MatchEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

// ---------- 알림 ----------

export type FeedTone = "shot" | "pass" | "skill" | "tackle" | "kickoff";

export interface FeedItem {
  id: number;
  tone: FeedTone;
  /** 알림 왼쪽 띠 색. 킥오프처럼 팀이 없는 알림은 null. */
  side: Side | null;
  /** 내 팀 일인지. 내 쪽 일은 조금 더 또렷하게 그린다. */
  mine: boolean;
  title: string;
  detail: string;
  bornAt: number;
}

/** 이벤트의 선수 id 를 화면에 쓸 이름으로 바꿔 주는 함수. 모르면 null. */
export interface PlayerInfo {
  side: Side;
  role: Role;
  /** 지금 사람이 조작 중인 선수인지. 그렇다면 역할 대신 닉네임을 쓴다. */
  controlled: boolean;
}

export interface DescribeContext {
  mySide: Side;
  nicknames: Record<Side, string>;
  lookup(playerId: string): PlayerInfo | null;
}

/** 선수 id 앞 글자로 팀을 안다(`L1` / `R3`). 스냅샷에 아직 없을 때의 대비책. */
function sideFromId(playerId: string): Side | null {
  if (playerId.startsWith("L")) return "left";
  if (playerId.startsWith("R")) return "right";
  return null;
}

function playerLabel(playerId: string, ctx: DescribeContext): { side: Side | null; text: string } {
  const info = ctx.lookup(playerId);
  if (!info) return { side: sideFromId(playerId), text: "선수" };
  if (info.controlled) return { side: info.side, text: ctx.nicknames[info.side] };
  return { side: info.side, text: ROLE_LABEL[info.role] };
}

/** m/s 를 중계 화면처럼 시속으로. */
export function kmh(metersPerSecond: number): number {
  return Math.round(Math.max(0, metersPerSecond) * 3.6);
}

/**
 * 이벤트 하나를 알림 한 줄로 바꾼다. 알림으로 띄울 가치가 없으면 null.
 *
 * - 슛은 누가 찼든 띄운다. 경기의 가장 큰 순간이다.
 * - 패스는 내 팀 것만 띄운다. AI 여섯 명의 패스를 다 띄우면 알림이 쉬지 않는다.
 * - 개인기는 상대를 제쳤거나 사람이 직접 쓴 것만 띄운다.
 * - 득점·종료는 알림이 아니라 따로 크게 알린다(`goalCallout`, 종료 화면).
 */
export function describeEvent(
  event: MatchEvent,
  ctx: DescribeContext,
): Omit<FeedItem, "id" | "bornAt"> | null {
  switch (event.kind) {
    case "shoot": {
      const who = playerLabel(event.playerId, ctx);
      return {
        tone: "shot",
        side: who.side,
        mine: who.side === ctx.mySide,
        title: "슛",
        detail: `${who.text} · 시속 ${kmh(event.power)}km`,
      };
    }
    case "pass": {
      const who = playerLabel(event.playerId, ctx);
      if (who.side !== ctx.mySide) return null;
      const target = event.targetId ? playerLabel(event.targetId, ctx).text : "빈 공간";
      return {
        tone: "pass",
        side: who.side,
        mine: true,
        title: "패스",
        detail: `${who.text} → ${target}`,
      };
    }
    case "skill": {
      const info = ctx.lookup(event.playerId);
      const who = playerLabel(event.playerId, ctx);
      if (event.skill === "tackle") {
        if (!info?.controlled) return null;
        return {
          tone: "tackle",
          side: who.side,
          mine: who.side === ctx.mySide,
          title: "태클",
          detail: who.text,
        };
      }
      if (!event.beat && !info?.controlled) return null;
      return {
        tone: "skill",
        side: who.side,
        mine: who.side === ctx.mySide,
        title: SKILL_LABEL[event.skill],
        detail: event.beat ? `${who.text} · 상대를 제쳤다` : who.text,
      };
    }
    case "kickoff":
      return { tone: "kickoff", side: null, mine: false, title: "킥오프", detail: "휘슬이 울렸다" };
    default:
      return null;
  }
}

/** 한 번에 보이는 알림 수. 경기장을 덮지 않으려고 적게 둔다. */
export const FEED_MAX = 3;
/** 알림이 떠 있는 시간. */
export const FEED_TTL_MS = 2600;
/** 같은 문장이 이 시간 안에 또 오면 하나로 친다(연속 태클 버튼 등). */
const FEED_DEDUPE_MS = 500;

/** 알림 목록. 시간은 밖에서 넣어 주므로 테스트에서 시계를 흉내 낼 수 있다. */
export class FeedQueue {
  private items: FeedItem[] = [];
  private seq = 0;

  push(entry: Omit<FeedItem, "id" | "bornAt">, now: number): boolean {
    const last = this.items[this.items.length - 1];
    if (
      last &&
      last.title === entry.title &&
      last.detail === entry.detail &&
      now - last.bornAt < FEED_DEDUPE_MS
    ) {
      return false;
    }
    this.seq += 1;
    this.items.push({ ...entry, id: this.seq, bornAt: now });
    if (this.items.length > FEED_MAX) this.items.splice(0, this.items.length - FEED_MAX);
    return true;
  }

  /** 오래된 알림을 지운다. 목록이 바뀌었으면 true. */
  prune(now: number): boolean {
    const before = this.items.length;
    this.items = this.items.filter((item) => now - item.bornAt < FEED_TTL_MS);
    return this.items.length !== before;
  }

  clear(): boolean {
    const had = this.items.length > 0;
    this.items = [];
    return had;
  }

  list(): readonly FeedItem[] {
    return this.items;
  }
}

// ---------- 득점 연출 ----------

export interface GoalCallout {
  id: number;
  side: Side;
  mine: boolean;
  teamName: string;
  scorer: string;
  score: Score;
}

export const GOAL_CALLOUT_MS = 2600;

export function goalCallout(
  event: Extract<MatchEvent, { kind: "goal" }>,
  ctx: DescribeContext,
  id: number,
): GoalCallout {
  const scorer = playerLabel(event.scorerId, ctx);
  // 자책골이면 득점자 팀과 득점한 팀이 다르다. 그때는 이름 대신 사실만 적는다.
  const ownGoal = scorer.side !== null && scorer.side !== event.side;
  return {
    id,
    side: event.side,
    mine: event.side === ctx.mySide,
    teamName: ctx.nicknames[event.side],
    scorer: ownGoal ? "자책골" : scorer.text,
    score: event.score,
  };
}

// ---------- 효과음 ----------

export type SoundCue =
  | { kind: "kick"; strength: number }
  | { kind: "pass" }
  | { kind: "whistle" }
  | { kind: "finalWhistle" }
  | { kind: "goal" };

/** 이벤트에 맞는 효과음. 개인기는 발소리보다 눈으로 보는 게 낫다고 보고 소리를 붙이지 않는다. */
export function soundFor(event: MatchEvent): SoundCue | null {
  switch (event.kind) {
    case "shoot":
      // 서버 슛 속도는 대략 11~27m/s. 범위를 하드코딩하지 않고 부드럽게 눌러 담는다.
      return { kind: "kick", strength: Math.max(0.2, Math.min(1, event.power / 28)) };
    case "pass":
      return { kind: "pass" };
    case "kickoff":
      return { kind: "whistle" };
    case "matchEnd":
      return { kind: "finalWhistle" };
    case "goal":
      return { kind: "goal" };
    default:
      return null;
  }
}

// ---------- 경기 기록 ----------

export interface StatRow {
  key: "shots" | "passes" | "possession";
  label: string;
  left: string;
  right: string;
  /** 막대 그래프용 왼쪽 비율 0~1. 비교할 값이 없으면 null(막대를 그리지 않는다). */
  leftShare: number | null;
}

function share(left: number, right: number): number | null {
  const total = left + right;
  if (!(total > 0)) return null;
  return left / total;
}

function percent(part: number, whole: number): string {
  if (!(whole > 0)) return "–";
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * 두 팀 기록을 비교 표 세 줄로 만든다. 분모가 0 이면 비율 대신 "–" 를 쓴다.
 * 기록이 아예 없으면(구버전 서버) 빈 배열.
 */
export function statRows(stats: MatchStats | null): StatRow[] {
  if (!stats) return [];
  const { left, right } = stats;
  const possession = share(left.possessionMs, right.possessionMs);
  return [
    {
      key: "shots",
      label: "슛",
      left: String(left.shots),
      right: String(right.shots),
      leftShare: share(left.shots, right.shots),
    },
    {
      key: "passes",
      label: "패스 성공",
      left: `${left.completedPasses}/${left.passes} · ${percent(left.completedPasses, left.passes)}`,
      right: `${right.completedPasses}/${right.passes} · ${percent(right.completedPasses, right.passes)}`,
      leftShare: share(left.completedPasses, right.completedPasses),
    },
    {
      key: "possession",
      label: "점유율",
      left: possession === null ? "–" : `${Math.round(possession * 100)}%`,
      right: possession === null ? "–" : `${100 - Math.round(possession * 100)}%`,
      leftShare: possession,
    },
  ];
}
