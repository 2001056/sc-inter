import type { ClientMessage, SkillKind } from "./protocol.ts";

const NICKNAME_MAX = 12;
const CODE_RE = /^[A-Z0-9]{6}$/;
const CONTROL_RE = new RegExp("[\\u0000-\\u001f\\u007f]", "g");
const SKILLS: readonly SkillKind[] = ["stepover", "slide"];

/** 제어문자를 지우고 앞뒤 공백을 정리한 닉네임. 규칙에 맞지 않으면 null. */
export function normalizeNickname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_RE, "").trim();
  if (cleaned.length < 1 || cleaned.length > NICKNAME_MAX) return null;
  return cleaned;
}

export function normalizeCode(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const code = raw.trim().toUpperCase();
  return CODE_RE.test(code) ? code : null;
}

function clampAxis(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function parseSkill(value: unknown): SkillKind | null {
  return typeof value === "string" && (SKILLS as readonly string[]).includes(value)
    ? (value as SkillKind)
    : null;
}

/**
 * 신뢰할 수 없는 입력을 ClientMessage 로 좁힌다.
 * 형식이 조금이라도 어긋나면 null 을 돌려주고 호출자가 BAD_MESSAGE 로 응답한다.
 */
export function parseClientMessage(raw: string): ClientMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const msg = data as Record<string, unknown>;
  switch (msg["t"]) {
    case "create":
    case "practice": {
      const nickname = normalizeNickname(msg["nickname"]);
      if (nickname === null) return null;
      return msg["t"] === "create"
        ? { t: "create", nickname }
        : { t: "practice", nickname };
    }
    case "join": {
      const nickname = normalizeNickname(msg["nickname"]);
      const code = normalizeCode(msg["code"]);
      if (nickname === null || code === null) return null;
      return { t: "join", nickname, code };
    }
    case "resume": {
      const token = msg["token"];
      if (typeof token !== "string" || token.length < 8 || token.length > 64) return null;
      return { t: "resume", token };
    }
    case "input": {
      const seq = msg["seq"];
      if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0) return null;
      return {
        t: "input",
        seq,
        ax: clampAxis(msg["ax"]),
        ay: clampAxis(msg["ay"]),
        kick: msg["kick"] === true,
        sprint: msg["sprint"] === true,
        skill: parseSkill(msg["skill"]),
      };
    }
    case "rematch":
      return { t: "rematch" };
    case "leave":
      return { t: "leave" };
    case "ping": {
      const ts = msg["ts"];
      if (typeof ts !== "number" || !Number.isFinite(ts)) return null;
      return { t: "ping", ts };
    }
    default:
      return null;
  }
}
