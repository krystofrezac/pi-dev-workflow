import assert from "node:assert/strict";
import { test } from "node:test";
import { type BriefingInput, briefingTitle, buildBriefing } from "./briefings.ts";

const base = (patch: Partial<BriefingInput>): BriefingInput => ({
	agent: "planner",
	round: 1,
	roundLimit: 3,
	planPath: "/p/.pi/dev/0001/plan.md",
	...patch,
});

test("title: stage · agent · round", () => {
	assert.equal(briefingTitle("code-reviewer", 2, 3), "Development · Code reviewer · round 2/3");
	assert.equal(briefingTitle("planner", 1, 3), "Planning · Planner · round 1/3");
});

test("every briefing names the plan file, its role, and the hand-over rules", () => {
	for (const agent of ["planner", "plan-reviewer", "developer", "code-reviewer"] as const) {
		const text = buildBriefing(base({ agent }));
		assert.ok(text.includes("/p/.pi/dev/0001/plan.md"), `${agent}: plan path`);
		assert.match(text, /on its own/, `${agent}: advance/return alone`);
		assert.match(text, /ask in plain text/, `${agent}: ask the user in chat`);
		assert.match(text, /your own conversation/, `${agent}: own conversation continues`);
		assert.match(text, /Returned from <agent>/, `${agent}: the message when work comes back`);
		assert.match(text, /Handed over from <agent>/, `${agent}: the message when work is handed over`);
		assert.doesNotMatch(text, /clean context/, `${agent}: no clean context`);
	}
});

test("only reviewers are told about `return`", () => {
	assert.doesNotMatch(buildBriefing(base({ agent: "planner" })), /`return`/);
	assert.doesNotMatch(buildBriefing(base({ agent: "developer" })), /`return`/);
	assert.match(buildBriefing(base({ agent: "plan-reviewer" })), /`return`/);
	assert.match(buildBriefing(base({ agent: "code-reviewer" })), /`return`/);
});

test("Planner, first round: starts from the user's first message, no greeting; mandatory plan sections are spelled out", () => {
	const text = buildBriefing(base({}));
	assert.match(text, /first message/);
	assert.match(text, /How to start/);
	assert.doesNotMatch(text, /Greet the user/);
	assert.doesNotMatch(text, /\*\*wait\*\*/);
	for (const heading of ["## Assignment", "## Scope", "## Steps", "## How to verify"]) assert.ok(text.includes(heading), heading);
	assert.match(text, /do not change any project file other than the plan/);
});

