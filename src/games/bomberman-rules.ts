/** Pure Bomberman simulation. No React, no DOM — the host runs this on a fixed
 *  tick and broadcasts the result; the guest only ever renders snapshots. */

export const GRID_WIDTH = 13;
export const GRID_HEIGHT = 11;
export const STATE_VERSION = 3;

export const BOMB_FUSE_MS = 1800;
export const EXPLOSION_MS = 500;
/** Ticks are 25ms on the host, so sudden death starts after ~60s of play. */
export const SUDDEN_DEATH_TICKS = 2400;
export const COLLAPSE_EVERY_TICKS = 80;
/** First to two rounds wins the match. */
export const SCORE_TO_WIN = 2;

export type PlayerColor = "black" | "white";
export type Direction = "up" | "down" | "left" | "right";
export type InputState = Record<Direction, boolean> & { placeBomb: boolean };
export type PowerupKind = "bomb" | "flame" | "speed" | "shield";

export type PlayerState = {
  x: number;
  y: number;
  alive: boolean;
  maxBombs: number;
  bombsAvailable: number;
  flameLength: number;
  speedLevel: number;
  shield: boolean;
  nextMoveAt: number;
};

export type BombState = {
  id: string;
  owner: PlayerColor;
  x: number;
  y: number;
  explodeAt: number;
};

export type ExplosionState = { cells: number[]; expiresAt: number };
export type PowerupState = { id: string; kind: PowerupKind; x: number; y: number };

export type BomberState = {
  version: typeof STATE_VERSION;
  roundId: number;
  seed: number;
  tick: number;
  status: "waiting" | "playing" | "finished";
  winner: PlayerColor | "draw" | null;
  suddenDeath: boolean;
  scores: Record<PlayerColor, number>;
  blocks: number[];
  bombs: BombState[];
  explosions: ExplosionState[];
  powerups: PowerupState[];
  players: Record<PlayerColor, PlayerState>;
};

export const EMPTY_INPUT: InputState = { up: false, down: false, left: false, right: false, placeBomb: false };
export const NO_SCORES: Record<PlayerColor, number> = { black: 0, white: 0 };
const COLORS = ["black", "white"] as const;

export function cellIndex(x: number, y: number) {
  return y * GRID_WIDTH + x;
}

export function isWall(x: number, y: number) {
  return x <= 0 || y <= 0 || x >= GRID_WIDTH - 1 || y >= GRID_HEIGHT - 1 || (x % 2 === 0 && y % 2 === 0);
}

function isSpawnSafe(x: number, y: number) {
  return (x <= 2 && y <= 2) || (x >= GRID_WIDTH - 3 && y >= GRID_HEIGHT - 3);
}

/** Deterministic hash used for every "random" gameplay decision, so a test can
 *  reproduce any position from (seed, tick) alone. */
function hash(seed: number, salt: number) {
  let value = (seed ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x85ebca6b) >>> 0;
  value ^= value >>> 13;
  return value >>> 0;
}

function resetPlayer(x: number, y: number): PlayerState {
  return { x, y, alive: true, maxBombs: 1, bombsAvailable: 1, flameLength: 2, speedLevel: 1, shield: false, nextMoveAt: 0 };
}

export function createInitialState(seed: number, roundId: number, scores: Record<PlayerColor, number> = NO_SCORES): BomberState {
  const blocks: number[] = [];
  for (let y = 1; y < GRID_HEIGHT - 1; y += 1) {
    for (let x = 1; x < GRID_WIDTH - 1; x += 1) {
      if (isWall(x, y) || isSpawnSafe(x, y)) continue;
      if (hash(seed, cellIndex(x, y)) % 1000 < 420) blocks.push(cellIndex(x, y));
    }
  }
  return {
    version: STATE_VERSION,
    roundId,
    seed,
    tick: 0,
    status: "playing",
    winner: null,
    suddenDeath: false,
    scores: { ...scores },
    blocks,
    bombs: [],
    explosions: [],
    powerups: [],
    players: {
      black: resetPlayer(1, 1),
      white: resetPlayer(GRID_WIDTH - 2, GRID_HEIGHT - 2),
    },
  };
}

