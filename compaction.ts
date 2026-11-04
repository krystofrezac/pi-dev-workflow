/**
 * The pure parts of compacting one agent's context. No pi imports: pi's functions (`findCutPoint`, `estimateTokens`)
 * and its defaults come in as parameters.
 *
 * pi compacts the whole session and redraws the chat from the summary, so while a workflow runs the extension
 * compacts the active agent itself. The agent's own older conversation becomes a `dev-summary` message; the agent
 * keeps its first briefing, the summary and its most recent messages (`context.ts` builds that view). This file
 * decides what is summarised, what is kept, what the summary message says and how its banner reads.
 */

import { BRIEFING_TYPE, SUMMARY_TYPE, visibleMessages } from "./context.ts";
import type { Agent } from "./machine.ts";
import { formatCost, formatTokens } from "./usage.ts";

/** What the provider reported for the summary request(s). */
export interface SummaryUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

/** `details` of a `dev-summary` message. */
export interface SummaryDetails {
	agent: Agent;
	/** How many of the agent's messages from before the summary stay (the pinned briefing excluded). */
	keep: number;
	/** The summary text exactly as the summariser returned it, file lists included. */
	summary: string;
	readFiles: string[];
	modifiedFiles: string[];
	/** The agent's measured context size before the compaction. */
	tokensBefore: number;
	/** An estimate of the agent's context right after, on the same basis as `tokensBefore`. */
	tokensAfter: number;
	usage?: SummaryUsage;
	/** The model declares no price and the summary cost 0, so the banner says "no price". */
	noPrice: boolean;
}

/** pi's compaction settings. */
export interface CompactionConfig {
	enabled: boolean;
	reserveTokens: number;
	keepRecentTokens: number;
}

/** A message the way the context hook sees it. */
export interface ViewMessage {
	role: string;
	customType?: string;
	details?: unknown;
}

/** What pi's `findCutPoint` answers. */
export interface CutPoint {
	firstKeptEntryIndex: number;
	turnStartIndex: number;
	isSplitTurn: boolean;
}

/** pi's `findCutPoint`, over entries that are `{ type: "message", message }`. Typed `never` so that pi's own entry type fits. */
export type FindCutPoint = (entries: never[], startIndex: number, endIndex: number, keepRecentTokens: number) => CutPoint;

/** The file lists of an earlier summary. */
export interface PreviousFiles {
	readFiles: string[];
	modifiedFiles: string[];
}

/** The file operations `compact()` takes. */
export interface FileOps {
	read: Set<string>;
	written: Set<string>;
	edited: Set<string>;
}

/** What to summarise and what to keep. */
export interface CompactionPlan<M> {
	/** The agent's first briefing, which stays as it is. */
	pin: M;
	previousSummary?: string;
	previousFiles?: PreviousFiles;
	messagesToSummarize: M[];
	turnPrefixMessages: M[];
	isSplitTurn: boolean;
	/** The most recent messages, which stay as they are. */
	kept: M[];
	keep: number;
}

const isTokenCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

/**
 * pi's effective compaction settings. `raw` is the settings object (unknown shape). Each token field is the model's
 * override (`compaction.modelOverrides["<provider>/<id>"]`), else the ordinary value, else the default; a value that
 * is not a non-negative safe integer is skipped.
 */
export function compactionSettings(
	raw: unknown,
	model: { provider: string; id: string } | undefined,
	defaults: CompactionConfig,
): CompactionConfig {
	const compaction = record(record(raw)?.compaction);
	const override = model ? record(record(compaction?.modelOverrides)?.[`${model.provider}/${model.id}`]) : undefined;
	const pick = (field: "reserveTokens" | "keepRecentTokens"): number => {
		const fromModel = override?.[field];
		if (isTokenCount(fromModel)) return fromModel;
		const ordinary = compaction?.[field];
		if (isTokenCount(ordinary)) return ordinary;
		return defaults[field];
	};
	const enabled = compaction?.enabled;
	return {
		enabled: typeof enabled === "boolean" ? enabled : defaults.enabled,
		reserveTokens: pick("reserveTokens"),
		keepRecentTokens: pick("keepRecentTokens"),
	};
}

/**
 * What the active agent has in its context: the messages the `context` hook shows. pi's session projection also holds
 * `system` messages (the tool declarations after every briefing) that the hook never receives, so they are left out;
 * `keep` then counts the same messages here and in the hook.
 */
export function agentView<M extends ViewMessage>(messages: M[]): M[] {
	return visibleMessages(messages.filter((m) => m.role !== "system"));
}

const isMarker = (message: ViewMessage | undefined, type: string): boolean => message?.role === "custom" && message.customType === type;

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/**
 * Where to cut `view` (the agent's context, `agentView`): the older conversation to summarise and the recent messages to
 * keep. Follows pi's own preparation: an earlier summary right after the pinned briefing is the previous summary and
 * is not summarised again. `undefined` when there is no pinned briefing or nothing lies before the kept messages.
 */