test("Plan reviewer: gets the plan and the summary, not an original assignment; may ask the user", () => {
	const text = buildBriefing(base({ agent: "plan-reviewer", summary: "plan covers X and Y" }));
	assert.match(text, /plan covers X and Y/);
	assert.match(text, /do \*\*not\*\* have the user's original request/);
	assert.match(text, /ask them directly/);
	assert.match(text, /do not fix/);
	assert.match(text, /Scope.*Completeness.*Concreteness.*Decisions.*Verification/s);
});

test("Developer: implement the plan, run checks, git baseline (clean / dirty / none)", () => {
	const clean = buildBriefing(base({ agent: "developer", baseline: { git: true, head: "abc123", dirtyFiles: [] } }));
	assert.match(clean, /Implement the plan at/);
	assert.match(clean, /abc123/);
	assert.match(clean, /clean when development started/);
	assert.match(clean, /run the relevant tests and checks/);

	const dirty = buildBriefing(base({ agent: "developer", baseline: { git: true, head: "abc123", dirtyFiles: ["x.ts"] } }));
	assert.match(dirty, /already dirty/);
	assert.match(dirty, /- x\.ts/);

	assert.match(buildBriefing(base({ agent: "developer", baseline: { git: false } })), /not a git repository/);
});

test("Code reviewer: summary, diff command against the baseline, scope/correctness/quality", () => {
	const text = buildBriefing(
		base({ agent: "code-reviewer", summary: "built it, ran ./gradlew test", baseline: { git: true, head: "abc123", dirtyFiles: [] } }),
	);
	assert.match(text, /built it, ran \.\/gradlew test/);
	assert.match(text, /git diff abc123/);
	assert.match(text, /Scope.*Correctness.*Code quality/s);
	assert.match(text, /plan itself\*\* is wrong/);

	assert.match(buildBriefing(base({ agent: "code-reviewer", baseline: { git: false } })), /rely on the Developer's note/);
});

test("Both reviewers: return even for small issues, approve only with nothing open", () => {
	for (const agent of ["plan-reviewer", "code-reviewer"] as const) {
		const text = buildBriefing(base({ agent }));
		assert.match(text, /Every issue must be resolved before the work moves on/, `${agent}: all issues resolved`);
		assert.match(text, /small issue .* is a reason to `return`/s, `${agent}: small issues are returned too`);
		assert.match(text, /no\*\* open issue left/, `${agent}: approval means nothing open`);
	}
	for (const agent of ["planner", "developer"] as const) {
		assert.doesNotMatch(buildBriefing(base({ agent })), /Every issue must be resolved/, `${agent}: not a reviewer rule`);
	}
});

// ── an agent activated again: the short message ──

const FIXED_SENTENCE = "The plan file may have been edited by the user since you wrote it; read it before you change it.";
const NOT_A_BRIEFING = ["/p/.pi/dev/0001/plan.md", "How this workflow works", "Plan format", "Git baseline", "Checklist"];
const AGENTS = ["planner", "plan-reviewer", "developer", "code-reviewer"] as const;

test("the first-time briefings do not carry the fixed sentence for the user's send-back", () => {
	for (const agent of AGENTS) assert.doesNotMatch(buildBriefing(base({ agent })), /may have been edited by the user/, agent);
});

test("Planner returned by the Plan reviewer: the title line and one sentence, nothing else", () => {
	const text = buildBriefing(base({ round: 2, resumed: true, feedback: { from: "reviewer", text: "step 4 is out of scope" } }));
	assert.equal(text, "# Planning · Planner · round 2/3\n\nReturned from Plan reviewer: step 4 is out of scope");
	for (const part of NOT_A_BRIEFING) assert.ok(!text.includes(part), part);
	assert.doesNotMatch(text, /may have been edited by the user/);
});

test("Developer returned by the Code reviewer: the title line and one sentence, nothing else", () => {
	const text = buildBriefing(
		base({
			agent: "developer",
			round: 2,
			resumed: true,
			baseline: { git: true, head: "abc123", dirtyFiles: [] },
			feedback: { from: "reviewer", text: "null check missing in parse()" },
		}),
	);
	assert.equal(text, "# Development · Developer · round 2/3\n\nReturned from Code reviewer: null check missing in parse()");
	for (const part of NOT_A_BRIEFING) assert.ok(!text.includes(part), part);
	assert.doesNotMatch(text, /abc123/);
	assert.doesNotMatch(text, /may have been edited by the user/);
});

test("Plan reviewer handed the plan again: the title line and one sentence, nothing else", () => {
	const text = buildBriefing(base({ agent: "plan-reviewer", round: 2, resumed: true, summary: "plan revised" }));
	assert.equal(text, "# Planning · Plan reviewer · round 2/3\n\nHanded over from Planner: plan revised");
	for (const part of NOT_A_BRIEFING) assert.ok(!text.includes(part), part);
	assert.doesNotMatch(text, /may have been edited by the user/);
});

test("Code reviewer handed the work again: the title line and one sentence, nothing else", () => {
	const text = buildBriefing(
		base({
			agent: "code-reviewer",
			round: 2,
			resumed: true,
			summary: "implemented hello.txt",
			baseline: { git: true, head: "abc123", dirtyFiles: [] },
		}),
	);
	assert.equal(text, "# Development · Code reviewer · round 2/3\n\nHanded over from Developer: implemented hello.txt");
	for (const part of NOT_A_BRIEFING) assert.ok(!text.includes(part), part);
	assert.doesNotMatch(text, /abc123/);
	assert.doesNotMatch(text, /may have been edited by the user/);
});

test("a hand-over without a note reads `(none)`", () => {
	assert.equal(
		buildBriefing(base({ agent: "plan-reviewer", resumed: true })),
		"# Planning · Plan reviewer · round 1/3\n\nHanded over from Planner: (none)",
	);
	assert.equal(
		buildBriefing(base({ agent: "code-reviewer", resumed: true })),
		"# Development · Code reviewer · round 1/3\n\nHanded over from Developer: (none)",
	);
});

test("Planner sent back by the user: the comments, then the fixed sentence about the plan file", () => {
	const text = buildBriefing(base({ round: 4, roundLimit: 4, resumed: true, feedback: { from: "user", text: "drop the cache" } }));
	assert.equal(
		text,
		"# Planning · Planner · round 4/4\n\nReturned from the user: drop the cache\n\nThe plan file may have been edited by the user since you wrote it; read it before you change it.",
	);
	for (const part of NOT_A_BRIEFING) assert.ok(!text.includes(part), part);
	assert.ok(text.endsWith(FIXED_SENTENCE));
});

test("the user's comments stay verbatim, line breaks included; the fixed sentence comes after them", () => {
	const text = buildBriefing(base({ resumed: true, feedback: { from: "user", text: "first\n\nsecond" } }));
	assert.equal(text, `# Planning · Planner · round 1/3\n\nReturned from the user: first\n\nsecond\n\n${FIXED_SENTENCE}`);
});
