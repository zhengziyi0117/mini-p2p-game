import assert from "node:assert/strict";
import test from "node:test";
import {
  COLLAPSE_EVERY_TICKS,
  EMPTY_INPUT,
  GRID_WIDTH,
  NO_SCORES,
  STATE_VERSION,
  SUDDEN_DEATH_TICKS,
  blastCells,
  canWalkTo,
  cellIndex,
  createInitialState,
  isBomberState,
  isWall,
  stepHostState,
  type BomberState,
  type InputState,
} from "../src/games/bomberman-rules.ts";

const TICK = 25;
/** Far beyond the runner's clock, so only a chain can ever reach these fuses. */
const NOT_YET = 9_000_000_000;
const idle: InputState = { ...EMPTY_INPUT };
const bomb: InputState = { ...EMPTY_INPUT, placeBomb: true };

/** Runs `count` host ticks, keeping one wall-clock cursor so fuses fire. */
function run(state: BomberState, count: number, black = idle, white = idle) {
  let now = 1_000_000;
  let current = state;
  for (let i = 0; i < count; i += 1) {
    now += TICK;
    // placeBomb is edge-triggered by the host loop; a held key must not repeat.
    current = stepHostState(current, i === 0 ? black : idle, i === 0 ? white : idle, now);
  }
  return current;
}

function emptyArena(seed = 7) {
  const state = createInitialState(seed, 1);
  state.blocks = [];
  return state;
}

test("the same seed always builds the same map", () => {
  const a = createInitialState(12345, 1);
  const b = createInitialState(12345, 1);
  assert.deepEqual(a.blocks, b.blocks);
  assert.notDeepEqual(a.blocks, createInitialState(54321, 1).blocks);
  assert.equal(a.version, STATE_VERSION);
});

test("the map keeps both spawns clear and never blocks a wall", () => {
  const state = createInitialState(99, 1);
  for (const color of ["black", "white"] as const) {
    const { x, y } = state.players[color];
    assert.equal(isWall(x, y), false, `spawn ${color} sits on a wall`);
    assert.equal(state.blocks.includes(cellIndex(x, y)), false, `spawn ${color} is walled in`);
    assert.equal(canWalkTo(state, color, x, y), true, `spawn ${color} must be enterable`);
  }
  for (const index of state.blocks) {
    const x = index % GRID_WIDTH;
    const y = Math.floor(index / GRID_WIDTH);
    assert.equal(isWall(x, y), false, `block on wall at ${x},${y}`);
  }
});

test("a bomb blows up its owner, and the shield absorbs one hit", () => {
  const state = emptyArena();
  state.players.white.shield = true;
  const shielded = run(state, 80, bomb, idle);
  assert.equal(shielded.players.black.alive, false, "black stood on its own bomb");
  assert.equal(shielded.players.white.alive, true, "white was far away");

  const protectedState = emptyArena();
  protectedState.players.black.shield = true;
  const survived = run(protectedState, 80, bomb, idle);
  assert.equal(survived.players.black.alive, true);
  assert.equal(survived.players.black.shield, false, "shield should be consumed");
});

test("blasts stop at walls but destroy the block that absorbs them", () => {
  const state = emptyArena();
  state.blocks = [cellIndex(2, 1)];

  const cells = blastCells(state, { id: "t", owner: "black", x: 1, y: 1, explodeAt: 0 }, 1);
  assert.ok(cells.includes(cellIndex(1, 1)), "the bomb's own cell burns");
  assert.ok(cells.includes(cellIndex(2, 1)), "the absorbing block is hit");
  assert.ok(!cells.includes(cellIndex(3, 1)), "nothing behind the block is hit");
  assert.ok(!cells.includes(cellIndex(0, 1)), "the border wall is not a blast cell");

  // Pillars sit on even/even intersections and stop a blast without burning.
  assert.equal(isWall(4, 2), true);
  const aroundPillar = blastCells(state, { id: "t2", owner: "black", x: 3, y: 2, explodeAt: 0 }, 5);
  assert.ok(!aroundPillar.includes(cellIndex(4, 2)));
});

test("a blast chain-detonates every bomb it covers, in the same tick", () => {
  const state = emptyArena();
  state.players.black.maxBombs = 3;
  state.players.black.bombsAvailable = 0;
  // A row of bombs at (1,1), (2,1), (3,1) with flame length 1: the first
  // detonation reaches the second, which reaches the third.
  for (const x of [1, 2, 3]) {
    state.players.black.flameLength = 1;
    state.bombs.push({ id: `black-${x}`, owner: "black", x, y: 1, explodeAt: x === 1 ? 0 : NOT_YET });
  }
  const after = run(state, 1);
  assert.deepEqual(after.bombs, [], "all three bombs should be gone");
  assert.equal(after.explosions.length, 3, "each bomb gets its own blast");
  const covered = new Set(after.explosions.flatMap((explosion) => explosion.cells));
  assert.ok(covered.has(cellIndex(3, 1)), "the far bomb's cell is covered");
  assert.equal(after.players.black.bombsAvailable, 3, "every fused bomb returns to the pool");
});