export function planCompaction<M extends ViewMessage>(
	view: readonly M[],
	options: { keepRecentTokens: number; findCutPoint: FindCutPoint },
): CompactionPlan<M> | undefined {
	const pin = view[0];
	if (!isMarker(pin, BRIEFING_TYPE)) return undefined;
	const rest = view.slice(1);

	let boundaryStart = 0;
	let previousSummary: string | undefined;
	let previousFiles: PreviousFiles | undefined;
	if (isMarker(rest[0], SUMMARY_TYPE)) {
		boundaryStart = 1;
		const details = record(rest[0].details);
		if (typeof details?.summary === "string") previousSummary = details.summary;
		previousFiles = { readFiles: stringList(details?.readFiles), modifiedFiles: stringList(details?.modifiedFiles) };
	}

	const entries = rest.map((message) => ({ type: "message", message }));
	const cut = options.findCutPoint(entries as never[], boundaryStart, rest.length, options.keepRecentTokens);
	const historyEnd = cut.isSplitTurn ? cut.turnStartIndex : cut.firstKeptEntryIndex;
	const messagesToSummarize = rest.slice(boundaryStart, historyEnd);
	const turnPrefixMessages = cut.isSplitTurn ? rest.slice(cut.turnStartIndex, cut.firstKeptEntryIndex) : [];
	if (messagesToSummarize.length === 0 && turnPrefixMessages.length === 0) return undefined;

	const kept = rest.slice(cut.firstKeptEntryIndex);
	return {
		pin,
		...(previousSummary === undefined ? {} : { previousSummary }),
		...(previousFiles === undefined ? {} : { previousFiles }),
		messagesToSummarize,
		turnPrefixMessages,
		isSplitTurn: cut.isSplitTurn,
		kept,
		keep: kept.length,
	};
}

/**
 * The files the summarised messages read, wrote and edited, the way pi lists them: tool calls of assistant messages
 * and the calls recorded on tool results (made from codemode scripts) named `read`, `write` or `edit` with a string
 * `path`. The file lists of an earlier summary are carried over (`read` and `edited`).
 */
export function collectFileOps(
	messagesToSummarize: readonly unknown[],
	turnPrefixMessages: readonly unknown[],
	previousFiles?: PreviousFiles,
): FileOps {
	const ops: FileOps = { read: new Set(), written: new Set(), edited: new Set() };
	for (const file of previousFiles?.readFiles ?? []) ops.read.add(file);
	for (const file of previousFiles?.modifiedFiles ?? []) ops.edited.add(file);

	const add = (name: unknown, args: unknown): void => {
		const path = record(args)?.path;
		if (typeof path !== "string" || path === "") return;
		if (name === "read") ops.read.add(path);
		else if (name === "write") ops.written.add(path);
		else if (name === "edit") ops.edited.add(path);
	};

	for (const message of [...messagesToSummarize, ...turnPrefixMessages]) {
		const m = record(message);
		if (m?.role === "toolResult") {
			const calls = record(m.nestedCalls)?.calls;
			if (Array.isArray(calls)) for (const call of calls) add(record(call)?.name, record(call)?.arguments);
		} else if (m?.role === "assistant" && Array.isArray(m.content)) {
			for (const block of m.content) {
				const b = record(block);
				if (b?.type === "toolCall") add(b.name, b.arguments);
			}
		}
	}
	return ops;
}

/** What the model reads: a title line, one sentence about what happened, then the summary. */
export function summaryContent(summary: string): string {
	return [
		"Summary of your earlier conversation",
		"",
		"Your earlier messages were replaced by this summary to keep your context small. Your most recent messages follow, unchanged.",
		"",
		summary,
	].join("\n");
}

/** The size of one message by pi's `estimateTokens` (typed `never` so that pi's own message type fits); 0 when it cannot say. */
const sizeOf = (estimate: (message: never) => number, message: unknown): number => {
	try {
		const n = estimate(message as never);
		return typeof n === "number" && Number.isFinite(n) ? n : 0;
	} catch {
		return 0; // an unknown shape counts as nothing
	}
};

/**
 * The `dev-summary` message (a custom message without its entry `type`). `tokensAfter` keeps the part of
 * `tokensBefore` that lies outside the messages (system prompt, tool declarations) and adds the estimated sizes of the
 * pinned briefing, the summary message and the kept messages.
 */
export function summaryMessage<M extends { role: string }>(input: {
	agent: Agent;
	view: readonly M[];
	plan: Pick<CompactionPlan<M>, "pin" | "kept" | "keep">;
	tokensBefore: number;
	summary: string;
	readFiles: string[];
	modifiedFiles: string[];
	usage?: SummaryUsage;
	noPrice: boolean;
	estimate: (message: never) => number;
}) {
	const { estimate, plan } = input;
	const content = summaryContent(input.summary);
	const overhead = Math.max(0, input.tokensBefore - input.view.reduce((sum, m) => sum + sizeOf(estimate, m), 0));
	const asMessage = { role: "custom", customType: SUMMARY_TYPE, content, display: true, details: undefined, timestamp: Date.now() };
	const tokensAfter =
		overhead + sizeOf(estimate, plan.pin) + sizeOf(estimate, asMessage) + plan.kept.reduce((sum, m) => sum + sizeOf(estimate, m), 0);
	const details: SummaryDetails = {
		agent: input.agent,
		keep: plan.keep,
		summary: input.summary,
		readFiles: input.readFiles,
		modifiedFiles: input.modifiedFiles,
		tokensBefore: input.tokensBefore,
		tokensAfter,
		...(input.usage ? { usage: input.usage } : {}),
		noPrice: input.noPrice,
	};
	return { customType: SUMMARY_TYPE, content, display: true, details };
}

/** The banner's title line: `▼ Developer · context compacted · 182k → ~14k tokens · $0.042` (`no price` for an unpriced model). */
export function summaryTitle(label: string, details: SummaryDetails): string {
	const price = details.noPrice ? "no price" : formatCost(details.usage?.cost?.total ?? 0);
	return `▼ ${label} · context compacted · ${formatTokens(details.tokensBefore)} → ~${formatTokens(details.tokensAfter)} tokens · ${price}`;
}
