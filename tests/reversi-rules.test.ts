import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_CELLS,
  STATE_VERSION,
  applyMove,
  cellIndex,
  countPieces,
  createInitialBoard,
  createInitialState,
  flipsFor,
  isReversiState,
  legalMoves,
  opponentPassed,
  type Cell,
  type ReversiState,
} from "../src/games/reversi-rules.ts";

function ascending(values: number[]) {
  return [...values].sort((a, b) => a - b);
}

function boardWith(discs: Array<[number, number, "black" | "white"]>): Cell[] {
  const board: Cell[] = Array.from({ length: BOARD_CELLS }, () => null);
  for (const [x, y, color] of discs) board[cellIndex(x, y)] = color;
  return board;
}

function stateWith(board: Cell[], turn: "black" | "white" = "black"): ReversiState {
  return { version: STATE_VERSION, roundId: 1, board, turn, status: "playing", winner: null, lastMove: null };
}

test("the opening position is the standard four discs with four replies for black", () => {
  const board = createInitialBoard();
  assert.deepEqual(countPieces(board), { black: 2, white: 2 });
  assert.deepEqual(legalMoves(board, "black"), [cellIndex(3, 2), cellIndex(2, 3), cellIndex(5, 4), cellIndex(4, 5)]);
  assert.deepEqual(legalMoves(board, "white"), [cellIndex(4, 2), cellIndex(5, 3), cellIndex(2, 4), cellIndex(3, 5)]);
});

test("one disc can flip in all eight directions at once", () => {
  const board: Cell[] = Array.from({ length: BOARD_CELLS }, () => null);
  const directions = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]] as const;
  const sandwiched: number[] = [];
  for (const [dx, dy] of directions) {
    board[cellIndex(4 + dx, 4 + dy)] = "white";
    sandwiched.push(cellIndex(4 + dx, 4 + dy));
    board[cellIndex(4 + dx * 2, 4 + dy * 2)] = "black";
  }

  const flips = flipsFor(board, cellIndex(4, 4), "black");
  assert.equal(flips.length, 8, "a run must be found on every axis");
  assert.deepEqual(ascending(flips), ascending(sandwiched));
});

test("a run only flips when one of our own discs closes the far end", () => {
  // Two white discs with nothing behind them: the line never closes.
  const open = boardWith([[4, 4, "white"], [5, 4, "white"]]);
  assert.deepEqual(flipsFor(open, cellIndex(3, 4), "black"), []);

  const closed = boardWith([[4, 4, "white"], [5, 4, "white"], [6, 4, "black"]]);
  assert.deepEqual(flipsFor(closed, cellIndex(3, 4), "black"), [cellIndex(4, 4), cellIndex(5, 4)]);
});

test("duplicate, out-of-turn and illegal moves leave the board untouched", () => {
  const state = createInitialState(1);
  assert.equal(applyMove(state, cellIndex(0, 0), "black"), state, "a disc that flips nothing is not a move");
  assert.equal(applyMove(state, cellIndex(3, 2), "white"), state, "white cannot move first");

  const once = applyMove(state, cellIndex(3, 2), "black");
  assert.notEqual(once, state);
  assert.equal(once.board[cellIndex(3, 3)], "black", "the sandwiched white disc flipped");
  assert.equal(applyMove(once, cellIndex(3, 2), "black"), once, "the same move cannot be replayed");
});

test("a side with no legal move passes instead of ending the game", () => {
  // White sits behind black in both corners, so every white reply is blocked;
  // black can still flip either pair.
  const board = boardWith([[0, 0, "black"], [1, 0, "white"], [0, 5, "black"], [1, 5, "white"]]);
  assert.deepEqual(legalMoves(board, "white"), []);
  assert.deepEqual(legalMoves(board, "black"), [cellIndex(2, 0), cellIndex(2, 5)]);

  const after = applyMove(stateWith(board), cellIndex(2, 0), "black");
  assert.equal(after.status, "playing", "a pass must not end the game");
  assert.equal(after.turn, "black", "the turn comes straight back to black");
  assert.equal(opponentPassed(after, "black"), true);
  assert.equal(after.board[cellIndex(1, 0)], "black");
});

test("a full game always leaves the side to move with a legal move, and scores its own board", () => {
  let state = createInitialState(1);
  let played = 0;
  while (state.status === "playing" && played < 200) {
    const moves = legalMoves(state.board, state.turn);
    assert.ok(moves.length > 0, `no reply for ${state.turn} after ${played} moves`);
    state = applyMove(state, moves[0], state.turn);
    played += 1;
  }

  assert.equal(state.status, "finished", "always taking the first reply must still terminate");
  const pieces = countPieces(state.board);
  assert.equal(pieces.black + pieces.white, 4 + played, "every move adds exactly one disc");
  const expected = pieces.black === pieces.white ? "draw" : pieces.black > pieces.white ? "black" : "white";
  assert.equal(state.winner, expected);
});

test("a finished board is frozen", () => {
  const board = boardWith([[0, 0, "black"], [1, 0, "white"]]);
  const finished: ReversiState = { ...stateWith(board), status: "finished", winner: "black" };
  assert.equal(applyMove(finished, cellIndex(2, 0), "black"), finished);
});

test("state validation rejects payloads from another build", () => {
  assert.equal(isReversiState(createInitialState(1)), true);
  assert.equal(isReversiState({ ...createInitialState(1), version: 2 }), false);
  assert.equal(isReversiState({ ...createInitialState(1), board: [] }), false);
  assert.equal(isReversiState(null), false);
});
