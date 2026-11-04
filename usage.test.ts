import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIEFING_TYPE, SUMMARY_TYPE } from "./context.ts";
import { STATE_ENTRY } from "./machine.ts";
import {
	agentContextTokens,
	contextParts,
	contextText,
	formatCost,
	formatPercent,
	formatTokens,
	isNoPrice,
	summaryLines,
	type UsageEntry,
	workflowText,
	workflowTotals,
} from "./usage.ts";

// ── entry builders ──

type UsageData = NonNullable<UsageEntry["usage"]>;
const usage = (total: number, over: Record<string, unknown> = {}) => ({
	input: total,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: total,
	cost: { total: 0 },
	...over,
});
const state = (id: string): UsageEntry => ({ type: "custom", customType: STATE_ENTRY, data: { id, agent: "planner" } });
const noWorkflow: UsageEntry = { type: "custom", customType: STATE_ENTRY, data: null };
const briefing: UsageEntry = { type: "custom_message", customType: BRIEFING_TYPE, content: "# Planning · Planner · round 1/3" };
const summary = (details: unknown): UsageEntry => ({
	type: "custom_message",
	customType: SUMMARY_TYPE,
	content: "Summary of your earlier conversation",
	details,
});
const answer = (u: UsageData, extra: Record<string, unknown> = {}): UsageEntry => ({
	type: "message",
	message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }], usage: u, ...extra },
});
const user = (text: string): UsageEntry => ({ type: "message", message: { role: "user", content: text } });
const toolResult = (text: string, u?: UsageData): UsageEntry => ({
	type: "message",
	message: { role: "toolResult", content: [{ type: "text", text }], ...(u ? { usage: u } : {}) },
});

// ── workflowTotals ──

test("workflowTotals: nothing from before /dev counts", () => {
	const entries = [
		answer(usage(500_000, { input: 400_000, output: 100_000, cost: { total: 9 } })),
		state("0001"),
		briefing,
		answer(usage(1000, { input: 800, output: 200, cost: { total: 0.01 } })),
	];
	assert.deepEqual(workflowTotals(entries, "0001"), { input: 800, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.01 });
});

test("workflowTotals: every response of every agent and round adds up, all four counts and the cost", () => {
	const entries = [
		state("0001"),
		briefing,
		answer(usage(10, { input: 6, output: 4, cacheRead: 1, cacheWrite: 2, cost: { total: 0.25 } })), // Planner
		state("0001"),
		briefing,
		answer(usage(10, { input: 3, output: 1, cacheRead: 5, cacheWrite: 0, cost: { total: 0.5 } })), // Plan reviewer
		state("0001"),
		briefing,
		answer(usage(10, { input: 2, output: 2, cacheRead: 0, cacheWrite: 1, cost: { total: 0.125 } })), // Planner again
	];
	assert.deepEqual(workflowTotals(entries, "0001"), { input: 11, output: 7, cacheRead: 6, cacheWrite: 3, cost: 0.875 });
});

test("workflowTotals: the start is the earliest of several same-id dev-state entries, other entries in between included", () => {
	const entries = [
		answer(usage(1, { input: 1, cost: { total: 100 } })),
		state("0001"),
		answer(usage(1, { input: 1, cost: { total: 1 } })),
		user("hi"),
		state("0001"),
		answer(usage(1, { input: 1, cost: { total: 2 } })),
	];
	assert.deepEqual(workflowTotals(entries, "0001"), { input: 2, output: 0, cacheRead: 0, cacheWrite: 0, cost: 3 });
});

test("workflowTotals: tool-result, usage-entry, compaction and branch-summary usage are included", () => {
	const entries: UsageEntry[] = [
		state("0001"),
		toolResult("x", usage(0, { input: 10, cost: { total: 1 } })),
		toolResult("no usage on this one"),
		{ type: "usage", usage: usage(0, { output: 20, cost: { total: 2 } }) },
		{ type: "compaction", usage: usage(0, { cacheRead: 30, cost: { total: 4 } }) },
		{ type: "branch_summary", usage: usage(0, { cacheWrite: 40, cost: { total: 8 } }) },
		{ type: "message", message: { role: "user", usage: usage(0, { input: 999, cost: { total: 999 } }) } }, // users carry none
	];
	assert.deepEqual(workflowTotals(entries, "0001"), { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: 15 });
});

