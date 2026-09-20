/** Pure Reversi (Othello) rules. No React, no DOM. Both peers replay the same
 *  move list, so the board itself never has to cross the wire. */

export const BOARD_SIZE = 8;
export const BOARD_CELLS = BOARD_SIZE * BOARD_SIZE;
export const STATE_VERSION = 1;

export type PlayerColor = "black" | "white";
export type Cell = PlayerColor | null;

export type ReversiState = {
  version: typeof STATE_VERSION;
  roundId: number;
  board: Cell[];
  turn: PlayerColor;
  status: "playing" | "finished";
  winner: PlayerColor | "draw" | null;
  lastMove: number | null;
};

const DIRECTIONS = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1], [0, 1],
  [1, -1], [1, 0], [1, 1],
] as const;

export function cellIndex(x: number, y: number) {
  return y * BOARD_SIZE + x;
}

export function opponentOf(color: PlayerColor): PlayerColor {
  return color === "black" ? "white" : "black";
}

/** The opening position: four discs in the middle, white on the a1–h8 diagonal. */
export function createInitialBoard(): Cell[] {
  const board: Cell[] = Array.from({ length: BOARD_CELLS }, () => null);
  board[cellIndex(3, 3)] = "white";
  board[cellIndex(3, 4)] = "black";
  board[cellIndex(4, 3)] = "black";
  board[cellIndex(4, 4)] = "white";
  return board;
}

/** Discs that would flip if `color` played `index`. Empty means the move is
 *  illegal, which is the only validity rule this game has. */
export function flipsFor(board: Cell[], index: number, color: PlayerColor): number[] {
  if (index < 0 || index >= BOARD_CELLS || board[index] !== null) return [];
  const x = index % BOARD_SIZE;
  const y = Math.floor(index / BOARD_SIZE);
  const other = opponentOf(color);
  const flips: number[] = [];

  for (const [dx, dy] of DIRECTIONS) {
    const line: number[] = [];
    let cx = x + dx;
    let cy = y + dy;
    while (cx >= 0 && cx < BOARD_SIZE && cy >= 0 && cy < BOARD_SIZE && board[cellIndex(cx, cy)] === other) {
      line.push(cellIndex(cx, cy));
      cx += dx;
      cy += dy;
    }
    // A run of enemy discs only flips when one of ours closes the far end.
    if (line.length && cx >= 0 && cx < BOARD_SIZE && cy >= 0 && cy < BOARD_SIZE && board[cellIndex(cx, cy)] === color) {
      flips.push(...line);
    }
  }
  return flips;
}

export function legalMoves(board: Cell[], color: PlayerColor): number[] {
  const moves: number[] = [];
  for (let index = 0; index < BOARD_CELLS; index += 1) {
    if (flipsFor(board, index, color).length) moves.push(index);
  }
  return moves;
}

export function countPieces(board: Cell[]): Record<PlayerColor, number> {
  let black = 0;
  let white = 0;
  for (const cell of board) {
    if (cell === "black") black += 1;
    else if (cell === "white") white += 1;
  }
  return { black, white };
}

export function createInitialState(roundId: number): ReversiState {
  return {
    version: STATE_VERSION,
    roundId,
    board: createInitialBoard(),
    turn: "black",
    status: "playing",
    winner: null,
    lastMove: null,
  };
}

/** Applies one move and hands the turn over. A player with no legal move passes
 *  automatically; when neither side can move the game is scored and frozen.
 *  Illegal moves — duplicates, replays, stale rounds — return the state as-is. */
export function applyMove(state: ReversiState, index: number, color: PlayerColor): ReversiState {
  if (state.status !== "playing" || state.turn !== color) return state;
  const flips = flipsFor(state.board, index, color);
  if (!flips.length) return state;

  const board = state.board.slice();
  board[index] = color;
  for (const flip of flips) board[flip] = color;

  let turn = opponentOf(color);
  if (!legalMoves(board, turn).length) {
    if (!legalMoves(board, color).length) {
      const pieces = countPieces(board);
      const winner: PlayerColor | "draw" =
        pieces.black === pieces.white ? "draw" : pieces.black > pieces.white ? "black" : "white";
      return { ...state, board, turn, status: "finished", winner, lastMove: index };
    }
    turn = color;
  }
  return { ...state, board, turn, lastMove: index };
}

/** True when the turn just came back to `color`, i.e. the opponent had to pass. */
export function opponentPassed(state: ReversiState, color: PlayerColor) {
  return state.status === "playing" && state.turn === color && state.lastMove !== null;
}

export function isReversiState(value: unknown): value is ReversiState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<ReversiState>;
  return state.version === STATE_VERSION && Array.isArray(state.board) && state.board.length === BOARD_CELLS;
}
