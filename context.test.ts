import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIEFING_TYPE, briefedBefore, END_TYPE, SUMMARY_TYPE, visibleMessages } from "./context.ts";

type Msg = { role: string; customType?: string; details?: unknown; text: string };
const user = (text: string): Msg => ({ role: "user", text });
const assistant = (text: string): Msg => ({ role: "assistant", text });
const toolResult = (text: string): Msg => ({ role: "toolResult", text });
const briefing = (text: string, agent: string): Msg => ({ role: "custom", customType: BRIEFING_TYPE, details: { agent }, text });
const end = (text: string): Msg => ({ role: "custom", customType: END_TYPE, text });
const summary = (text: string, agent: string, keep: unknown): Msg => ({
	role: "custom",
	customType: SUMMARY_TYPE,
	details: { agent, keep },
	text,
});
const texts = (messages: Msg[]) => messages.map((m) => m.text);

test("no marker: the very same array comes back (a no-op for ordinary sessions)", () => {
	const messages = [user("a"), assistant("b"), user("c")];
	assert.equal(visibleMessages(messages), messages);
	assert.equal(visibleMessages([]).length, 0);
});

test("the chat before /dev is hidden", () => {
	const messages = [user("before /dev"), assistant("reply"), briefing("planner", "planner"), assistant("hi"), user("assignment")];
	assert.deepEqual(texts(visibleMessages(messages)), ["planner", "hi", "assignment"]);
});

test("each agent sees only its own briefing and what follows it", () => {
	const messages = [
		briefing("planner", "planner"),
		assistant("q?"),
		user("a"),
		assistant("plan written"),
		briefing("plan-reviewer", "plan-reviewer"),
		assistant("looks off"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), ["plan-reviewer", "looks off"]);
	assert.deepEqual(texts(visibleMessages(messages.slice(0, 4))), ["planner", "q?", "a", "plan written"]);
});

test("an author activated again sees its first segment and the new briefing, not the reviewer's segment", () => {
	const messages = [
		briefing("planner", "planner"),
		assistant("q?"),
		user("a"),
		assistant("plan written"),
		briefing("plan-reviewer", "plan-reviewer"),
		assistant("looks off"),
		briefing("planner again", "planner"),
		assistant("revising"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), ["planner", "q?", "a", "plan written", "planner again", "revising"]);
});

test("a reviewer activated again sees its own earlier segment and the new briefing, not the author's", () => {
	const messages = [
		briefing("planner", "planner"),
		assistant("plan written"),
		briefing("plan-reviewer", "plan-reviewer"),
		assistant("looks off"),
		briefing("planner again", "planner"),
		assistant("revising"),
		briefing("plan-reviewer again", "plan-reviewer"),
		assistant("fine"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), ["plan-reviewer", "looks off", "plan-reviewer again", "fine"]);
});

test("development agents never see the planning agents' segments, and the other way round", () => {
	const messages = [
		briefing("planner", "planner"),
		assistant("plan"),
		briefing("plan-reviewer", "plan-reviewer"),
		assistant("ok"),
		briefing("developer", "developer"),
		assistant("built"),
		briefing("code-reviewer", "code-reviewer"),
		assistant("bad"),
		briefing("developer again", "developer"),
		assistant("fixed"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), ["developer", "built", "developer again", "fixed"]);
	assert.deepEqual(texts(visibleMessages(messages.slice(0, 8))), ["code-reviewer", "bad"]);
	assert.deepEqual(texts(visibleMessages(messages.slice(0, 4))), ["plan-reviewer", "ok"]);
	assert.deepEqual(texts(visibleMessages(messages.slice(0, 2))), ["planner", "plan"]);
});

test("the walk stops at a closing note: a later workflow does not see the earlier one, nor the chat between them", () => {
	const messages = [
		briefing("planner 1", "planner"),
		assistant("old plan"),
		end("finished"),
		user("thanks"),
		assistant("welcome"),
		briefing("planner 2", "planner"),
		assistant("new plan"),
		briefing("plan-reviewer 2", "plan-reviewer"),
		assistant("ok"),
		briefing("planner 2 again", "planner"),
		assistant("revised"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), ["planner 2", "new plan", "planner 2 again", "revised"]);
});

test("a briefing without a readable agent shows only its own segment and what follows it", () => {
	const noDetails: Msg = { role: "custom", customType: BRIEFING_TYPE, text: "unknown" };
	const emptyAgent: Msg = { role: "custom", customType: BRIEFING_TYPE, details: { agent: "" }, text: "empty" };
	const numberAgent: Msg = { role: "custom", customType: BRIEFING_TYPE, details: { agent: 3 }, text: "number" };
	for (const unreadable of [noDetails, emptyAgent, numberAgent]) {
		const messages = [briefing("planner", "planner"), assistant("plan"), unreadable, assistant("hi"), user("x")];
		assert.deepEqual(texts(visibleMessages(messages)), [unreadable.text, "hi", "x"]);
	}
});