test("workflowTotals: the usage of a context summary (`details.usage` of a `dev-summary` message) is included", () => {
	const entries = [
		state("0001"),
		briefing,
		answer(usage(10, { input: 10, cost: { total: 1 } })),
		summary({
			agent: "planner",
			keep: 2,
			usage: usage(500, { input: 300, output: 200, cacheRead: 7, cacheWrite: 9, cost: { total: 0.5 } }),
		}),
	];
	assert.deepEqual(workflowTotals(entries, "0001"), { input: 310, output: 200, cacheRead: 7, cacheWrite: 9, cost: 1.5 });
});

test("workflowTotals: a context summary without usage, with malformed usage, or without details counts as nothing", () => {
	const entries = [
		state("0001"),
		summary({ agent: "planner", keep: 0 }),
		summary({ agent: "planner", keep: 0, usage: "lots" }),
		summary({ agent: "planner", keep: 0, usage: { input: "many", cost: "free" } }),
		summary(null),
		summary("garbage"),
		{ type: "custom_message", customType: SUMMARY_TYPE } as UsageEntry,
		{ type: "custom_message", customType: "other", details: { usage: usage(1, { input: 99, cost: { total: 99 } }) } } as UsageEntry, // only dev-summary counts
		answer(usage(1, { input: 3, cost: { total: 0.5 } })),
	];
	assert.deepEqual(workflowTotals(entries, "0001"), { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 });
});

test("workflowTotals: another workflow id is not mixed in", () => {
	const entries = [
		state("0002"),
		answer(usage(1, { input: 7, cost: { total: 7 } })),
		noWorkflow,
		state("0001"),
		answer(usage(1, { input: 1, cost: { total: 1 } })),
	];
	assert.deepEqual(workflowTotals(entries, "0001"), { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1 });
});

test("workflowTotals: no start entry → zeros", () => {
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	assert.deepEqual(workflowTotals([], "0001"), zero);
	assert.deepEqual(workflowTotals([answer(usage(5, { input: 5, cost: { total: 5 } }))], "0001"), zero);
	assert.deepEqual(workflowTotals([state("0002"), answer(usage(5, { input: 5 }))], "0001"), zero);
});

test("workflowTotals: entries with missing or odd fields do not throw and count as nothing", () => {
	const entries = [
		state("0001"),
		{ type: "message" },
		{ type: "message", message: { role: "assistant" } },
		{ type: "message", message: { role: "assistant", usage: {} } },
		{ type: "message", message: { role: "assistant", usage: { input: "many", output: null, cost: "free" } } },
		{ type: "usage" },
		{ type: "compaction", usage: null },
		{ type: "custom", customType: STATE_ENTRY, data: "garbage" },
		answer(usage(1, { input: 3, cost: { total: 0.5 } })),
	] as unknown as UsageEntry[];
	assert.deepEqual(workflowTotals(entries, "0001"), { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.5 });
});

test("workflowTotals, reused id: a 'no workflow' entry between two runs → only the second run counts", () => {
	const entries = [
		state("0001"),
		answer(usage(1, { input: 100, cost: { total: 10 } })),
		noWorkflow,
		state("0001"),
		answer(usage(1, { input: 1, cost: { total: 1 } })),
	];
	assert.deepEqual(workflowTotals(entries, "0001"), { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1 });
});

test("workflowTotals, reused id: a different id between two runs → only the second run counts", () => {
	const entries = [
		state("0001"),
		answer(usage(1, { input: 100, cost: { total: 10 } })),
		state("0002"),
		answer(usage(1, { input: 50, cost: { total: 5 } })),
		state("0001"),
		answer(usage(1, { input: 1, cost: { total: 1 } })),
	];
	assert.deepEqual(workflowTotals(entries, "0001"), { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1 });
});

test("workflowTotals, reused id: the id twice with nothing in between that ends a run → one run, both parts count", () => {
	const entries = [
		state("0001"),
		answer(usage(1, { input: 100, cost: { total: 10 } })),
		user("more"),
		state("0001"),
		answer(usage(1, { input: 1, cost: { total: 1 } })),
	];
	assert.deepEqual(workflowTotals(entries, "0001"), { input: 101, output: 0, cacheRead: 0, cacheWrite: 0, cost: 11 });
});

// ── agentContextTokens ──

/** A tiny stand-in for pi's `estimateTokens`: one token per character of text. */
const estimate = (message: { content?: unknown }): number => {
	const content = message.content;
	if (typeof content === "string") return content.length;
	return (Array.isArray(content) ? content : []).reduce(
		(n: number, c: { type: string; text: string }) => n + (c.type === "text" ? c.text.length : 0),
		0,
	);
};

