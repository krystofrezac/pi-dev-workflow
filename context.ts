/**
 * Context isolation. Pure: no pi imports.
 *
 * An agent sees its first briefing of the workflow, then — when its context has been compacted — the summary and the
 * last `keep` messages from before it, then every message it has had since. A segment of an agent begins at one of
 * its briefings or summaries (custom message markers) and runs to the next marker. The closing note of a workflow is
 * a marker too. Other agents' segments, the chat before the workflow and anything before a closing note are hidden
 * from the model; without markers nothing is hidden. The screen is untouched: this only changes what a request
 * carries.
 */

/** Custom message types. All three act as markers. */
export const BRIEFING_TYPE = "dev-briefing";
export const SUMMARY_TYPE = "dev-summary";
export const END_TYPE = "dev-end";

const MARKERS: ReadonlySet<string> = new Set([BRIEFING_TYPE, SUMMARY_TYPE, END_TYPE]);

/** The agent a briefing or summary was written for: `details.agent` of the custom message, when it is a non-empty string. */
function markerAgent(details: unknown): string | undefined {
	const agent = (details as { agent?: unknown } | null | undefined)?.agent;
	return typeof agent === "string" && agent !== "" ? agent : undefined;
}

/** How many messages from before a summary stay: `details.keep` when it is a non-negative integer, else 0. */
function keepOf(details: unknown): number {
	const keep = (details as { keep?: unknown } | null | undefined)?.keep;
	return typeof keep === "number" && Number.isInteger(keep) && keep >= 0 ? keep : 0;
}

/**
 * The messages the newest marker's agent sees: its first briefing, then — for its newest summary — the summary and the
 * last `keep` messages from before it (an earlier summary is folded into the later one the same way), then everything
 * after it; all of it from the segments of that agent since the last closing note. A marker without a readable agent
 * shows only its own segment. A closing note shows only itself and what follows. No marker → the same array back (a
 * no-op, so ordinary sessions pay nothing); the same array too when nothing is dropped or moved. Stateless, so it is
 * right after `/resume`, `/reload` and `/tree`. Never mutates its input.
 */
export function visibleMessages<M extends { role: string; customType?: string; details?: unknown }>(messages: M[]): M[] {
	const markerType = (m: M): string | undefined =>
		m.role === "custom" && m.customType && MARKERS.has(m.customType) ? m.customType : undefined;

	let newest = messages.length - 1;
	while (newest >= 0 && markerType(messages[newest]) === undefined) newest--;
	if (newest < 0) return messages;

	const agent = markerType(messages[newest]) === END_TYPE ? undefined : markerAgent(messages[newest].details);
	if (agent === undefined) return newest === 0 ? messages : messages.slice(newest);

	const segments: M[][] = [];
	let end = messages.length;
	for (let i = newest; i >= 0; i--) {
		const type = markerType(messages[i]);
		if (type === undefined) continue;
		if (type === END_TYPE) break;
		if (markerAgent(messages[i].details) === agent) segments.push(messages.slice(i, end));
		end = i;
	}
	const chain = segments.reverse().flat();

	/** The newest summary of `list`, the last `keep` messages that came before it, and everything after it. */
	const fold = (list: M[]): M[] => {
		let s = list.length - 1;
		while (s >= 0 && markerType(list[s]) !== SUMMARY_TYPE) s--;
		if (s < 0) return list;
		const prior = fold(list.slice(0, s));
		const keep = Math.min(keepOf(list[s].details), prior.length);
		return [list[s], ...prior.slice(prior.length - keep), ...list.slice(s + 1)];
	};

	const view = markerType(chain[0]) === BRIEFING_TYPE ? [chain[0], ...fold(chain.slice(1))] : fold(chain);
	return view.length === messages.length && view.every((m, i) => m === messages[i]) ? messages : view;
}

/** The part of a session entry `briefedBefore` looks at. */
export interface EntryLike {
	type: string;
	customType?: string;
	details?: unknown;
	message?: { role?: string };
}

/**
 * True when `agent` has a briefing in the current workflow: walking back from the end of the entries, a briefing
 * for that agent turns up before a closing note.
 */
export function briefedBefore(entries: readonly EntryLike[], agent: string): boolean {
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.type !== "custom_message") continue;
		if (e.customType === END_TYPE) return false;
		if (e.customType === BRIEFING_TYPE && markerAgent(e.details) === agent) return true;
	}
	return false;
}
