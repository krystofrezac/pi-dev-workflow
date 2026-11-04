/**
 * Context size and cost, read from the session record. Pure: no pi imports.
 *
 * Two numbers: how full the active agent's context is (`agentContextTokens`) and what the whole workflow has
 * cost so far (`workflowTotals`). Plus the text formats the bar and the closing banner share.
 *
 * Session files are not validated, so every type here is structural and tolerant: a missing or non-numeric
 * number counts as 0, an unknown shape counts as nothing.
 */

import { BRIEFING_TYPE, SUMMARY_TYPE } from "./context.ts";
import { STATE_ENTRY } from "./machine.ts";

/** Sum of everything the workflow's responses used. */
export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export const emptyTotals = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

/** What a provider reported for one response (the part read here). */
interface UsageLike {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	totalTokens?: unknown;
	cost?: { total?: unknown };
}

/** The part of a session entry read here. */
export interface UsageEntry {
	type: string;
	customType?: string;
	data?: unknown;
	content?: unknown;
	details?: unknown;
	usage?: UsageLike;
	message?: { role?: string; usage?: UsageLike; stopReason?: string; content?: unknown };
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

// ───────────────────────────── workflow totals ─────────────────────────────

/** The workflow id of a `dev-state` entry; `null` for any other entry; `undefined` when its data names no workflow. */
function stateId(entry: UsageEntry): string | null | undefined {
	if (entry.type !== "custom" || entry.customType !== STATE_ENTRY) return null;
	const data = entry.data as { id?: unknown } | null | undefined;
	return data && typeof data === "object" && typeof data.id === "string" ? data.id : undefined;
}

/**
 * Where this workflow starts in the branch. Ids are reused (an emptied `.pi/dev/` hands out `0001` again), so: the
 * newest `dev-state` entry with this id, then back through the run of same-id `dev-state` entries before it. The first
 * `dev-state` entry that is a "no workflow" marker, names another id or is unreadable ends the walk.
 */
function startOf(entries: readonly UsageEntry[], workflowId: string): number {
	let start = -1;
	let i = entries.length - 1;
	for (; i >= 0; i--) {
		if (stateId(entries[i]) === workflowId) {
			start = i;
			break;
		}
	}
	if (start < 0) return -1;
	for (i = start - 1; i >= 0; i--) {
		const id = stateId(entries[i]);
		if (id === null) continue; // not a `dev-state` entry
		if (id !== workflowId) break;
		start = i;
	}
	return start;
}

/**
 * What an entry cost: the usage pi's own footer adds up (responses, `usage` entries, tool results, compaction / branch
 * summaries) and the usage of an agent's context summary (`details.usage` of a `dev-summary` message).
 */
function usageOf(entry: UsageEntry): UsageLike | undefined {
	switch (entry.type) {
		case "message":
			return entry.message?.role === "assistant" || entry.message?.role === "toolResult" ? entry.message.usage : undefined;
		case "usage":
		case "compaction":
		case "branch_summary":
			return entry.usage;
		case "custom_message":
			return entry.customType === SUMMARY_TYPE ? (entry.details as { usage?: UsageLike } | null | undefined)?.usage : undefined;
		default:
			return undefined;
	}
}

/** Everything the workflow cost: the sum over the branch after the start of workflow `workflowId`. No such workflow → zeros. */
export function workflowTotals(entries: readonly UsageEntry[], workflowId: string): UsageTotals {
	const totals = emptyTotals();
	const start = startOf(entries, workflowId);
	if (start < 0) return totals;
	for (let i = start + 1; i < entries.length; i++) {
		const usage = usageOf(entries[i]);
		if (!usage || typeof usage !== "object") continue;
		totals.input += num(usage.input);
		totals.output += num(usage.output);
		totals.cacheRead += num(usage.cacheRead);
		totals.cacheWrite += num(usage.cacheWrite);
		totals.cost += num(usage.cost?.total);
	}
	return totals;
}

// ───────────────────────────── agent context ─────────────────────────────

/** What a provider's usage says the context held: the reported total, or the four parts when that is 0 (pi's rule). */
function reportedTokens(usage: UsageLike): number {
	return num(usage.totalTokens) || num(usage.input) + num(usage.output) + num(usage.cacheRead) + num(usage.cacheWrite);
}

/**
 * How many tokens the active agent's context holds: what the provider reported for the agent's newest valid answer
 * plus `estimate` of everything added since (tool results, replies). The way pi sizes its own figure. `estimate` is
 * pi's `estimateTokens`, typed `never` so that pi's own message type fits.
 *
 * `undefined` while the agent has not answered yet: the walk ends at the newest briefing or summary, and at a pi
 * compaction (an answer from before it is stale). A valid answer is not aborted, not an error, and has a token count above 0.
 */
export function agentContextTokens(entries: readonly UsageEntry[], estimate: (message: never) => number): number | undefined {
	const safe = (message: unknown): number => {
		try {
			return num(estimate(message as never));
		} catch {
			return 0; // an unknown shape counts as nothing
		}
	};
	let added = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "compaction") return undefined;
		if (entry.type === "custom_message") {
			if (entry.customType === BRIEFING_TYPE || entry.customType === SUMMARY_TYPE) return undefined;
			added += safe({ role: "custom", content: entry.content });
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const message = entry.message;
		if (message.role === "assistant" && message.stopReason !== "aborted" && message.stopReason !== "error" && message.usage) {
			const tokens = reportedTokens(message.usage);
			if (tokens > 0) return tokens + added;
		}
		added += safe(message);
	}
	return undefined;
}

