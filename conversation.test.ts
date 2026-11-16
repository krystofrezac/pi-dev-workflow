import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIEFING_TYPE, END_TYPE, SUMMARY_TYPE } from "./context.ts";
import { type ConversationEntry, planningConversation } from "./conversation.ts";
import { STATE_ENTRY } from "./machine.ts";

// ── entry builders ──

const state = (id: string): ConversationEntry => ({ type: "custom", customType: STATE_ENTRY, data: { id, agent: "planner" } });
const noWorkflow: ConversationEntry = { type: "custom", customType: STATE_ENTRY, data: null };
const marker = (customType: string, agent: string, details: Record<string, unknown> = {}): ConversationEntry => ({
	type: "custom_message",
	customType,
	details: { agent, ...details },
});
const planner = marker(BRIEFING_TYPE, "planner");
const reviewer = marker(BRIEFING_TYPE, "plan-reviewer");
const user = (content: unknown): ConversationEntry => ({ type: "message", message: { role: "user", content } });
const assistant = (...content: unknown[]): ConversationEntry => ({ type: "message", message: { role: "assistant", content } });
const text = (value: string) => ({ type: "text", text: value });

test("messages come in order, each under its label", () => {
	const entries = [
		state("0001"),
		planner,
		user("a hello file"),
		assistant(text("Which name?")),
		user("hello.txt"),
		assistant(text("Done.")),
	];
	assert.equal(
		planningConversation(entries, "0001"),
		"## User\n\na hello file\n\n## Planner\n\nWhich name?\n\n## User\n\nhello.txt\n\n## Planner\n\nDone.\n",
	);
});

test("only the Planner's text appears: no thinking, tool calls or tool results; a message without text is skipped", () => {
	const entries = [
		state("0001"),
		planner,
		user("go"),
		assistant({ type: "thinking", thinking: "secret thoughts" }, text("Reading the code."), {
			type: "toolCall",
			name: "bash",
			arguments: { command: "ls" },
		}),
		{ type: "message", message: { role: "toolResult", content: [text("tool output")] } },
		assistant({ type: "thinking", thinking: "more thoughts" }, { type: "toolCall", name: "write", arguments: {} }),
		assistant(text("Plan written.")),
	];
	const result = planningConversation(entries, "0001");
	assert.equal(result, "## User\n\ngo\n\n## Planner\n\nReading the code.\n\n## Planner\n\nPlan written.\n");
	for (const hidden of ["secret thoughts", "more thoughts", "bash", "tool output", "write"]) assert.ok(!result.includes(hidden), hidden);
});

test("images are left out of a user message; a user message of parts keeps its text", () => {
	const entries = [
		state("0001"),
		planner,
		user([text("look at this"), { type: "image", data: "xx", mimeType: "image/png" }]),
		user([{ type: "image", data: "yy" }]),
	];
	assert.equal(planningConversation(entries, "0001"), "## User\n\nlook at this\n");
});

test("the user's plan-confirmation comment is included, without the fixed sentence", () => {
	const entries = [
		state("0001"),
		planner,
		user("a hello file"),
		reviewer,
		marker(BRIEFING_TYPE, "planner", { userFeedback: "drop the cache" }),
		assistant(text("Dropped it.")),
	];
	const entry = {
		...entries[4],
		content:
			"# …\n\nReturned from the user: drop the cache\n\nThe plan file may have been edited by the user since you wrote it; read it before you change it.",
	};
	entries[4] = entry;
	const result = planningConversation(entries, "0001");
	assert.equal(result, "## User\n\na hello file\n\n## User (plan confirmation)\n\ndrop the cache\n\n## Planner\n\nDropped it.\n");
	assert.ok(!result.includes("may have been edited"));
});

test("reviewer feedback and everything in the Plan reviewer's segments are left out", () => {
	const entries = [
		state("0001"),
		planner,
		user("request"),
		assistant(text("plan ready")),
		reviewer,
		user("a question the reviewer asked, answered here"),
		assistant(text("reviewer thinking out loud")),
		marker(BRIEFING_TYPE, "planner", { feedback: "step 4 is out of scope" }),
		assistant(text("fixed")),
	];
	assert.equal(planningConversation(entries, "0001"), "## User\n\nrequest\n\n## Planner\n\nplan ready\n\n## Planner\n\nfixed\n");
});

test("entries before the workflow and from an earlier workflow with the same id are left out", () => {
	const entries = [
		user("chat before /dev"),
		state("0001"),
		planner,
		user("old workflow request"),
		noWorkflow,
		user("chat between workflows"),
		state("0001"),
		planner,
		user("new workflow request"),
	];
	assert.equal(planningConversation(entries, "0001"), "## User\n\nnew workflow request\n");
});

test("later rounds include the earlier rounds", () => {
	const entries = [
		state("0001"),
		planner,
		user("request"),
		assistant(text("plan v1")),
		reviewer,
		marker(BRIEFING_TYPE, "planner"),
		assistant(text("plan v2")),
		reviewer,
		marker(BRIEFING_TYPE, "planner", { userFeedback: "one more thing" }),
		assistant(text("plan v3")),
	];
	const result = planningConversation(entries, "0001");
	const at = ["request", "plan v1", "plan v2", "one more thing", "plan v3"].map((s) => result.indexOf(s));
	assert.ok(at.every((i) => i >= 0));
	assert.deepEqual(
		at,
		[...at].sort((a, b) => a - b),
	);
});

test("a Planner segment that starts at a summary is included; other agents' summaries and the closing note end a segment", () => {
	const entries = [
		state("0001"),
		planner,
		user("request"),
		marker(SUMMARY_TYPE, "planner"),
		assistant(text("after the summary")),
		marker(SUMMARY_TYPE, "plan-reviewer"),
		assistant(text("reviewer text")),
		{ type: "custom_message", customType: END_TYPE } as ConversationEntry,
		user("chat after the workflow"),
	];
	assert.equal(planningConversation(entries, "0001"), "## User\n\nrequest\n\n## Planner\n\nafter the summary\n");
});

test("nothing said, or no such workflow: one line saying the conversation is empty", () => {
	const empty = planningConversation([state("0001"), planner, assistant({ type: "toolCall", name: "bash" })], "0001");
	assert.match(empty, /^\(The conversation is empty\.\)$/);
	assert.equal(planningConversation([planner, user("x")], "0001"), empty);
	assert.equal(planningConversation([state("0002"), planner, user("x")], "0001"), empty);
});