test("a bomb outside the blast is left alone", () => {
  const state = emptyArena();
  state.players.black.flameLength = 1;
  state.bombs.push({ id: "near", owner: "black", x: 1, y: 1, explodeAt: 0 });
  state.bombs.push({ id: "far", owner: "white", x: 1, y: 5, explodeAt: NOT_YET });
  const after = run(state, 1);
  assert.deepEqual(after.bombs.map((bomb) => bomb.id), ["far"]);
});

test("a chained bomb does not free its slot twice", () => {
  const state = emptyArena();
  state.players.black.maxBombs = 3;
  state.players.black.bombsAvailable = 0;
  for (const x of [1, 2]) {
    state.bombs.push({ id: `black-${x}`, owner: "black", x, y: 1, explodeAt: 0 });
  }
  const after = run(state, 1);
  assert.equal(after.players.black.bombsAvailable, 2);
});

test("the last player standing wins the round and banks the point", () => {
  const state = emptyArena();
  state.players.white.alive = false;
  const after = stepHostState(state, idle, idle, 1_000_025);
  assert.equal(after.status, "finished");
  assert.equal(after.winner, "black");
  assert.deepEqual(after.scores, { black: 1, white: 0 });
});

test("a mutual kill is a draw and scores nothing", () => {
  const state = emptyArena();
  for (const color of ["black", "white"] as const) {
    state.players[color] = { ...state.players[color], x: 1, y: 1 };
  }
  const after = run(state, 80, bomb, idle);
  assert.equal(after.status, "finished");
  assert.equal(after.winner, "draw");
  assert.deepEqual(after.scores, NO_SCORES);
});

test("a finished round is frozen: no further ticks change it", () => {
  const state = emptyArena();
  state.players.white.alive = false;
  const finished = stepHostState(state, idle, idle, 1_000_025);
  assert.equal(stepHostState(finished, idle, idle, 1_000_050), finished);
});

test("sudden death starts on schedule and then eats a block at a time", () => {
  const state = emptyArena();
  state.tick = SUDDEN_DEATH_TICKS - 1;
  state.blocks = Array.from({ length: 40 }, (_, i) => cellIndex(1 + (i % 11), 1 + Math.floor(i / 11)));

  const before = run(state, 1);
  assert.equal(before.tick, SUDDEN_DEATH_TICKS);
  assert.equal(before.suddenDeath, true, "collapse is announced at the deadline");

  // The deadline lands on an interval boundary, so the first block goes at once
  // and the countdown in the UI never sits at zero.
  assert.equal(before.blocks.length, 39);
  assert.equal(SUDDEN_DEATH_TICKS % COLLAPSE_EVERY_TICKS, 0);

  const quiet = run(before, COLLAPSE_EVERY_TICKS - 1);
  assert.equal(quiet.blocks.length, 39, "nothing collapses between intervals");

  const nextCollapse = run(quiet, 1);
  assert.equal(nextCollapse.blocks.length, 38);
  assert.ok(nextCollapse.blocks.every((index) => before.blocks.includes(index)), "collapse only removes");
});

test("collapse picks the same block for the same seed and tick", () => {
  const build = () => {
    const state = emptyArena(4242);
    state.tick = SUDDEN_DEATH_TICKS + COLLAPSE_EVERY_TICKS - 1;
    state.blocks = Array.from({ length: 40 }, (_, i) => cellIndex(1 + (i % 11), 1 + Math.floor(i / 11)));
    return state;
  };
  assert.deepEqual(run(build(), 1).blocks, run(build(), 1).blocks);
});

test("the map cannot be collapsed into nothing", () => {
  const state = emptyArena();
  state.tick = SUDDEN_DEATH_TICKS - 1;
  state.blocks = [];
  const after = run(state, 5);
  assert.deepEqual(after.blocks, [], "collapse on an empty map is a no-op, not a crash");
});

test("a held bomb key does not stack bombs on one cell", () => {
  const state = emptyArena();
  let current = state;
  let now = 1_000_000;
  for (let i = 0; i < 5; i += 1) {
    now += TICK;
    current = stepHostState(current, bomb, idle, now);
  }
  assert.equal(current.bombs.length, 1, "bombsAvailable also caps this at one");
});

test("state validation rejects payloads from another build", () => {
  assert.equal(isBomberState(createInitialState(1, 1)), true);
  assert.equal(isBomberState({ ...createInitialState(1, 1), version: 2 }), false);
  assert.equal(isBomberState({ ...createInitialState(1, 1), scores: undefined }), false);
  assert.equal(isBomberState(null), false);
  assert.equal(isBomberState("nope"), false);
});