test("agentContextTokens: no answer after the briefing → undefined (the previous agent's answer is ignored)", () => {
	const entries = [state("0001"), briefing, answer(usage(150_000)), state("0001"), briefing];
	assert.equal(agentContextTokens(entries, estimate), undefined);
	assert.equal(agentContextTokens([briefing, user("assignment"), toolResult("x")], estimate), undefined);
	assert.equal(agentContextTokens([], estimate), undefined);
});

test("agentContextTokens: the newest valid answer, plus an estimate of what was added since", () => {
	const entries = [
		briefing,
		user("assignment"),
		answer(usage(5000)),
		toolResult("abcdefghij"), // 10
		{ type: "custom_message", customType: "other", content: "12345" } as UsageEntry, // 5
		user("a reply"), // 7
		{ type: "custom", customType: STATE_ENTRY, data: { id: "0001" } }, // 0
	];
	assert.equal(agentContextTokens(entries, estimate), 5000 + 10 + 5 + 7);
	assert.equal(agentContextTokens([briefing, answer(usage(5000))], estimate), 5000);
});

test("agentContextTokens: the newest answer wins over an older one", () => {
	assert.equal(agentContextTokens([briefing, answer(usage(1000)), user("x"), answer(usage(3000))], estimate), 3000);
});

test("agentContextTokens: an aborted, error or zero-usage answer is skipped for an earlier valid one after the briefing, never one before it", () => {
	const aborted = answer(usage(9000), { stopReason: "aborted" });
	const error = answer(usage(9000), { stopReason: "error" });
	const zero = answer(usage(0));
	// each skipped answer is itself part of what was added since: its estimate counts (content "ok" → 2)
	assert.equal(agentContextTokens([briefing, answer(usage(2000)), aborted], estimate), 2000 + 2);
	assert.equal(agentContextTokens([briefing, answer(usage(2000)), error, zero], estimate), 2000 + 2 + 2);
	// …but an answer before the briefing is never used
	assert.equal(agentContextTokens([answer(usage(2000)), briefing, aborted, error, zero], estimate), undefined);
});

test("agentContextTokens: a compaction entry after the answer → undefined; an answer after the compaction counts again", () => {
	assert.equal(agentContextTokens([briefing, answer(usage(5000)), { type: "compaction", usage: usage(0) }], estimate), undefined);
	assert.equal(agentContextTokens([briefing, answer(usage(5000)), { type: "compaction" }, user("go"), answer(usage(800))], estimate), 800);
});

test("agentContextTokens: a context summary newer than the agent's last answer → undefined; an answer after it counts again", () => {
	assert.equal(
		agentContextTokens([briefing, answer(usage(5000)), toolResult("x"), summary({ agent: "planner", keep: 2 })], estimate),
		undefined,
	);
	assert.equal(
		agentContextTokens([briefing, answer(usage(5000)), summary({ agent: "planner", keep: 2 }), user("go"), answer(usage(800))], estimate),
		800,
	);
	assert.equal(
		agentContextTokens(
			[briefing, answer(usage(5000)), summary({ agent: "planner", keep: 2 }), answer(usage(800)), toolResult("abc")],
			estimate,
		),
		803,
	);
});

test("agentContextTokens: totalTokens 0 falls back to input + output + cacheRead + cacheWrite", () => {
	const u = usage(0, { input: 100, output: 20, cacheRead: 3000, cacheWrite: 400 });
	assert.equal(agentContextTokens([briefing, answer(u)], estimate), 3520);
});

test("agentContextTokens: odd entries and a throwing estimate count as nothing", () => {
	const entries = [briefing, answer(usage(100)), { type: "message" }, { type: "message", message: { role: "user" } }] as UsageEntry[];
	const throwing = () => {
		throw new Error("unknown shape");
	};
	assert.equal(agentContextTokens(entries, throwing), 100);
	assert.equal(agentContextTokens(entries, estimate), 100);
});

// ── formats ──

