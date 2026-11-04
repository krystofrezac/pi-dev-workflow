import assert from "node:assert/strict";
import { test } from "node:test";
import {
	agentView,
	type CompactionConfig,
	collectFileOps,
	compactionSettings,
	planCompaction,
	type SummaryDetails,
	summaryContent,
	summaryMessage,
	summaryTitle,
} from "./compaction.ts";
import { BRIEFING_TYPE, SUMMARY_TYPE, visibleMessages } from "./context.ts";

type Msg = { role: string; customType?: string; details?: unknown; text: string; content?: unknown };
const user = (text: string): Msg => ({ role: "user", text });
const assistant = (text: string): Msg => ({ role: "assistant", text });
const toolResult = (text: string): Msg => ({ role: "toolResult", text });
const system = (text: string): Msg => ({ role: "system", text });
const briefing = (text: string, agent: string): Msg => ({ role: "custom", customType: BRIEFING_TYPE, details: { agent }, text });
const summary = (text: string, agent: string, keep: number, extra: Record<string, unknown> = {}): Msg => ({
	role: "custom",
	customType: SUMMARY_TYPE,
	details: { agent, keep, ...extra },
	text,
});
const texts = (messages: Msg[]) => messages.map((m) => m.text);

const defaults: CompactionConfig = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };
const model = { provider: "acme", id: "big-1" };

// ── compactionSettings ──

test("compactionSettings: nothing set → pi's defaults", () => {
	assert.deepEqual(compactionSettings({}, model, defaults), defaults);
	assert.deepEqual(compactionSettings(undefined, model, defaults), defaults);
	assert.deepEqual(compactionSettings(null, undefined, defaults), defaults);
	assert.deepEqual(compactionSettings("garbage", model, defaults), defaults);
	assert.deepEqual(compactionSettings({ compaction: "garbage" }, model, defaults), defaults);
});

test("compactionSettings: the ordinary values", () => {
	const raw = { compaction: { enabled: true, reserveTokens: 9000, keepRecentTokens: 200 } };
	assert.deepEqual(compactionSettings(raw, model, defaults), { enabled: true, reserveTokens: 9000, keepRecentTokens: 200 });
	assert.deepEqual(compactionSettings({ compaction: { reserveTokens: 0 } }, model, defaults), { ...defaults, reserveTokens: 0 });
});

test("compactionSettings: `enabled: false` is respected; a non-boolean `enabled` is skipped", () => {
	assert.equal(compactionSettings({ compaction: { enabled: false } }, model, defaults).enabled, false);
	assert.equal(compactionSettings({ compaction: { enabled: "no" } }, model, defaults).enabled, true);
	assert.equal(compactionSettings({ compaction: { enabled: 0 } }, model, { ...defaults, enabled: false }).enabled, false);
});

test("compactionSettings: a model's override wins per field", () => {
	const raw = {
		compaction: {
			reserveTokens: 9000,
			keepRecentTokens: 200,
			modelOverrides: { "acme/big-1": { reserveTokens: 4000 }, "acme/other": { reserveTokens: 1, keepRecentTokens: 1 } },
		},
	};
	assert.deepEqual(compactionSettings(raw, model, defaults), { enabled: true, reserveTokens: 4000, keepRecentTokens: 200 });
	assert.deepEqual(compactionSettings(raw, { provider: "acme", id: "other" }, defaults), {
		enabled: true,
		reserveTokens: 1,
		keepRecentTokens: 1,
	});
	assert.deepEqual(compactionSettings(raw, undefined, defaults), { enabled: true, reserveTokens: 9000, keepRecentTokens: 200 });
});

test("compactionSettings: an invalid model override with a valid ordinary value gives the ordinary value", () => {
	for (const bad of [-1, 1.5, "100", null, Number.NaN, Number.MAX_SAFE_INTEGER + 2]) {
		const raw = { compaction: { reserveTokens: 9000, modelOverrides: { "acme/big-1": { reserveTokens: bad } } } };
		assert.equal(compactionSettings(raw, model, defaults).reserveTokens, 9000, String(bad));
	}
	assert.equal(
		compactionSettings({ compaction: { reserveTokens: 9000, modelOverrides: { "acme/big-1": "garbage" } } }, model, defaults).reserveTokens,
		9000,
	);
});