export function createWaitingState(roundId: number, scores: Record<PlayerColor, number> = NO_SCORES): BomberState {
  return { ...createInitialState(1, roundId, scores), status: "waiting", blocks: [] };
}

export function hasBlock(state: BomberState, index: number) {
  return state.blocks.includes(index);
}

export function hasBomb(state: BomberState, index: number) {
  return state.bombs.some((bomb) => cellIndex(bomb.x, bomb.y) === index);
}

export function moveIntervalFor(player: PlayerState) {
  if (player.speedLevel >= 3) return 50;
  if (player.speedLevel === 2) return 75;
  return 100;
}

export function powerupDrop(seed: number, index: number): PowerupKind | null {
  const value = hash(seed, index);
  if (value % 100 >= 32) return null;
  return (["bomb", "flame", "speed", "shield"] as const)[value % 4];
}

function dropPowerup(state: BomberState, index: number) {
  const kind = powerupDrop(state.seed, index);
  if (!kind) return;
  state.powerups.push({ id: `${state.roundId}-${index}`, kind, x: index % GRID_WIDTH, y: Math.floor(index / GRID_WIDTH) });
}

function applyPowerup(player: PlayerState, kind: PowerupKind) {
  if (kind === "bomb") {
    player.maxBombs = Math.min(3, player.maxBombs + 1);
    player.bombsAvailable = Math.min(player.maxBombs, player.bombsAvailable + 1);
  }
  if (kind === "flame") player.flameLength = Math.min(5, player.flameLength + 1);
  if (kind === "speed") player.speedLevel = Math.min(3, player.speedLevel + 1);
  if (kind === "shield") player.shield = true;
}

export function canWalkTo(state: BomberState, color: PlayerColor, x: number, y: number) {
  if (isWall(x, y) || hasBlock(state, cellIndex(x, y)) || hasBomb(state, cellIndex(x, y))) return false;
  const opponent = color === "black" ? state.players.white : state.players.black;
  return !opponent.alive || opponent.x !== x || opponent.y !== y;
}

export function directionForInput(input: InputState): [number, number] | null {
  if (input.up) return [0, -1];
  if (input.down) return [0, 1];
  if (input.left) return [-1, 0];
  if (input.right) return [1, 0];
  return null;
}

/** Cells covered by one bomb. Blocks absorb the blast, so the cell holding a
 *  block is included but nothing behind it is. */
export function blastCells(state: BomberState, bomb: BombState, flameLength: number) {
  const cells = [cellIndex(bomb.x, bomb.y)];
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dy] of directions) {
    for (let distance = 1; distance <= flameLength; distance += 1) {
      const x = bomb.x + dx * distance;
      const y = bomb.y + dy * distance;
      if (isWall(x, y)) break;
      const index = cellIndex(x, y);
      cells.push(index);
      if (hasBlock(state, index)) break;
    }
  }
  return cells;
}

