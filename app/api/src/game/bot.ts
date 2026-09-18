/**
 * 연습 모드 봇. 서버 시뮬레이션 안에서 입력만 만들어 낸다.
 * 사람이 이길 수 있도록 반응 지연과 조준 오차를 준다.
 */
import { PITCH, SKILL, type Side } from "./constants.ts";
import type { InputState } from "../protocol.ts";
import type { Match } from "./sim.ts";

const REACTION_MS = 120;
const KICK_RANGE = 1.1;

export class Bot {
  private seq = 0;
  private reactionMs = 0;
  private aimNoise = 0;
  private holdKickMs = 0;

  private readonly side: Side;

  constructor(side: Side) {
    this.side = side;
  }

  think(match: Match, dtMs: number): InputState {
    this.seq += 1;
    this.reactionMs -= dtMs;
    if (this.reactionMs <= 0) {
      this.reactionMs = REACTION_MS;
      this.aimNoise = (Math.random() - 0.5) * 0.5;
    }

    const me = match.players[this.side];
    const ball = match.ball;
    const attackX = this.side === "left" ? PITCH.length : 0;
    const ownX = this.side === "left" ? 0 : PITCH.length;
    const midY = PITCH.width / 2;

    // 공과 자기 골문을 잇는 선 위에서 공 쪽으로 붙는다
    const toGoalX = ownX - ball.x;
    const toGoalY = midY - ball.y;
    const gl = Math.hypot(toGoalX, toGoalY) || 1;
    const targetX = ball.x + (toGoalX / gl) * 1.1;
    const targetY = ball.y + (toGoalY / gl) * 1.1 + this.aimNoise;

    let ax = targetX - me.x;
    let ay = targetY - me.y;
    const dist = Math.hypot(ax, ay) || 1;
    ax /= dist;
    ay /= dist;

    const ballDist = Math.hypot(ball.x - me.x, ball.y - me.y);
    const facingGoal = Math.sign(attackX - me.x);

    // 공을 잡으면 상대 골문 쪽을 보고 찬다
    let kick = false;
    if (ballDist < KICK_RANGE) {
      ax = facingGoal;
      ay = (midY - me.y) / (PITCH.width / 2) + this.aimNoise * 0.4;
      const l = Math.hypot(ax, ay) || 1;
      ax /= l;
      ay /= l;
      this.holdKickMs += dtMs;
      kick = this.holdKickMs < 380;
      if (this.holdKickMs > 520) this.holdKickMs = 0;
    } else {
      this.holdKickMs = 0;
    }

    // 상대가 공을 몰고 있고 가까우면 가끔 슬라이딩
    const human = match.players[this.side === "left" ? "right" : "left"];
    let skill: InputState["skill"] = null;
    if (
      human.dribbling &&
      Math.hypot(human.x - me.x, human.y - me.y) < SKILL.slide.reach &&
      Math.random() < 0.02
    ) {
      skill = "slide";
    }

    return {
      seq: this.seq,
      ax,
      ay,
      kick,
      sprint: ballDist > 6 && me.stamina > 0.3,
      skill,
    };
  }
}
