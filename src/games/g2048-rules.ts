/** Pure 2048 rules. No React, no DOM.
 *
 *  Unlike the versus games, neither peer owns the other's board: both sides
 *  play the same seeded tile sequence on their own grid and race to 2048. The
 *  seed is the whole shared state, which is why this needs almost no netcode —
 *  only the finish line has to be forwarded. */

export const BOARD_SIZE = 4;
export const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;
export const STATE_VERSION = 1;
/** Reaching this tile wins outright; running out of moves loses. */
export const WINNING_TILE = 2048;

export type Direction = "up" | "down" | "left" | "right";
export type Tile = number;
export type Grid = Tile[];

export type G2048State = {
  version: typeof STATE_VERSION;
  roundId: number;
  seed: number;
  /** Consecutive spawns drawn, which is what keeps both boards identical. */
  spawns: number;
  grid: Grid;
  score: number;
  best: number;
  status: "playing" | "won" | "lost";
  moves: number;
};

/** A 4-bit hash, good enough to drive tile spawns deterministically. */
function hash(seed: number, salt: number) {
  let value = (seed ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value >>> 0;
}

function emptyCells(grid: Grid) {
  const cells: number[] = [];
  for (let index = 0; index < BOARD_CELLS; index += 1) {
    if (grid[index] === 0) cells.push(index);
  }
  return cells;
}

/** Places the next tile of the sequence. Returns the grid untouched when the
 *  board is full, so a caller can never spawn into a finished game. */
function spawn(grid: Grid, seed: number, spawns: number): Grid {
  const cells = emptyCells(grid);
  if (!cells.length) return grid;
  const next = grid.slice();
  const pick = hash(seed, spawns) % cells.length;
  // The classic 90/10 split between a 2 and a 4.
  next[cells[pick]] = hash(seed, spawns + 0x5bf03635) % 10 === 0 ? 4 : 2;
  return next;
}

export function createInitialState(seed: number, roundId: number): G2048State {
  let grid: Grid = Array.from({ length: BOARD_CELLS }, () => 0);
  grid = spawn(grid, seed, 0);
  grid = spawn(grid, seed, 1);
  return {
    version: STATE_VERSION,
    roundId,
    seed,
    spawns: 2,
    grid,
    score: 0,
    best: 0,
    status: "playing",
    moves: 0,
  };
}

/** One row packed toward index 0, plus the score it earned. */
function slideRow(row: Tile[]): { row: Tile[]; gained: number } {
  const packed = row.filter((tile) => tile !== 0);
  const merged: Tile[] = [];
  let gained = 0;
  for (let i = 0; i < packed.length; i += 1) {
    // Each tile can only merge once per move, which is why this walks a packed
    // copy instead of comparing neighbours in place.
    if (i + 1 < packed.length && packed[i] === packed[i + 1]) {
      const doubled = packed[i] * 2;
      merged.push(doubled);
      gained += doubled;
      i += 1;
    } else {
      merged.push(packed[i]);
    }
  }
  while (merged.length < BOARD_SIZE) merged.push(0);
  return { row: merged, gained };
}

/** Reads the board as rows in the direction of travel, so every direction is
 *  the same left-pack of a different traversal. */
function linesFor(direction: Direction): number[][] {
  const lines: number[][] = [];
  for (let i = 0; i < BOARD_SIZE; i += 1) {
    const line: number[] = [];
    for (let j = 0; j < BOARD_SIZE; j += 1) {
      const row = direction === "up" || direction === "down" ? j : i;
      const column = direction === "up" || direction === "down" ? i : j;
      line.push(row * BOARD_SIZE + column);
    }
    // Packing always happens toward the start of the line, so lines that run
    // right or down are read back to front.
    lines.push(direction === "right" || direction === "down" ? line.reverse() : line);
  }
  return lines;
}

export function canMove(grid: Grid) {
  if (emptyCells(grid).length) return true;
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let column = 0; column < BOARD_SIZE; column += 1) {
      const tile = grid[row * BOARD_SIZE + column];
      if (column + 1 < BOARD_SIZE && grid[row * BOARD_SIZE + column + 1] === tile) return true;
      if (row + 1 < BOARD_SIZE && grid[(row + 1) * BOARD_SIZE + column] === tile) return true;
    }
  }
  return false;
}

export function hasTile(grid: Grid, tile: Tile) {
  return grid.some((value) => value >= tile);
}

/** Applies one swipe. A move that changes nothing — a wall, a full line — costs
 *  no spawn, so a stray key press cannot advance the shared tile sequence. */
export function applyMove(state: G2048State, direction: Direction): G2048State {
  if (state.status !== "playing") return state;

  const grid: Grid = Array.from({ length: BOARD_CELLS }, () => 0);
  let gained = 0;
  for (const line of linesFor(direction)) {
    const { row, gained: lineGain } = slideRow(line.map((index) => state.grid[index]));
    line.forEach((index, position) => {
      grid[index] = row[position];
    });
    gained += lineGain;
  }

  if (grid.every((value, index) => value === state.grid[index])) return state;

  const spawns = state.spawns + 1;
  const spawned = spawn(grid, state.seed, state.spawns);
  const score = state.score + gained;
  const status = hasTile(spawned, WINNING_TILE) ? "won" : canMove(spawned) ? "playing" : "lost";

  return {
    ...state,
    grid: spawned,
    spawns,
    score,
    best: Math.max(state.best, score),
    moves: state.moves + 1,
    status,
  };
}

export function largestTile(grid: Grid) {
  return grid.reduce((largest, tile) => Math.max(largest, tile), 0);
}

export function isG2048State(value: unknown): value is G2048State {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<G2048State>;
  return (
    state.version === STATE_VERSION &&
    Array.isArray(state.grid) &&
    state.grid.length === BOARD_CELLS &&
    typeof state.seed === "number" &&
    typeof state.score === "number"
  );
}