test("after the workflow only the closing note and what follows are visible", () => {
	const messages = [
		user("old"),
		briefing("code-reviewer", "code-reviewer"),
		assistant("ok"),
		end("finished"),
		user("thanks"),
		assistant("welcome"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), ["finished", "thanks", "welcome"]);
});

test("a tool call and its result in a kept segment stay together", () => {
	const messages = [
		user("before /dev"),
		briefing("developer", "developer"),
		assistant("<call write>"),
		toolResult("written"),
		assistant("<call advance>"),
		toolResult("handed over"),
		briefing("code-reviewer", "code-reviewer"),
		assistant("<call return>"),
		toolResult("returned"),
		briefing("developer again", "developer"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), [
		"developer",
		"<call write>",
		"written",
		"<call advance>",
		"handed over",
		"developer again",
	]);
});

test("a marker that is already first is a no-op", () => {
	const messages = [briefing("planner", "planner"), assistant("hi")];
	assert.equal(visibleMessages(messages), messages);
});

test("the same array comes back when only the agent's own segments run from the start; a new array when something is dropped", () => {
	const alone = [briefing("planner", "planner"), assistant("plan"), user("go"), briefing("planner again", "planner"), assistant("revised")];
	assert.equal(visibleMessages(alone), alone);
	const withChat = [user("before"), ...alone];
	assert.notEqual(visibleMessages(withChat), withChat);
	assert.equal(visibleMessages(withChat).length, alone.length);
});

test("only custom messages count as markers", () => {
	const lookalike: Msg = { role: "user", customType: BRIEFING_TYPE, details: { agent: "planner" }, text: "not a marker" };
	const other: Msg = { role: "custom", customType: "something-else", text: "not a marker" };
	const messages = [user("a"), lookalike, other, assistant("b")];
	assert.equal(visibleMessages(messages), messages);
});

test("does not mutate its input", () => {
	const messages = [user("a"), briefing("x", "planner"), assistant("b"), briefing("y", "plan-reviewer"), briefing("z", "planner")];
	const before = [...messages];
	visibleMessages(messages);
	assert.deepEqual(messages, before);
});

// ── briefed before ──

const dev = {
	briefing: (agent: string) => ({ type: "custom_message", customType: BRIEFING_TYPE, details: { agent } }),
	end: { type: "custom_message", customType: END_TYPE },
	state: { type: "custom", customType: "dev-state" },
	assistant: { type: "message", message: { role: "assistant" } },
};

test("briefedBefore: false with no earlier briefing of that agent", () => {
	assert.equal(briefedBefore([], "planner"), false);
	assert.equal(briefedBefore([dev.assistant, dev.state], "planner"), false);
});

test("briefedBefore: true with an earlier briefing of that agent", () => {
	assert.equal(briefedBefore([dev.briefing("planner"), dev.assistant, dev.briefing("plan-reviewer"), dev.assistant], "planner"), true);
	assert.equal(briefedBefore([dev.briefing("planner"), dev.assistant, dev.briefing("plan-reviewer")], "plan-reviewer"), true);
});

test("briefedBefore: false when only another agent's briefing is there", () => {
	assert.equal(briefedBefore([dev.briefing("planner"), dev.assistant], "plan-reviewer"), false);
});

test("briefedBefore: false when the only earlier briefing lies before a closing note", () => {
	assert.equal(briefedBefore([dev.briefing("planner"), dev.assistant, dev.end, dev.assistant], "planner"), false);
	assert.equal(briefedBefore([dev.briefing("planner"), dev.end, dev.briefing("plan-reviewer")], "planner"), false);
	assert.equal(briefedBefore([dev.briefing("planner"), dev.end, dev.briefing("planner")], "planner"), true);
});

test("briefedBefore: a briefing without a readable agent counts for nobody", () => {
	assert.equal(briefedBefore([{ type: "custom_message", customType: BRIEFING_TYPE }], "planner"), false);
});

// ── summary marker ──

test("a summary: the agent sees its first briefing, the summary, the last `keep` messages from before it, and everything after", () => {
	const messages = [
		user("before /dev"),
		briefing("planner", "planner"),
		user("assignment"),
		assistant("a1"),
		toolResult("r1"),
		assistant("a2"),
		toolResult("r2"),
		summary("summary", "planner", 2),
		assistant("a3"),
		toolResult("r3"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), ["planner", "summary", "a2", "r2", "a3", "r3"]);
});

test("a summary with keep 0: only the pinned briefing, the summary and what follows", () => {
	const messages = [briefing("planner", "planner"), user("assignment"), assistant("a1"), summary("summary", "planner", 0), assistant("a2")];
	assert.deepEqual(texts(visibleMessages(messages)), ["planner", "summary", "a2"]);
});

test("a summary that moves messages: a new array is returned even when the length is the same", () => {
	const messages = [briefing("planner", "planner"), assistant("a"), summary("summary", "planner", 1)];
	const view = visibleMessages(messages);
	assert.equal(view.length, messages.length);
	assert.notEqual(view, messages);
	assert.deepEqual(texts(view), ["planner", "summary", "a"]);
});