export function stepHostState(current: BomberState, localInput: InputState, remoteInput: InputState, now: number): BomberState {
  if (current.status !== "playing") return current;
  const next: BomberState = {
    ...current,
    tick: current.tick + 1,
    scores: { ...current.scores },
    blocks: [...current.blocks],
    bombs: current.bombs.map((bomb) => ({ ...bomb })),
    explosions: current.explosions
      .filter((explosion) => explosion.expiresAt > now)
      .map((explosion) => ({ ...explosion, cells: [...explosion.cells] })),
    players: { black: { ...current.players.black }, white: { ...current.players.white } },
    powerups: current.powerups.map((powerup) => ({ ...powerup })),
  };

  for (const color of COLORS) {
    const player = next.players[color];
    const input = color === "black" ? localInput : remoteInput;
    if (!player.alive) continue;
    const direction = directionForInput(input);
    if (direction && now >= player.nextMoveAt) {
      const nextX = player.x + direction[0];
      const nextY = player.y + direction[1];
      if (canWalkTo(next, color, nextX, nextY)) {
        player.x = nextX;
        player.y = nextY;
      }
      player.nextMoveAt = now + moveIntervalFor(player);
    }
    if (input.placeBomb && player.bombsAvailable > 0 && !hasBomb(next, cellIndex(player.x, player.y))) {
      next.bombs.push({ id: `${color}-${next.tick}`, owner: color, x: player.x, y: player.y, explodeAt: now + BOMB_FUSE_MS });
      player.bombsAvailable -= 1;
    }
  }

  // --- detonation, with chaining -------------------------------------------
  // A blast detonates every bomb it covers in the same tick, so a row of bombs
  // goes off as one long chain instead of a staggered ripple.
  const blast = new Set<number>();
  const detonated: BombState[] = [];
  const queue = next.bombs.filter((bomb) => bomb.explodeAt <= now);
  const remainingBlocks = new Set(next.blocks);
  const destroyed: number[] = [];

  while (queue.length > 0) {
    const bomb = queue.shift() as BombState;
    detonated.push(bomb);
    const owner = next.players[bomb.owner];
    owner.bombsAvailable = Math.min(owner.maxBombs, owner.bombsAvailable + 1);
    const cells = blastCells(next, bomb, owner.flameLength);
    next.explosions.push({ cells, expiresAt: now + EXPLOSION_MS });
    for (const index of cells) {
      blast.add(index);
      if (remainingBlocks.delete(index)) destroyed.push(index);
    }
    for (const other of next.bombs) {
      if (detonated.includes(other) || queue.includes(other)) continue;
      if (blast.has(cellIndex(other.x, other.y))) queue.push(other);
    }
  }

  next.bombs = next.bombs.filter((bomb) => !detonated.includes(bomb));
  next.blocks = [...remainingBlocks];
  for (const index of destroyed) dropPowerup(next, index);

  if (blast.size > 0) {
    for (const color of COLORS) {
      const player = next.players[color];
      if (player.alive && blast.has(cellIndex(player.x, player.y))) {
        if (player.shield) player.shield = false;
        else player.alive = false;
      }
    }
  }

  for (const color of COLORS) {
    const player = next.players[color];
    if (!player.alive) continue;
    const pickupIndex = next.powerups.findIndex((powerup) => powerup.x === player.x && powerup.y === player.y);
    if (pickupIndex >= 0) {
      const [pickup] = next.powerups.splice(pickupIndex, 1);
      applyPowerup(player, pickup.kind);
    }
  }

  // --- sudden death ---------------------------------------------------------
  // Two cautious players can otherwise circle each other forever. Once the map
  // starts collapsing there is steadily less cover, so stalling stops paying.
  if (next.tick >= SUDDEN_DEATH_TICKS) {
    next.suddenDeath = true;
    if (next.tick % COLLAPSE_EVERY_TICKS === 0 && next.blocks.length > 0) {
      const [index] = next.blocks.splice(hash(next.seed, next.tick) % next.blocks.length, 1);
      dropPowerup(next, index);
    }
  }

  const alive = COLORS.filter((color) => next.players[color].alive);
  if (alive.length === 1) {
    next.status = "finished";
    next.winner = alive[0];
  } else if (alive.length === 0 && detonated.length > 0) {
    next.status = "finished";
    next.winner = "draw";
  }
  if (next.status === "finished" && next.winner && next.winner !== "draw") next.scores[next.winner] += 1;

  return next;
}

export function normalizeInput(value: unknown): InputState {
  if (!value || typeof value !== "object") return { ...EMPTY_INPUT };
  const input = value as Partial<InputState>;
  return {
    up: Boolean(input.up),
    down: Boolean(input.down),
    left: Boolean(input.left),
    right: Boolean(input.right),
    placeBomb: Boolean(input.placeBomb),
  };
}

export function isBomberState(value: unknown): value is BomberState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<BomberState>;
  return (
    state.version === STATE_VERSION &&
    Boolean(state.players?.black) &&
    Boolean(state.players?.white) &&
    Boolean(state.scores) &&
    Array.isArray(state.blocks) &&
    Array.isArray(state.bombs) &&
    Array.isArray(state.explosions) &&
    Array.isArray(state.powerups)
  );
}
