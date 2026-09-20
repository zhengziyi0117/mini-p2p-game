/** Pure Connect Four rules. No React, no DOM. Like the other turn-based
 *  games, both peers replay the same column list and never send the board. */

export const COLUMNS = 7;
export const ROWS = 6;
export const BOARD_CELLS = COLUMNS * ROWS;
export const STATE_VERSION = 1;

export type PlayerColor = "black" | "white";
export type Cell = PlayerColor | null;

export type Connect4State = {
  version: typeof STATE_VERSION;
  roundId: number;
  /** Row 0 is the top row, so a disc "falls" toward higher indices. */
  board: Cell[];
  turn: PlayerColor;
  status: "playing" | "finished";
  winner: PlayerColor | "draw" | null;
  lastMove: number | null;
  /** The run that ended the game, for the winning highlight. */
  winningCells: number[];
};

const DIRECTIONS = [[1, 0], [0, 1], [1, 1], [1, -1]] as const;

export function cellIndex(column: number, row: number) {
  return row * COLUMNS + column;
}

export function opponentOf(color: PlayerColor): PlayerColor {
  return color === "black" ? "white" : "black";
}

/** Lowest empty row of a column, or -1 when the column is full. */
export function dropRow(board: Cell[], column: number): number {
  if (!Number.isInteger(column) || column < 0 || column >= COLUMNS) return -1;
  for (let row = ROWS - 1; row >= 0; row -= 1) {
    if (board[cellIndex(column, row)] === null) return row;
  }
  return -1;
}

export function legalColumns(board: Cell[]): number[] {
  const columns: number[] = [];
  for (let column = 0; column < COLUMNS; column += 1) {
    if (dropRow(board, column) >= 0) columns.push(column);
  }
  return columns;
}

/** The connected run through `index`, when it reaches four or more. */
export function winningLine(board: Cell[], index: number, color: PlayerColor): number[] | null {
  const column = index % COLUMNS;
  const row = Math.floor(index / COLUMNS);
  for (const [dx, dy] of DIRECTIONS) {
    const line = [index];
    for (const sign of [1, -1]) {
      let nextColumn = column + dx * sign;
      let nextRow = row + dy * sign;
      while (
        nextColumn >= 0 && nextColumn < COLUMNS &&
        nextRow >= 0 && nextRow < ROWS &&
        board[cellIndex(nextColumn, nextRow)] === color
      ) {
        line.push(cellIndex(nextColumn, nextRow));
        nextColumn += dx * sign;
        nextRow += dy * sign;
      }
    }
    if (line.length >= 4) return line;
  }
  return null;
}

export function createInitialState(roundId: number): Connect4State {
  return {
    version: STATE_VERSION,
    roundId,
    board: Array.from({ length: BOARD_CELLS }, () => null),
    turn: "black",
    status: "playing",
    winner: null,
    lastMove: null,
    winningCells: [],
  };
}

/** Drops one disc. Gravity means the only choice is the column, so an illegal
 *  or replayed column simply returns the state untouched. */
export function applyMove(state: Connect4State, column: number, color: PlayerColor): Connect4State {
  if (state.status !== "playing" || state.turn !== color) return state;
  const row = dropRow(state.board, column);
  if (row < 0) return state;

  const board = state.board.slice();
  const index = cellIndex(column, row);
  board[index] = color;

  const line = winningLine(board, index, color);
  if (line) {
    return { ...state, board, status: "finished", winner: color, lastMove: index, winningCells: line };
  }
  if (board.every((cell) => cell !== null)) {
    return { ...state, board, status: "finished", winner: "draw", lastMove: index, winningCells: [] };
  }
  return { ...state, board, turn: opponentOf(color), lastMove: index, winningCells: [] };
}

export function columnHeight(board: Cell[], column: number) {
  let count = 0;
  for (let row = 0; row < ROWS; row += 1) {
    if (board[cellIndex(column, row)] !== null) count += 1;
  }
  return count;
}

export function isConnect4State(value: unknown): value is Connect4State {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<Connect4State>;
  return state.version === STATE_VERSION && Array.isArray(state.board) && state.board.length === BOARD_CELLS;
}