test("compactionSettings: an invalid ordinary value gives the default; so does an invalid override without an ordinary value", () => {
	for (const bad of [-1, 1.5, "100", null]) {
		assert.deepEqual(
			compactionSettings({ compaction: { reserveTokens: bad, keepRecentTokens: bad } }, model, defaults),
			defaults,
			String(bad),
		);
	}
	assert.equal(
		compactionSettings({ compaction: { modelOverrides: { "acme/big-1": { keepRecentTokens: -5 } } } }, model, defaults).keepRecentTokens,
		20000,
	);
});

// ── agentView ──

test("agentView: system messages are removed before the view is built", () => {
	const list = [
		user("chat"),
		briefing("planner", "planner"),
		system("tools"),
		user("assignment"),
		assistant("a1"),
		system("tools changed"),
	];
	assert.deepEqual(texts(agentView(list)), ["planner", "assignment", "a1"]);
	assert.deepEqual(agentView(list), visibleMessages(list.filter((m) => m.role !== "system")));
});

test("agentView: no marker → the messages without the system ones", () => {
	assert.deepEqual(texts(agentView([system("s"), user("a"), assistant("b")])), ["a", "b"]);
});

/** A cut at the message whose text is `at`, found in the entries `planCompaction` hands over. */
const cutAt = (at: string) => (entries: { type: string; message: Msg }[]) => ({
	firstKeptEntryIndex: entries.findIndex((e) => e.message.text === at),
	turnStartIndex: -1,
	isSplitTurn: false,
});

test("round trip with system messages: the `keep` counted from the agent's view is what the context hook applies", () => {
	const list: Msg[] = [
		briefing("planner", "planner"),
		system("tools after the first briefing"),
		user("assignment"),
		assistant("a1"),
		toolResult("r1"),
		briefing("plan-reviewer", "plan-reviewer"),
		system("tools after the reviewer's briefing"),
		assistant("rv"),
		briefing("planner again", "planner"),
		system("tools after the re-activation"),
		assistant("a2"),
		system("tools changed inside the kept part"),
		toolResult("r2"),
		assistant("a3"),
		toolResult("r3"),
	];
	const view = agentView(list);
	assert.deepEqual(texts(view), ["planner", "assignment", "a1", "r1", "planner again", "a2", "r2", "a3", "r3"]);

	const plan = planCompaction(view, { keepRecentTokens: 1, findCutPoint: cutAt("a2") });
	assert.ok(plan);
	assert.deepEqual(texts(plan.kept), ["a2", "r2", "a3", "r3"]); // starts at the message the cut chose, never at a tool result
	assert.equal(plan.keep, 4);

	const made = summaryMessage({
		agent: "planner",
		view,
		plan,
		tokensBefore: 100,
		summary: "the summary",
		readFiles: [],
		modifiedFiles: [],
		noPrice: true,
		estimate: () => 1,
	});
	const summaryEntry: Msg = { role: "custom", customType: made.customType, details: made.details, text: "SUMMARY" };
	const later = assistant("a4");
	const seenByHook = visibleMessages([...list, summaryEntry, later].filter((m) => m.role !== "system")); // the hook never receives system messages
	assert.deepEqual(texts(seenByHook), ["planner", "SUMMARY", "a2", "r2", "a3", "r3", "a4"]);

	// Counted over the list *with* the system message inside the kept part, `keep` is one too high and takes an older message.
	const wrongPlan = planCompaction(visibleMessages(list), { keepRecentTokens: 1, findCutPoint: cutAt("a2") });
	assert.ok(wrongPlan);
	assert.equal(wrongPlan.keep, 5);
	const wrongSummary: Msg = { ...summaryEntry, details: { ...(made.details as object), keep: wrongPlan.keep } };
	const wrong = visibleMessages([...list, wrongSummary, later].filter((m) => m.role !== "system"));
	assert.notDeepEqual(texts(wrong), texts(seenByHook));
	assert.ok(texts(wrong).includes("planner again"));
});

// ── planCompaction ──

const cutAtIndex =
	(firstKeptEntryIndex: number, turnStartIndex = -1) =>
	() => ({ firstKeptEntryIndex, turnStartIndex, isSplitTurn: turnStartIndex !== -1 });

test("planCompaction: no pinned briefing → nothing to do", () => {
	const view = [user("a"), assistant("b"), user("c")];
	assert.equal(planCompaction(view, { keepRecentTokens: 1, findCutPoint: cutAtIndex(2) }), undefined);
	assert.equal(planCompaction([], { keepRecentTokens: 1, findCutPoint: cutAtIndex(0) }), undefined);
	assert.equal(
		planCompaction([summary("s", "planner", 0), assistant("a")], { keepRecentTokens: 1, findCutPoint: cutAtIndex(1) }),
		undefined,
	);
});

