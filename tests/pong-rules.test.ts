import assert from "node:assert/strict";
import test from "node:test";
import {
  BALL_RADIUS,
  BALL_SPEED,
  EMPTY_PONG_INPUT,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  NO_SCORES,
  PADDLE_HEIGHT,
  PADDLE_MARGIN,
  PADDLE_WIDTH,
  SCORE_TO_WIN,
  STATE_VERSION,
  TICK_MS,
  createInitialState,
  isPongState,
  serve,
  stepHostState,
  type PongInput,
  type PongState,
} from "../src/games/pong-rules.ts";

const idle: PongInput = { ...EMPTY_PONG_INPUT };
const up: PongInput = { up: true, down: false };
const PADDLE_FRONT = PADDLE_MARGIN + PADDLE_WIDTH;

function run(state: PongState, ticks: number, black = idle, white = idle) {
  let current = state;
  for (let i = 0; i < ticks; i += 1) current = stepHostState(current, black, white);
  return current;
}

/** A state whose ball sits still, so paddle tests never trip a point. */
function parked(): PongState {
  return { ...createInitialState(1, 1), ball: { x: FIELD_WIDTH / 2, y: FIELD_HEIGHT / 2, vx: 0, vy: 0 } };
}

test("the same seed serves the same ball", () => {
  const a = createInitialState(4242, 1);
  const b = createInitialState(4242, 1);
  assert.deepEqual(a.ball, b.ball);
  assert.notDeepEqual(a.ball, createInitialState(99, 1).ball);
  assert.equal(a.version, STATE_VERSION);
});

test("paddles hold still without input and clamp at the walls", () => {
  const still = run(parked(), 20);
  assert.equal(still.paddles.black, FIELD_HEIGHT / 2);
  assert.equal(still.paddles.white, FIELD_HEIGHT / 2);

  const raised = run(parked(), 100, up);
  assert.equal(raised.paddles.black, PADDLE_HEIGHT / 2, "the left paddle stops at the top edge");
  assert.equal(raised.paddles.white, FIELD_HEIGHT / 2, "the remote paddle only moves on remote input");

  const lowered = run(parked(), 100, idle, { up: false, down: true });
  assert.equal(lowered.paddles.white, FIELD_HEIGHT - PADDLE_HEIGHT / 2);
  assert.equal(lowered.paddles.black, FIELD_HEIGHT / 2);
});

test("the ball bounces off the top and bottom walls", () => {
  const top: PongState = { ...parked(), ball: { x: 500, y: 30, vx: 0, vy: -BALL_SPEED } };
  const afterTop = run(top, 30);
  assert.ok(afterTop.ball.vy > 0, "it should be heading back down");
  assert.ok(afterTop.ball.y >= BALL_RADIUS, "and never leave the field");

  const bottom: PongState = { ...parked(), ball: { x: 500, y: FIELD_HEIGHT - 30, vx: 0, vy: BALL_SPEED } };
  const afterBottom = run(bottom, 30);
  assert.ok(afterBottom.ball.vy < 0);
  assert.ok(afterBottom.ball.y <= FIELD_HEIGHT - BALL_RADIUS);
});

test("a paddle returns the ball and the hit position steers the angle", () => {
  const centre: PongState = {
    ...parked(),
    ball: { x: PADDLE_FRONT + BALL_RADIUS + 3, y: FIELD_HEIGHT / 2, vx: -BALL_SPEED, vy: 0 },
  };
  const returned = run(centre, 1);
  assert.ok(returned.ball.vx > 0, "a hit sends the ball back the other way");
  assert.equal(Math.round(returned.ball.vy), 0, "a centre hit comes straight back");
  assert.ok(returned.ball.x >= PADDLE_FRONT, "and is placed clear of the paddle face");
  assert.ok(Math.hypot(returned.ball.vx, returned.ball.vy) > BALL_SPEED, "every hit speeds it up");

  // Clipping the bottom half of the same paddle must aim the ball downward.
  const edge: PongState = { ...centre, paddles: { black: FIELD_HEIGHT / 2 - PADDLE_HEIGHT / 2, white: FIELD_HEIGHT / 2 } };
  const deflected = run(edge, 1);
  assert.ok(deflected.ball.vx > 0);
  assert.ok(deflected.ball.vy > 0, "hitting below centre aims down");
});

test("a missed ball scores for the other side and re-serves from the centre", () => {
  const missed: PongState = { ...parked(), ball: { x: -BALL_RADIUS - 1, y: FIELD_HEIGHT / 2, vx: -BALL_SPEED, vy: 0 } };
  const after = run(missed, 1);
  assert.deepEqual(after.scores, { black: 0, white: 1 });
  assert.equal(after.status, "playing");
  assert.equal(after.ball.x, FIELD_WIDTH / 2, "the serve starts from the middle again");
  assert.equal(after.paddles.black, FIELD_HEIGHT / 2, "and both paddles recentre");
  assert.ok(after.rally > 0, "the rally counter advances so the serve stays deterministic");
});

test("the first side to the target score wins and the state freezes", () => {
  const matchPoint: PongState = {
    ...parked(),
    scores: { black: SCORE_TO_WIN - 1, white: 0 },
    ball: { x: FIELD_WIDTH + BALL_RADIUS + 1, y: FIELD_HEIGHT / 2, vx: BALL_SPEED, vy: 0 },
  };
  const won = run(matchPoint, 1);
  assert.equal(won.status, "finished");
  assert.equal(won.winner, "black");
  assert.deepEqual(won.scores, { black: SCORE_TO_WIN, white: 0 });
  assert.equal(stepHostState(won, idle, idle), won, "a finished match stops ticking");
});

test("the serve points at whoever just conceded", () => {
  assert.ok(serve(7, 0, "white").vx > 0, "serves travel toward white");
  assert.ok(serve(7, 0, "black").vx < 0, "and toward black");
  assert.deepEqual(serve(7, 3, "white"), serve(7, 3, "white"), "same seed and rally, same ball");
});

test("state validation rejects payloads from another build", () => {
  assert.equal(isPongState(createInitialState(1, 1)), true);
  assert.equal(isPongState({ ...createInitialState(1, 1), version: 2 }), false);
  assert.equal(isPongState({ ...createInitialState(1, 1), ball: undefined }), false);
  assert.equal(isPongState(null), false);
  assert.equal(NO_SCORES.black, 0);
  assert.equal(TICK_MS, 16);
});