test("formatTokens", () => {
	const cases: [number, string][] = [
		[0, "0"],
		[999, "999"],
		[1000, "1k"],
		[12_300, "12.3k"],
		[5000, "5k"],
		[99_940, "99.9k"],
		[99_960, "100k"], // the k-to-k boundary: never `100.0k`
		[128_000, "128k"],
		[150_000, "150k"],
		[200_000, "200k"],
		[999_400, "999k"],
		[999_600, "1M"], // never `1000k`
		[1_200_000, "1.2M"],
		[1_000_000, "1M"],
		[12_345_678, "12.3M"],
		[-5, "0"],
		[Number.NaN, "0"],
		["x" as unknown as number, "0"],
	];
	for (const [n, text] of cases) assert.equal(formatTokens(n), text, `${n}`);
});

test("formatPercent and formatCost", () => {
	assert.equal(formatPercent(6.2), "6%");
	assert.equal(formatPercent(6.5), "7%");
	assert.equal(formatPercent(0), "0%");
	assert.equal(formatPercent(Number.NaN), "0%");
	assert.equal(formatCost(0.087), "$0.087");
	assert.equal(formatCost(0.4123), "$0.412");
	assert.equal(formatCost(0), "$0.000");
	assert.equal(formatCost(-1), "$0.000");
});

test("contextText with a window: `agent ctx 12.3k/200k · 6%`, and its parts", () => {
	assert.equal(contextText({ tokens: 12_300, window: 200_000 }), "agent ctx 12.3k/200k · 6%");
	assert.deepEqual(contextParts({ tokens: 12_300, window: 200_000 }), { label: "agent ctx ", value: "12.3k/200k · 6%", percent: 6.15 });
	assert.equal(contextParts({ tokens: 150_000, window: 200_000 }).percent, 75);
});

test("contextText without a window (unknown or 0): `agent ctx 12.3k`, no percent", () => {
	for (const window of [undefined, 0, Number.NaN]) {
		assert.equal(contextText({ tokens: 12_300, window }), "agent ctx 12.3k");
		assert.deepEqual(contextParts({ tokens: 12_300, window }), { label: "agent ctx ", value: "12.3k" });
	}
	assert.equal(contextText({ tokens: 12_300 }), "agent ctx 12.3k");
});

// ── "no price" ──

test("isNoPrice: cost 0 and no price information → true", () => {
	assert.equal(isNoPrice(0, undefined), true);
	assert.equal(isNoPrice(0, {}), true);
	assert.equal(isNoPrice(0, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), true);
	assert.equal(isNoPrice(0, { input: "3" as unknown as number }), true);
});

test("isNoPrice: any rate above 0 → false; cost above 0 → false", () => {
	assert.equal(isNoPrice(0, { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 }), false);
	assert.equal(isNoPrice(0, { cacheWrite: 0.5 }), false);
	assert.equal(isNoPrice(0.01, undefined), false);
	assert.equal(isNoPrice(0.01, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }), false);
});

test("workflowText", () => {
	assert.equal(workflowText(0.087, false), "workflow $0.087");
	assert.equal(workflowText(0, true), "workflow no price");
	assert.equal(workflowText(0, false), "workflow $0.000");
});

// ── banner lines ──

const totals = (patch: Partial<Record<"input" | "output" | "cacheRead" | "cacheWrite" | "cost", number>> = {}) => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	...patch,
});

test("summaryLines: all four parts, in a fixed order and wording", () => {
	assert.deepEqual(summaryLines(totals({ input: 120_000, output: 8200, cacheRead: 1_200_000, cacheWrite: 30_000, cost: 0.412 }), false), [
		"Cost: $0.412",
		"Tokens: 120k in · 8.2k out · 1.2M cache read · 30k cache write",
	]);
});

test("summaryLines: parts that are 0 are left out", () => {
	assert.deepEqual(summaryLines(totals({ input: 5000, output: 800, cost: 0.01 }), false), ["Cost: $0.010", "Tokens: 5k in · 800 out"]);
	assert.deepEqual(summaryLines(totals({ cacheRead: 40 }), false), ["Cost: $0.000", "Tokens: 40 cache read"]);
});

test("summaryLines: no Tokens line when all four counts are 0", () => {
	assert.deepEqual(summaryLines(totals(), false), ["Cost: $0.000"]);
	assert.deepEqual(summaryLines(totals(), true), ["Cost: no price"]);
});

test("summaryLines: `Cost: no price` with noPrice, the amount without", () => {
	assert.equal(summaryLines(totals({ input: 1 }), true)[0], "Cost: no price");
	assert.equal(summaryLines(totals({ input: 1, cost: 0.412 }), false)[0], "Cost: $0.412");
});