test("planCompaction: nothing before the cut → nothing to do", () => {
	const view = [briefing("pin", "planner"), user("a"), assistant("b")];
	assert.equal(planCompaction(view, { keepRecentTokens: 1, findCutPoint: cutAtIndex(0) }), undefined);
	assert.equal(planCompaction([briefing("pin", "planner")], { keepRecentTokens: 1, findCutPoint: cutAtIndex(0) }), undefined);
});

test("planCompaction: a first compaction summarises everything before the cut and keeps the rest", () => {
	const view = [briefing("pin", "planner"), user("u"), assistant("a1"), toolResult("r1"), assistant("a2"), toolResult("r2")];
	const seen: unknown[][] = [];
	const plan = planCompaction(view, {
		keepRecentTokens: 777,
		findCutPoint: (entries, start, end, keepRecentTokens) => {
			seen.push([entries, start, end, keepRecentTokens]);
			return { firstKeptEntryIndex: 3, turnStartIndex: -1, isSplitTurn: false };
		},
	});
	assert.ok(plan);
	assert.equal(plan.pin, view[0]);
	assert.deepEqual(texts(plan.messagesToSummarize), ["u", "a1", "r1"]);
	assert.deepEqual(plan.turnPrefixMessages, []);
	assert.equal(plan.isSplitTurn, false);
	assert.deepEqual(texts(plan.kept), ["a2", "r2"]);
	assert.equal(plan.keep, 2);
	assert.equal(plan.previousSummary, undefined);
	assert.equal(plan.previousFiles, undefined);
	assert.equal(seen.length, 1);
	const [entries, start, end, keepRecentTokens] = seen[0];
	assert.deepEqual(
		entries,
		view.slice(1).map((message) => ({ type: "message", message })),
	);
	assert.deepEqual([start, end, keepRecentTokens], [0, 5, 777]);
});

test("planCompaction: a second compaction treats the earlier summary as the previous summary and carries its file lists", () => {
	const earlier = summary("S1", "planner", 2, { summary: "old summary text", readFiles: ["a.ts", 7, "b.ts"], modifiedFiles: ["c.ts"] });
	const view = [briefing("pin", "planner"), earlier, assistant("k1"), toolResult("k2"), assistant("n1"), toolResult("n2")];
	let start: number | undefined;
	const plan = planCompaction(view, {
		keepRecentTokens: 1,
		findCutPoint: (_entries, boundaryStart) => {
			start = boundaryStart;
			return { firstKeptEntryIndex: 3, turnStartIndex: -1, isSplitTurn: false }; // rest[3] = n1
		},
	});
	assert.equal(start, 1);
	assert.ok(plan);
	assert.deepEqual(texts(plan.messagesToSummarize), ["k1", "k2"]);
	assert.equal(plan.previousSummary, "old summary text");
	assert.deepEqual(plan.previousFiles, { readFiles: ["a.ts", "b.ts"], modifiedFiles: ["c.ts"] });
	assert.deepEqual(texts(plan.kept), ["n1", "n2"]);
	assert.equal(plan.keep, 2);
});

test("planCompaction: only the earlier summary lies before the kept messages → nothing to do", () => {
	const view = [briefing("pin", "planner"), summary("S1", "planner", 2), assistant("k1"), toolResult("k2")];
	assert.equal(planCompaction(view, { keepRecentTokens: 1, findCutPoint: cutAtIndex(1) }), undefined);
});

test("planCompaction: a split turn summarises the history up to the turn's start and the turn's beginning separately", () => {
	const view = [
		briefing("pin", "planner"),
		user("u1"),
		assistant("a1"),
		user("u2"),
		assistant("a2"),
		toolResult("r2"),
		assistant("a3"),
		toolResult("r3"),
	];
	// rest: u1 a1 u2 a2 r2 a3 r3 — the cut is at a3 (index 5), inside the turn that starts at u2 (index 2)
	const plan = planCompaction(view, { keepRecentTokens: 1, findCutPoint: cutAtIndex(5, 2) });
	assert.ok(plan);
	assert.equal(plan.isSplitTurn, true);
	assert.deepEqual(texts(plan.messagesToSummarize), ["u1", "a1"]);
	assert.deepEqual(texts(plan.turnPrefixMessages), ["u2", "a2", "r2"]);
	assert.deepEqual(texts(plan.kept), ["a3", "r3"]);
	assert.equal(plan.keep, 2);
});

