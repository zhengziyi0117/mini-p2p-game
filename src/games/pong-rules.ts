/** Pure Pong simulation, on the same fixed-tick model as Bomberman: the host
 *  steps this and broadcasts snapshots, the guest only renders them. Field
 *  units are arbitrary — the view scales them to whatever the screen allows. */

export const FIELD_WIDTH = 1000;
export const FIELD_HEIGHT = 600;
export const PADDLE_WIDTH = 16;
export const PADDLE_HEIGHT = 110;
export const PADDLE_MARGIN = 38;
export const BALL_RADIUS = 12;
export const STATE_VERSION = 1;

/** Per-millisecond speeds, so the tick length stays the only clock. */
export const PADDLE_SPEED = 0.55;
export const BALL_SPEED = 0.45;
export const MAX_BALL_SPEED = BALL_SPEED * 1.9;
/** Each paddle hit speeds the ball up, which is what ends rallies. */
export const SPEED_UP = 1.035;
/** Steepest return angle off a paddle face, in radians. */
export const MAX_BOUNCE_ANGLE = 0.92;

export const TICK_MS = 16;
export const SCORE_TO_WIN = 5;

export type PlayerColor = "black" | "white";
/** `black` defends the left side and serves as the first player everywhere else. */
export type PongInput = { up: boolean; down: boolean };
export type Ball = { x: number; y: number; vx: number; vy: number };

export type PongState = {
  version: typeof STATE_VERSION;
  roundId: number;
  seed: number;
  tick: number;
  status: "playing" | "finished";
  winner: PlayerColor | "draw" | null;
  scores: Record<PlayerColor, number>;
  /** Paddle centres, in field units. */
  paddles: Record<PlayerColor, number>;
  ball: Ball;
  /** Points played so far, so the same seed serves the same ball every time. */
  rally: number;
};

export const EMPTY_PONG_INPUT: PongInput = { up: false, down: false };
export const NO_SCORES: Record<PlayerColor, number> = { black: 0, white: 0 };
const COLORS = ["black", "white"] as const;

/** Left paddle x range is [PADDLE_MARGIN, PADDLE_MARGIN + PADDLE_WIDTH]. */
function paddleFront(color: PlayerColor) {
  return color === "black" ? PADDLE_MARGIN + PADDLE_WIDTH : FIELD_WIDTH - PADDLE_MARGIN - PADDLE_WIDTH;
}

