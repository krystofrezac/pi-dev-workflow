import assert from "node:assert/strict";
import { test } from "node:test";
import { createWaiting, type Shown, shouldWait } from "./waiting.ts";

test("shouldWait: only for an active workflow and a completed, non-aborted run", () => {
	assert.equal(shouldWait({ active: true, aborted: false, outcome: "completed" }), true);
	assert.equal(shouldWait({ active: false, aborted: false, outcome: "completed" }), false);
	assert.equal(shouldWait({ active: true, aborted: true, outcome: "completed" }), false);
	assert.equal(shouldWait({ active: true, aborted: false, outcome: "aborted" }), false);
	assert.equal(shouldWait({ active: true, aborted: false, outcome: "error" }), false);
	assert.equal(shouldWait({ active: true, aborted: false, outcome: undefined }), false);
});

/** A `show` that counts what it opened and closed; `end()` closes the overlay the way pi does on its own. */
function fakeOverlay() {
	const log = { opened: 0, closed: 0 };
	let end = () => {};
	const show = (): Shown => {
		log.opened++;
		return {
			close: () => {
				log.closed++;
				end();
			},
			closed: new Promise<void>((resolve) => {
				end = resolve;
			}),
		};
	};
	return { log, show, end: () => end() };
}

test("createWaiting: opens one overlay, however often it is asked", () => {
	const waiting = createWaiting();
	const overlay = fakeOverlay();
	waiting.open(overlay.show);
	waiting.open(overlay.show);
	assert.deepEqual(overlay.log, { opened: 1, closed: 0 });
});

test("createWaiting: close closes the open overlay once; closing without one is a no-op", () => {
	const waiting = createWaiting();
	const overlay = fakeOverlay();
	waiting.close();
	waiting.open(overlay.show);
	waiting.close();
	waiting.close();
	assert.deepEqual(overlay.log, { opened: 1, closed: 1 });
});

test("createWaiting: it opens again after a close", () => {
	const waiting = createWaiting();
	const overlay = fakeOverlay();
	waiting.open(overlay.show);
	waiting.close();
	waiting.open(overlay.show);
	assert.deepEqual(overlay.log, { opened: 2, closed: 1 });
});

test("createWaiting: an overlay closed from outside does not block the next one", async () => {
	const waiting = createWaiting();
	const overlay = fakeOverlay();
	waiting.open(overlay.show);
	overlay.end();
	await Promise.resolve();
	waiting.open(overlay.show);
	assert.equal(overlay.log.opened, 2);
});
