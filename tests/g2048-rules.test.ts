import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_CELLS,
  STATE_VERSION,
  WINNING_TILE,
  applyMove,
  canMove,
  createInitialState,
  hasTile,
  isG2048State,
  largestTile,
  type G2048State,
  type Tile,
} from "../src/games/g2048-rules.ts";

const NO_TILES = Array.from({ length: BOARD_CELLS }, () => 0 as Tile);

function withGrid(grid: Tile[], overrides: Partial<G2048State> = {}): G2048State {
  return { ...createInitialState(1, 1), grid, ...overrides };
}

/** Filled cells, so assertions can ignore wherever the new tile landed. */
function occupied(grid: Tile[]) {
  return grid.filter((tile) => tile !== 0).length;
}

test("a new board opens with two tiles from the seed", () => {
  const state = createInitialState(7, 1);
  assert.equal(occupied(state.grid), 2);
  assert.equal(state.status, "playing");
  assert.equal(state.score, 0);
  assert.equal(state.version, STATE_VERSION);
  for (const tile of state.grid) assert.ok(tile === 0 || tile === 2 || tile === 4, `unexpected opening tile ${tile}`);
  assert.deepEqual(createInitialState(7, 1).grid, state.grid, "the seed alone decides the opening");
  assert.notDeepEqual(createInitialState(8, 1).grid, state.grid);
});

test("a swipe packs each line toward the direction of travel, across gaps", () => {
  // The two 2s start in columns 0 and 2 of row 0, with a hole between them.
  const across = withGrid([2, 0, 2, 0, ...NO_TILES.slice(4)]);

  const left = applyMove(across, "left");
  assert.equal(left.grid[0], 4);
  assert.equal(left.score, 4);

  const right = applyMove(across, "right");
  assert.equal(right.grid[3], 4, "sliding the other way lands on the far wall");
  assert.equal(right.score, 4);

  // Same pair, but stacked down column 0 instead.
  const down = withGrid([2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, ...NO_TILES.slice(12)]);
  assert.equal(applyMove(down, "up").grid[0], 4, "up packs toward row 0");
  assert.equal(applyMove(down, "down").grid[12], 4, "down packs toward row 3");
});

test("each tile merges at most once per swipe", () => {
  const state = applyMove(withGrid([2, 2, 2, 2, ...NO_TILES.slice(4)]), "left");
  assert.deepEqual([state.grid[0], state.grid[1]], [4, 4], "not a single 8");
  assert.equal(state.score, 8);
  assert.equal(occupied(state.grid), 3, "two merged tiles plus the one that spawned");
});

test("a swipe that changes nothing does not spend the shared tile sequence", () => {
  // Already packed hard against the left wall with no equal neighbours.
  const packed = [2, 4, 2, 4, 4, 2, 4, 2, 2, 4, 2, 4, 4, 2, 4, 2];
  const state = withGrid(packed);
  assert.equal(applyMove(state, "left"), state, "the same state object comes back");
  assert.equal(state.spawns, 2, "so the next real move still draws the same tile");
  assert.equal(canMove(packed), false, "and there is nothing left to do on this board");
});

test("the same seed and the same swipes give the same board", () => {
  const swipes = ["left", "up", "right", "down", "left", "down", "right"] as const;
  const play = () => swipes.reduce((state, direction) => applyMove(state, direction), createInitialState(2024, 1));
  const a = play();
  const b = play();
  assert.deepEqual(a.grid, b.grid);
  assert.equal(a.score, b.score);
  assert.equal(a.spawns, b.spawns, "both boards drew the same number of tiles");
});

test("reaching 2048 wins the round", () => {
  const near = withGrid([1024, 1024, 0, 0, ...NO_TILES.slice(4)]);
  const won = applyMove(near, "left");
  assert.equal(won.status, "won");
  assert.equal(largestTile(won.grid), WINNING_TILE);
  assert.equal(hasTile(won.grid, WINNING_TILE), true);
  assert.equal(applyMove(won, "left"), won, "a finished board stops accepting swipes");
});

test("a full board with no merge left is a loss", () => {
  // Sliding left turns row 0's 2,2 into 4,8,16 and frees exactly one cell. The
  // tile that spawns into it can never rejoin anything, so the board is stuck.
  const stuck = withGrid([2, 2, 8, 16, 8, 16, 32, 64, 16, 32, 64, 128, 32, 64, 128, 256]);
  const lost = applyMove(stuck, "left");
  assert.equal(occupied(lost.grid), BOARD_CELLS, "the spawn filled the only hole");
  assert.equal(canMove(lost.grid), false);
  assert.equal(lost.status, "lost");
  assert.equal(lost.score, 4);
  assert.equal(applyMove(lost, "right"), lost, "a lost board stops accepting swipes");
});

test("state validation rejects payloads from another build", () => {
  assert.equal(isG2048State(createInitialState(1, 1)), true);
  assert.equal(isG2048State({ ...createInitialState(1, 1), version: 2 }), false);
  assert.equal(isG2048State({ ...createInitialState(1, 1), grid: [] }), false);
  assert.equal(isG2048State(null), false);
});
