/**
 * While an agent waits for the user (it ended its turn without handing over), the terminal is told that pi is
 * blocked on input. pi has no call for that: it reports `blocked` while an overlay opened with the `blocked` option
 * is open, so `createWaiting` keeps one such overlay open for as long as the agent waits. Opening and closing it is
 * left to the caller (`show`), so the rules here stay testable without a terminal.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type TurnOutcome = "completed" | "aborted" | "error";

/** An agent waits for the user when a workflow is active and the run ended after a completed turn that was not aborted. */
export function shouldWait(run: { active: boolean; aborted: boolean; outcome: TurnOutcome | undefined }): boolean {
	return run.active && !run.aborted && run.outcome === "completed";
}

/** What `show` returns: how to close the overlay, and a promise that settles once it is closed (by anyone). */
export interface Shown {
	close: () => void;
	closed: Promise<unknown>;
}

export interface Waiting {
	/** Open the overlay unless one is open already. */
	open: (show: () => Shown) => void;
	/** Close the overlay; a no-op when none is open. */
	close: () => void;
}

export function createWaiting(): Waiting {
	let shown: Shown | undefined;
	return {
		open(show) {
			if (shown) return;
			const mine = show();
			shown = mine;
			// An overlay pi closed by itself must not block the next one.
			void mine.closed.then(() => {
				if (shown === mine) shown = undefined;
			});
		},
		close() {
			const mine = shown;
			shown = undefined;
			mine?.close();
		},
	};
}

/** An invisible overlay that never takes the keyboard and makes pi report `blocked` until it is closed. */
export function showWaitingOverlay(ctx: ExtensionContext, message: string): Shown {
	let done: (() => void) | undefined;
	const closed = ctx.ui.custom<void>(
		(_tui, _theme, _keybindings, finish) => {
			done = () => finish();
			return { render: () => [], invalidate: () => {} };
		},
		{
			overlay: true,
			overlayOptions: { nonCapturing: true },
			// Hidden at once, so it never draws; pi keeps reporting `blocked` for a hidden overlay.
			onHandle: (handle) => handle.setHidden(true),
			blocked: { kind: "question", message },
		},
	);
	return {
		close: () => done?.(),
		closed,
	};
}