test("a summary right after the briefing: nothing is moved, the same array comes back", () => {
	const messages = [briefing("planner", "planner"), summary("summary", "planner", 0)];
	assert.equal(visibleMessages(messages), messages);
});

test("two summaries of the same agent: the second folds the first in", () => {
	const messages = [
		briefing("planner", "planner"),
		user("assignment"),
		assistant("a1"),
		toolResult("r1"),
		summary("summary 1", "planner", 2), // view then: planner, summary 1, a1, r1
		assistant("a2"),
		toolResult("r2"),
		summary("summary 2", "planner", 3), // keeps the last three of: summary 1, a1, r1, a2, r2
		assistant("a3"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), ["planner", "summary 2", "r1", "a2", "r2", "a3"]);
	assert.deepEqual(texts(visibleMessages(messages.slice(0, 7))), ["planner", "summary 1", "a1", "r1", "a2", "r2"]);
});

test("keep larger than the earlier view is clamped; a missing, negative, fractional or non-number keep counts as 0", () => {
	const base = [briefing("planner", "planner"), assistant("a1"), assistant("a2")];
	assert.deepEqual(texts(visibleMessages([...base, summary("summary", "planner", 99)])), ["planner", "summary", "a1", "a2"]);
	for (const keep of [undefined, -1, 1.5, "2", null, Number.NaN]) {
		assert.deepEqual(texts(visibleMessages([...base, summary("summary", "planner", keep)])), ["planner", "summary"], String(keep));
	}
	const noDetails: Msg = { role: "custom", customType: SUMMARY_TYPE, text: "no details" };
	assert.deepEqual(texts(visibleMessages([...base, noDetails])), ["no details"]);
});

test("another agent's segments are never in the view, and another agent's summary does not change this agent's view", () => {
	const messages = [
		briefing("planner", "planner"),
		assistant("p1"),
		briefing("plan-reviewer", "plan-reviewer"),
		assistant("r1"),
		assistant("r2"),
		summary("reviewer summary", "plan-reviewer", 1),
		assistant("r3"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), ["plan-reviewer", "reviewer summary", "r2", "r3"]);
	assert.deepEqual(texts(visibleMessages([...messages, briefing("planner again", "planner"), assistant("p2")])), [
		"planner",
		"p1",
		"planner again",
		"p2",
	]);
});

test("a summary written at a hand-off boundary (before the next agent's briefing): the next agent's view is as it was, the summarised agent's view is compacted when it is active again", () => {
	const messages = [
		briefing("planner", "planner"),
		user("assignment"),
		assistant("p1"),
		toolResult("pr1"),
		summary("planner summary", "planner", 2),
		briefing("plan-reviewer", "plan-reviewer"),
		assistant("r1"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), ["plan-reviewer", "r1"]);
	const back = [...messages, briefing("planner again", "planner"), assistant("p2")];
	assert.deepEqual(texts(visibleMessages(back)), ["planner", "planner summary", "p1", "pr1", "planner again", "p2"]);
});

test("the walk stops at a closing note: a summary before it is not applied to the next workflow", () => {
	const messages = [
		briefing("planner 1", "planner"),
		assistant("old"),
		summary("old summary", "planner", 1),
		end("finished"),
		briefing("planner 2", "planner"),
		assistant("new"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), ["planner 2", "new"]);
});

test("a summary without a readable agent, as the newest marker, shows from that marker on", () => {
	const unreadable: Msg = { role: "custom", customType: SUMMARY_TYPE, details: { agent: "", keep: 1 }, text: "unreadable" };
	const messages = [briefing("planner", "planner"), assistant("a1"), unreadable, assistant("a2")];
	assert.deepEqual(texts(visibleMessages(messages)), ["unreadable", "a2"]);
});

test("the pinned briefing is first even when the summary and the kept messages come from later segments", () => {
	const messages = [
		briefing("planner", "planner"),
		assistant("p1"),
		briefing("plan-reviewer", "plan-reviewer"),
		assistant("r1"),
		briefing("planner again", "planner"),
		assistant("p2"),
		toolResult("pr2"),
		summary("summary", "planner", 3),
		assistant("p3"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), ["planner", "summary", "planner again", "p2", "pr2", "p3"]);
});

test("a tool call and its result in the kept part of a summary stay together", () => {
	const messages = [
		briefing("developer", "developer"),
		user("go"),
		assistant("<call write>"),
		toolResult("written"),
		assistant("<call bash>"),
		toolResult("ran"),
		summary("summary", "developer", 2),
		assistant("next"),
	];
	assert.deepEqual(texts(visibleMessages(messages)), ["developer", "summary", "<call bash>", "ran", "next"]);
});

test("a summary does not mutate its input", () => {
	const messages = [
		user("a"),
		briefing("x", "planner"),
		assistant("b"),
		briefing("y", "plan-reviewer"),
		briefing("z", "planner"),
		assistant("c"),
		summary("s", "planner", 1),
	];
	const before = [...messages];
	visibleMessages(messages);
	assert.deepEqual(messages, before);
});
