import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_CELLS,
  COLUMNS,
  ROWS,
  STATE_VERSION,
  applyMove,
  cellIndex,
  createInitialState,
  dropRow,
  isConnect4State,
  legalColumns,
  winningLine,
  type Cell,
  type Connect4State,
  type PlayerColor,
} from "../src/games/connect4-rules.ts";

function ascending(values: number[]) {
  return [...values].sort((a, b) => a - b);
}

/** Plays an alternating script and returns the final state. */
function play(moves: Array<[number, PlayerColor]>) {
  let state = createInitialState(1);
  for (const [column, color] of moves) {
    assert.equal(state.status, "playing", `game ended before the ${color} move in column ${column}`);
    assert.equal(state.turn, color);
    state = applyMove(state, column, color);
  }
  return state;
}

test("discs stack from the bottom and a full column refuses more", () => {
  let state = createInitialState(1);
  for (let i = 0; i < ROWS; i += 1) {
    const color = state.turn;
    state = applyMove(state, 3, color);
    assert.equal(state.board[cellIndex(3, ROWS - 1 - i)], color, `disc ${i} should rest on row ${ROWS - 1 - i}`);
  }
  assert.equal(dropRow(state.board, 3), -1);
  assert.equal(legalColumns(state.board).includes(3), false);
  assert.equal(applyMove(state, 3, state.turn), state, "a full column is not a move");
});

test("out-of-turn, out-of-range and replayed columns are no-ops", () => {
  const state = createInitialState(1);
  assert.equal(applyMove(state, 3, "white"), state, "white cannot open");
  assert.equal(applyMove(state, -1, "black"), state);
  assert.equal(applyMove(state, COLUMNS, "black"), state);
  assert.equal(applyMove(state, 1.5, "black"), state);

  const once = applyMove(state, 3, "black");
  assert.equal(applyMove(once, 3, "black"), once, "black cannot drop twice in a row");
});

test("four across wins", () => {
  const state = play([[0, "black"], [6, "white"], [1, "black"], [6, "white"], [2, "black"], [6, "white"], [3, "black"]]);
  assert.equal(state.winner, "black");
  assert.deepEqual(ascending(state.winningCells), ascending([cellIndex(0, 5), cellIndex(1, 5), cellIndex(2, 5), cellIndex(3, 5)]));
});

test("four stacked wins", () => {
  const state = play([[0, "black"], [1, "white"], [0, "black"], [2, "white"], [0, "black"], [3, "white"], [0, "black"]]);
  assert.equal(state.winner, "black");
  assert.deepEqual(ascending(state.winningCells), ascending([cellIndex(0, 2), cellIndex(0, 3), cellIndex(0, 4), cellIndex(0, 5)]));
});

test("four on a rising diagonal wins", () => {
  const state = play([
    [0, "black"], [1, "white"],
    [1, "black"], [2, "white"],
    [2, "black"], [3, "white"],
    [2, "black"], [3, "white"],
    [3, "black"], [6, "white"],
    [3, "black"],
  ]);
  assert.equal(state.winner, "black");
  assert.deepEqual(ascending(state.winningCells), ascending([cellIndex(0, 5), cellIndex(1, 4), cellIndex(2, 3), cellIndex(3, 2)]));
});

test("four on a falling diagonal wins", () => {
  const state = play([
    [6, "black"], [5, "white"],
    [5, "black"], [4, "white"],
    [4, "black"], [3, "white"],
    [4, "black"], [3, "white"],
    [3, "black"], [0, "white"],
    [3, "black"],
  ]);
  assert.equal(state.winner, "black");
  assert.deepEqual(ascending(state.winningCells), ascending([cellIndex(3, 2), cellIndex(4, 3), cellIndex(5, 4), cellIndex(6, 5)]));
});

test("a full board with no run is a draw", () => {
  // A plain checkerboard will not do: its diagonals are monochrome, so it is
  // full of fours. This 4-periodic stripe changes colour on every horizontal
  // step and at least every second step along all three other axes, so no line
  // of four exists. The loop below is the actual proof.
  const full: Cell[] = Array.from({ length: BOARD_CELLS }, (_, index) => {
    const column = index % COLUMNS;
    const row = Math.floor(index / COLUMNS);
    return (column + row + Math.floor(row / 2)) % 2 === 0 ? "black" : "white";
  });
  for (let index = 0; index < BOARD_CELLS; index += 1) {
    assert.equal(winningLine(full, index, full[index] as PlayerColor), null, `run found at ${index}`);
  }

  // Column 0's top cell is the only hole, so one last drop fills the board.
  const board = full.slice();
  board[cellIndex(0, 0)] = null;
  const state: Connect4State = { ...createInitialState(1), board, turn: "black" };
  const after = applyMove(state, 0, "black");
  assert.equal(after.status, "finished");
  assert.equal(after.winner, "draw");
  assert.deepEqual(after.winningCells, []);
});

test("a finished board is frozen", () => {
  const won = play([[0, "black"], [6, "white"], [1, "black"], [6, "white"], [2, "black"], [6, "white"], [3, "black"]]);
  assert.equal(applyMove(won, 5, "white"), won);
});

test("state validation rejects payloads from another build", () => {
  assert.equal(isConnect4State(createInitialState(1)), true);
  assert.equal(isConnect4State({ ...createInitialState(1), version: 2 }), false);
  assert.equal(isConnect4State({ ...createInitialState(1), board: [] }), false);
  assert.equal(isConnect4State(null), false);
  assert.equal(STATE_VERSION, 1);
});