// ───────────────────────────── "no price" ─────────────────────────────

/** The price per million tokens a model declares (the part read here). */
export interface PriceRates {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
}

/**
 * "No price": nothing has cost money yet **and** the model declares no price, so `$0.000` would read as "free" when it
 * only means "unknown". The one place this is decided.
 */
export function isNoPrice(cost: number, rates: PriceRates | undefined): boolean {
	if (cost !== 0) return false;
	return !([rates?.input, rates?.output, rates?.cacheRead, rates?.cacheWrite] as unknown[]).some((rate) => num(rate) > 0);
}

// ───────────────────────────── formats ─────────────────────────────

const nonNegative = (value: unknown): number => {
	const n = num(value);
	return Math.max(n, 0);
};

const oneDecimal = (value: number): string => (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "");

/** `999`, `12.3k`, `5k`, `150k`, `1.2M`. A value that rounds into the next range uses that range's format (`100k`, `1M`). */
export function formatTokens(value: number): string {
	const n = nonNegative(value);
	if (Math.round(n) < 1000) return String(Math.round(n));
	const k = n / 1000;
	if (Math.round(k * 10) / 10 < 100) return `${oneDecimal(k)}k`;
	if (Math.round(k) < 1000) return `${Math.round(k)}k`;
	return `${oneDecimal(n / 1_000_000)}M`;
}

/** `6%`. */
export const formatPercent = (percent: number): string => `${Math.round(nonNegative(percent))}%`;

/** `$0.087`, like pi's footer. */
export const formatCost = (cost: number): string => `$${nonNegative(cost).toFixed(3)}`;

/** The pieces of the context item: the bar styles the label and the value separately. */
export interface ContextParts {
	/** `agent ctx ` (with its trailing space). */
	label: string;
	/** `12.3k/200k · 6%`, or `12.3k` when the window is unknown. */
	value: string;
	/** Unrounded, for the warning thresholds; `undefined` when the window is unknown. */
	percent?: number;
}

const CONTEXT_LABEL = "agent ctx ";

export function contextParts(context: { tokens: number; window?: number }): ContextParts {
	const tokens = nonNegative(context.tokens);
	const window = nonNegative(context.window);
	if (window === 0) return { label: CONTEXT_LABEL, value: formatTokens(tokens) };
	const percent = (tokens / window) * 100;
	return { label: CONTEXT_LABEL, value: `${formatTokens(tokens)}/${formatTokens(window)} · ${formatPercent(percent)}`, percent };
}

/** `agent ctx 12.3k/200k · 6%`, or `agent ctx 12.3k` when the window is unknown. */
export function contextText(context: { tokens: number; window?: number }): string {
	const { label, value } = contextParts(context);
	return label + value;
}

/** `workflow $0.087` / `workflow no price`. */
export const workflowText = (cost: number, noPrice: boolean): string => `workflow ${noPrice ? "no price" : formatCost(cost)}`;

/** The closing banner's lines: `Cost: …`, then `Tokens: …` with the non-zero parts (no line when all four are 0). */
export function summaryLines(totals: UsageTotals, noPrice: boolean): string[] {
	const lines = [`Cost: ${noPrice ? "no price" : formatCost(totals.cost)}`];
	const parts = [
		[totals.input, "in"],
		[totals.output, "out"],
		[totals.cacheRead, "cache read"],
		[totals.cacheWrite, "cache write"],
	] as const;
	const shown = parts.filter(([n]) => nonNegative(n) > 0).map(([n, name]) => `${formatTokens(n)} ${name}`);
	if (shown.length > 0) lines.push(`Tokens: ${shown.join(" · ")}`);
	return lines;
}
