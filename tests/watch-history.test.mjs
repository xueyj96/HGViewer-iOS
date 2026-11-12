import assert from "node:assert/strict";
import { addHistory, HISTORY_LIMIT, normalizeHistory, restoreHistory } from "../src/watchHistory.ts";

const entry = (id, at, ep = 1, t = 0, dur = 0) => ({ id, ep, t, dur, at });

assert.equal(HISTORY_LIMIT, 80);
assert.deepEqual(normalizeHistory(null, 100), []);
assert.deepEqual(normalizeHistory([5, { id: 6, ep: 3, t: 12, dur: 40, at: 80 }], 100), [
  entry(5, 100), entry(6, 80, 3, 12, 40),
]);
assert.deepEqual(normalizeHistory([
  { id: 2, ep: 1, t: 10, dur: 20, at: 30 },
  { id: 2, ep: 4, t: 50, dur: 60, at: 40 },
  { id: 3, ep: 0, t: -1, dur: "bad", at: 0 },
  { id: -1 }, { id: 4.2 }, null,
], 100), [
  entry(3, 98), entry(2, 40, 4, 50, 60),
]);

const original = [entry(1, 30, 2, 18, 50), entry(2, 20, 1, 9, 30)];
assert.deepEqual(addHistory(original, 1, undefined, undefined, undefined, 40), [
  entry(1, 40, 2, 18, 50), original[1],
]);
assert.deepEqual(addHistory(original, 1, 3, undefined, undefined, 40), [
  entry(1, 40, 3, 0, 0), original[1],
]);
assert.deepEqual(addHistory(original, 3, undefined, 7, 14, 40), [
  entry(3, 40, 1, 7, 14), ...original,
]);
assert.equal(restoreHistory(original, entry(1, 99)), original);
assert.deepEqual(restoreHistory(original, entry(3, 25)), [original[0], entry(3, 25), original[1]]);

const many = Array.from({ length: HISTORY_LIMIT }, (_, index) => entry(index + 1, HISTORY_LIMIT - index));
assert.equal(addHistory(many, 81, 1, 0, 0, 100).length, HISTORY_LIMIT);
assert.equal(addHistory(many, 81, 1, 0, 0, 100).at(-1).id, HISTORY_LIMIT - 1);
assert.equal(restoreHistory(many, entry(81, 100)).length, HISTORY_LIMIT);
assert.equal(restoreHistory(many, entry(81, 100))[0].id, 81);
assert.equal(normalizeHistory([...many, entry(81, 100)], 100).length, HISTORY_LIMIT);

console.log("watch-history policy: 14 assertions passed");