test("planCompaction: a split turn that starts right after the earlier summary has only a turn prefix", () => {
	const view = [briefing("pin", "planner"), summary("S1", "planner", 0), user("u"), assistant("a1"), assistant("a2"), toolResult("r2")];
	// rest: S1 u a1 a2 r2 — the cut is at a2 (index 3), the turn starts at u (index 1)
	const plan = planCompaction(view, { keepRecentTokens: 1, findCutPoint: cutAtIndex(3, 1) });
	assert.ok(plan);
	assert.deepEqual(plan.messagesToSummarize, []);
	assert.deepEqual(texts(plan.turnPrefixMessages), ["u", "a1"]);
	assert.deepEqual(texts(plan.kept), ["a2", "r2"]);
});

// ── collectFileOps ──

const call = (name: string, args: unknown) => ({ type: "toolCall", id: "x", name, arguments: args });
const assistantCalls = (...calls: unknown[]) => ({ role: "assistant", content: [{ type: "text", text: "ok" }, ...calls] });

test("collectFileOps: read, write and edit calls with a string path land in the right sets", () => {
	const ops = collectFileOps(
		[
			assistantCalls(call("read", { path: "a.ts" }), call("write", { path: "b.ts", content: "x" })),
			assistantCalls(call("edit", { path: "c.ts" })),
		],
		[assistantCalls(call("read", { path: "d.ts" }))],
	);
	assert.deepEqual([...ops.read], ["a.ts", "d.ts"]);
	assert.deepEqual([...ops.written], ["b.ts"]);
	assert.deepEqual([...ops.edited], ["c.ts"]);
});

test("collectFileOps: other tools, non-string and empty paths, odd messages are ignored", () => {
	const ops = collectFileOps(
		[
			assistantCalls(
				call("bash", { path: "no.ts" }),
				call("read", { path: 3 }),
				call("read", { path: "" }),
				call("read", {}),
				call("read", null),
			),
			{ role: "user", content: [call("read", { path: "user.ts" })] },
			{ role: "assistant", content: "plain text" },
			{ role: "assistant" },
			null,
			"text",
		],
		[],
	);
	assert.deepEqual([...ops.read, ...ops.written, ...ops.edited], []);
});

test("collectFileOps: calls made from codemode scripts (`nestedCalls.calls` of a tool result) count the same way", () => {
	const ops = collectFileOps(
		[
			{
				role: "toolResult",
				content: [],
				nestedCalls: {
					calls: [
						{ name: "read", arguments: { path: "n1.ts" } },
						{ name: "edit", arguments: { path: "n2.ts" } },
						{ name: "write", arguments: { path: "n3.ts" } },
						{ name: "bash", arguments: { path: "no" } },
					],
				},
			},
			{ role: "toolResult", content: [], nestedCalls: "garbage" },
			{ role: "toolResult", content: [] },
		],
		[],
	);
	assert.deepEqual([...ops.read], ["n1.ts"]);
	assert.deepEqual([...ops.written], ["n3.ts"]);
	assert.deepEqual([...ops.edited], ["n2.ts"]);
});

test("collectFileOps: the file lists of an earlier summary seed `read` and `edited`", () => {
	const ops = collectFileOps([assistantCalls(call("read", { path: "new.ts" }))], [], {
		readFiles: ["old-r.ts"],
		modifiedFiles: ["old-m.ts"],
	});
	assert.deepEqual([...ops.read].sort(), ["new.ts", "old-r.ts"]);
	assert.deepEqual([...ops.edited], ["old-m.ts"]);
	assert.deepEqual([...ops.written], []);
});

// ── summaryContent / summaryMessage / summaryTitle ──

test("summaryContent: a title line, a sentence about what happened, then the summary; never a markdown title", () => {
	const content = summaryContent("## Goal\nbuild it");
	const lines = content.split("\n");
	assert.equal(lines[0], "Summary of your earlier conversation");
	assert.equal(lines[1], "");
	assert.match(lines[2], /earlier messages were replaced by this summary to keep your context small/);
	assert.match(lines[2], /most recent messages follow, unchanged/);
	assert.equal(lines[3], "");
	assert.ok(content.endsWith("## Goal\nbuild it"));
	assert.ok(!content.startsWith("# "));
});