function hash(seed: number, salt: number) {
  let value = (seed ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value >>> 0;
}

function clampPaddle(y: number) {
  return Math.min(FIELD_HEIGHT - PADDLE_HEIGHT / 2, Math.max(PADDLE_HEIGHT / 2, y));
}

/** Serves from the centre toward the side that just conceded, with a vertical
 *  angle derived from the seed so both peers see the identical ball. */
export function serve(seed: number, rally: number, toward: PlayerColor): Ball {
  const roll = (hash(seed, rally) % 1000) / 1000;
  const angle = (roll - 0.5) * 1.2;
  return {
    x: FIELD_WIDTH / 2,
    y: FIELD_HEIGHT / 2,
    vx: Math.cos(angle) * BALL_SPEED * (toward === "white" ? 1 : -1),
    vy: Math.sin(angle) * BALL_SPEED,
  };
}

export function createInitialState(seed: number, roundId: number, scores: Record<PlayerColor, number> = NO_SCORES): PongState {
  return {
    version: STATE_VERSION,
    roundId,
    seed,
    tick: 0,
    status: "playing",
    winner: null,
    scores: { ...scores },
    paddles: { black: FIELD_HEIGHT / 2, white: FIELD_HEIGHT / 2 },
    ball: serve(seed, 0, "black"),
    rally: 0,
  };
}

function movePaddle(y: number, input: PongInput, dt: number) {
  const step = (input.down ? 1 : 0) - (input.up ? 1 : 0);
  if (step === 0) return y;
  return clampPaddle(y + step * PADDLE_SPEED * dt);
}

/** Returns the ball after a paddle hit, or null when it was not intercepted. */
function paddleBounce(ball: Ball, color: PlayerColor, paddleY: number): Ball | null {
  const face = paddleFront(color);
  const approaching = color === "black" ? ball.vx < 0 : ball.vx > 0;
  if (!approaching) return null;

  const touching = color === "black"
    ? ball.x - BALL_RADIUS <= face && ball.x + BALL_RADIUS >= PADDLE_MARGIN
    : ball.x + BALL_RADIUS >= face && ball.x - BALL_RADIUS <= FIELD_WIDTH - PADDLE_MARGIN;
  if (!touching) return null;
  if (Math.abs(ball.y - paddleY) > PADDLE_HEIGHT / 2 + BALL_RADIUS) return null;

  // Where it landed on the face steers the return, the way Pong always has.
  const offset = Math.max(-1, Math.min(1, (ball.y - paddleY) / (PADDLE_HEIGHT / 2)));
  const angle = offset * MAX_BOUNCE_ANGLE;
  const speed = Math.min(Math.hypot(ball.vx, ball.vy) * SPEED_UP, MAX_BALL_SPEED);
  const direction = color === "black" ? 1 : -1;

  return {
    x: color === "black" ? face + BALL_RADIUS : face - BALL_RADIUS,
    y: ball.y,
    vx: Math.cos(angle) * speed * direction,
    vy: Math.sin(angle) * speed,
  };
}

/** One host tick. `dt` is the fixed tick length, never wall-clock. */
export function stepHostState(current: PongState, localInput: PongInput, remoteInput: PongInput, dt: number = TICK_MS): PongState {
  if (current.status !== "playing") return current;

  const next: PongState = {
    ...current,
    tick: current.tick + 1,
    scores: { ...current.scores },
    paddles: { ...current.paddles },
    ball: { ...current.ball },
  };

  for (const color of COLORS) {
    const input = color === "black" ? localInput : remoteInput;
    next.paddles[color] = movePaddle(next.paddles[color], input, dt);
  }

  const ball = next.ball;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  if (ball.y - BALL_RADIUS <= 0) {
    ball.y = BALL_RADIUS;
    ball.vy = Math.abs(ball.vy);
  } else if (ball.y + BALL_RADIUS >= FIELD_HEIGHT) {
    ball.y = FIELD_HEIGHT - BALL_RADIUS;
    ball.vy = -Math.abs(ball.vy);
  }

  for (const color of COLORS) {
    const bounced = paddleBounce(ball, color, next.paddles[color]);
    if (bounced) {
      next.ball = bounced;
      break;
    }
  }

  // --- scoring --------------------------------------------------------------
  const scored: PlayerColor | null =
    next.ball.x + BALL_RADIUS < 0 ? "white" : next.ball.x - BALL_RADIUS > FIELD_WIDTH ? "black" : null;

  if (scored) {
    next.scores[scored] += 1;
    next.rally = current.rally + 1;
    if (next.scores[scored] >= SCORE_TO_WIN) {
      next.status = "finished";
      next.winner = scored;
      return next;
    }
    // The side that conceded gets the next serve.
    const toward = scored === "black" ? "white" : "black";
    next.ball = serve(next.seed, next.rally, toward);
    next.paddles = { black: FIELD_HEIGHT / 2, white: FIELD_HEIGHT / 2 };
  }

  return next;
}

export function normalizePongInput(value: unknown): PongInput {
  if (!value || typeof value !== "object") return { ...EMPTY_PONG_INPUT };
  const input = value as Partial<PongInput>;
  return { up: Boolean(input.up), down: Boolean(input.down) };
}

export function isPongState(value: unknown): value is PongState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<PongState>;
  return (
    state.version === STATE_VERSION &&
    Boolean(state.paddles?.black !== undefined && state.paddles?.white !== undefined) &&
    typeof state.ball?.x === "number" &&
    Boolean(state.scores) &&
    typeof state.tick === "number"
  );
}