const sized = (text: string, size: number): Msg & { size: number } => ({ role: "user", text, size });
const estimateSize = (m: { size?: unknown; content?: unknown }): number =>
	typeof m.size === "number" ? m.size : typeof m.content === "string" ? m.content.length : 0;

function compacted(tokensBefore: number) {
	const pin = { ...briefing("pin", "developer"), size: 10 };
	const view = [pin, sized("old1", 30), sized("old2", 20), sized("kept1", 25), sized("kept2", 15)];
	return summaryMessage({
		agent: "developer",
		view,
		plan: { pin, kept: view.slice(3), keep: 2 },
		tokensBefore,
		summary: "the summary",
		readFiles: ["r.ts"],
		modifiedFiles: ["m.ts"],
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { total: 0.042 } },
		noPrice: false,
		estimate: estimateSize,
	});
}

test("summaryMessage: a displayed custom message of type `dev-summary` that carries the details", () => {
	const message = compacted(150);
	assert.equal(message.customType, SUMMARY_TYPE);
	assert.equal(message.display, true);
	assert.equal(message.content, summaryContent("the summary"));
	const d = message.details;
	assert.equal(d.agent, "developer");
	assert.equal(d.keep, 2);
	assert.equal(d.summary, "the summary");
	assert.deepEqual(d.readFiles, ["r.ts"]);
	assert.deepEqual(d.modifiedFiles, ["m.ts"]);
	assert.equal(d.tokensBefore, 150);
	assert.equal(d.noPrice, false);
	assert.equal(d.usage?.cost.total, 0.042);
});

test("summaryMessage: tokensAfter = what lies outside the messages + the pinned briefing + the summary message + the kept messages", () => {
	const size = summaryContent("the summary").length;
	// the view holds 10 + 30 + 20 + 25 + 15 = 100 of the 150 measured: 50 lie outside the messages
	assert.equal(compacted(150).details.tokensAfter, 50 + 10 + size + 25 + 15);
});

test("summaryMessage: when the estimates exceed the measured size nothing is carried over", () => {
	const size = summaryContent("the summary").length;
	assert.equal(compacted(80).details.tokensAfter, 0 + 10 + size + 25 + 15);
});

test("summaryMessage: no `usage` key when none was returned", () => {
	const view = [briefing("pin", "planner")];
	const message = summaryMessage({
		agent: "planner",
		view,
		plan: { pin: view[0], kept: [], keep: 0 },
		tokensBefore: 10,
		summary: "s",
		readFiles: [],
		modifiedFiles: [],
		noPrice: true,
		estimate: () => 1,
	});
	assert.ok(!("usage" in message.details));
	assert.equal(message.details.noPrice, true);
});

const details = (over: Partial<SummaryDetails> = {}): SummaryDetails => ({
	agent: "developer",
	keep: 2,
	summary: "s",
	readFiles: [],
	modifiedFiles: [],
	tokensBefore: 182_000,
	tokensAfter: 14_000,
	usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.042 } },
	noPrice: false,
	...over,
});

test("summaryTitle: agent, size before → after, price", () => {
	assert.equal(summaryTitle("Developer", details()), "▼ Developer · context compacted · 182k → ~14k tokens · $0.042");
});

test("summaryTitle: `no price` when the model declares no price", () => {
	assert.equal(
		summaryTitle("Plan reviewer", details({ noPrice: true, usage: undefined })),
		"▼ Plan reviewer · context compacted · 182k → ~14k tokens · no price",
	);
	assert.equal(
		summaryTitle("Plan reviewer", details({ noPrice: true })),
		"▼ Plan reviewer · context compacted · 182k → ~14k tokens · no price",
	);
});

test("summaryTitle: a missing usage reads as $0.000; unknown or non-numeric figures count as 0", () => {
	assert.equal(summaryTitle("Planner", details({ usage: undefined })), "▼ Planner · context compacted · 182k → ~14k tokens · $0.000");
	const odd = details({
		tokensBefore: "many" as unknown as number,
		tokensAfter: undefined as unknown as number,
		usage: { cost: { total: "lots" } } as unknown as SummaryDetails["usage"],
	});
	assert.equal(summaryTitle("Planner", odd), "▼ Planner · context compacted · 0 → ~0 tokens · $0.000");
});
