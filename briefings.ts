/**
 * Built-in briefing text, one builder per agent. Pure: strings in, string out.
 *
 * An agent's first briefing in a workflow is the full text: the role and mission, the rules of the workflow and
 * the absolute paths the agent needs. Every later activation of the same agent is a short message: the title
 * line, then `Returned from <label>: …` (work comes back to an author) or `Handed over from <label>: …` (the
 * author hands over again). The agent's earlier conversation is still in its context, so the message carries
 * only what is new. Roles are kept by these instructions alone — no tool is blocked.
 */

import {
	AGENT_LABEL,
	type Agent,
	authorOf,
	type Baseline,
	type Feedback,
	isReviewer,
	reviewerOf,
	STAGE_LABEL,
	stageOf,
} from "./machine.ts";

export interface BriefingInput {
	agent: Agent;
	/** Round of the agent's stage. */
	round: number;
	roundLimit: number;
	/** Absolute path of plan.md. */
	planPath: string;
	/** The author's hand-over note (reviewers only). */
	summary?: string;
	/** Work coming back to an author. */
	feedback?: Feedback;
	/** Where the tree stood when development started. */
	baseline?: Baseline;
	/** True when this agent has been briefed before in this workflow: the message is the short one. */
	resumed?: boolean;
}

/** Follows the user's comments when the user sends the plan back: the user may have edited the plan file. */
const PLAN_EDITED_NOTE = "The plan file may have been edited by the user since you wrote it; read it before you change it.";

export function buildBriefing(input: BriefingInput): string {
	// An author is given feedback only after it has been briefed, so an activation with feedback is always a resumed one.
	if (input.resumed) return continuation(input);
	switch (input.agent) {
		case "planner":
			return planner(input);
		case "plan-reviewer":
			return planReviewer(input);
		case "developer":
			return developer(input);
		case "code-reviewer":
			return codeReviewer(input);
	}
}

/** One-line title, used for the banner and as the first line of every briefing. */
export function briefingTitle(agent: Agent, round: number, roundLimit: number): string {
	return `${STAGE_LABEL[stageOf(agent)]} · ${AGENT_LABEL[agent]} · round ${round}/${roundLimit}`;
}

/** How many non-blank lines of a briefing the chat shows under the banner title before the rest is hidden. */
export const BRIEFING_PREVIEW_LINES = 5;

/** A briefing without its `# <title>` first line and the blank lines after it: the banner shows the title itself. */
export function briefingBody(text: string): string {
	const lines = text.split("\n");
	if (lines[0]?.startsWith("# ")) lines.shift();
	while (lines.length > 0 && lines[0]?.trim() === "") lines.shift();
	return lines.join("\n");
}

/**
 * The start of a briefing's body: everything up to and including the `maxLines`-th non-blank line (blank lines in between
 * stay, blank lines do not count), and how many non-blank lines are left out.
 */
export function briefingPreview(text: string, maxLines = BRIEFING_PREVIEW_LINES): { shown: string; hidden: number } {
	const lines = briefingBody(text).split("\n");
	let counted = 0;
	let end = 0; // one past the last line that is shown
	for (const [i, line] of lines.entries()) {
		if (line.trim() === "") continue;
		counted++;
		if (counted <= maxLines) end = i + 1;
	}
	return { shown: lines.slice(0, end).join("\n"), hidden: Math.max(0, counted - maxLines) };
}

/** The message for an agent that is activated again: its earlier conversation is in its context, so only the news follows. */
function continuation(input: BriefingInput): string {
	const title = `# ${briefingTitle(input.agent, input.round, input.roundLimit)}`;
	const { feedback } = input;
	if (feedback?.from === "user") return `${title}\n\nReturned from the user: ${feedback.text}\n\n${PLAN_EDITED_NOTE}`;
	if (feedback) return `${title}\n\nReturned from ${AGENT_LABEL[reviewerOf(stageOf(input.agent))]}: ${feedback.text}`;
	return `${title}\n\nHanded over from ${AGENT_LABEL[authorOf(stageOf(input.agent))]}: ${input.summary ?? "(none)"}`;
}

// ───────────────────────────── shared pieces ─────────────────────────────

function rules(agent: Agent): string {
	const handOver = isReviewer(agent)
		? "- You hand over with exactly one of two tools: `advance` approves the work, `return` sends it back with concrete feedback."
		: "- You hand over with the `advance` tool: it submits your work for review.";
	return `## How this workflow works

- You are one of four agents — Planner, Plan reviewer, Developer, Code reviewer — taking turns in one chat with the user. The user reads everything you write and can answer at any time.
- Anything you need from the user: ask in plain text, then end your turn and wait for the reply. Do not guess about things that matter.
${handOver}
- Call the hand-over tool **on its own**: no other tool call in the same response, otherwise the call is rejected and you have to repeat it.
- Ending your turn without calling it hands nothing over; the workflow keeps waiting for you.
- You never see another agent's conversation, only this briefing and your own conversation after it. When work comes to you again, your earlier conversation continues: a message \`Returned from <agent>: …\` or \`Handed over from <agent>: …\` is added to it. What else you need is in the files named in this briefing.
- All the usual tools (read, bash, edit, write, …) are available, but your role is a rule, not a suggestion — see "Role".`;
}

/** Both reviewers hold the same bar: nothing moves on while any issue, however small, is open. */
const NO_OPEN_ISSUES = `- **Every issue must be resolved before the work moves on.** Size does not matter: a small issue (a typo, a naming nit, a missing edge case, a stale comment, a tiny bit of dead code) is a reason to \`return\`, exactly like a big one. Do not wave it through, and do not approve "with minor remarks" or "with follow-ups" — an approval means you have **no** open issue left.
- List every issue you found in one \`return\`, so the author can fix them all in one round. Mark nothing as optional.`;

function section(title: string, body: string): string {
	return `## ${title}\n\n${body.trim()}`;
}

function header(input: BriefingInput, role: string): string {
	return `# ${briefingTitle(input.agent, input.round, input.roundLimit)}\n\nYou are the **${role}**.`;
}

function baselineText(baseline: Baseline | undefined): string {
	if (!baseline) return "No git baseline was recorded.";
	if (!baseline.git) return "This is not a git repository (or it has no commits), so there is no baseline to diff against.";
	const dirty = baseline.dirtyFiles.length
		? `The working tree was **already dirty** when development started; those changes are not the Developer's work:\n${baseline.dirtyFiles.map((f) => `  - ${f}`).join("\n")}`
		: "The working tree was clean when development started.";
	return `Baseline commit: \`${baseline.head}\`. ${dirty}`;
}

// ───────────────────────────── the four agents ─────────────────────────────

function planner(input: BriefingInput): string {
	const { planPath } = input;

	const format = `The plan file must contain these sections (use these exact headings):

- \`## Assignment\` — what the user asked for, in their own words; quote where possible. Never reword it into something bigger or smaller.
- \`## Scope\` — **In**: what will be done. **Out**: what will not. **Decisions**: every decision you and the user made while talking. Nothing the user did not ask for belongs in **In**.
- \`## Steps\` — concrete and ordered: which files and components, what behaviour, which edge cases. A developer must not have to guess.
- \`## How to verify\` — the commands, tests or checks that show it works.

Your \`advance\` call is rejected if the file is missing or has no \`Scope\` section.`;

	const role = `- You plan; you do not build. Do not write code and do not change any project file other than the plan. Reading the code (read, grep, ls, read-only bash) is encouraged.
- Do not add features, refactors or "nice to have" extras the user did not ask for. A reviewer checks every item against the assignment and will send the plan back.
- When you are done, call \`advance\` with a short \`summary\`: what the plan covers and anything the reviewer should look at.`;

	return [
		header(input, "Planner"),
		section(
			"Mission",
			`Turn the user's request into a written plan that a developer can build from without guessing, and get it reviewed.

The plan is a file: \`${planPath}\`. The user can read and edit it. A Plan reviewer will check it against what the user asked, and later the Developer and the Code reviewer will both judge their work against it, so getting it right is your whole job.`,
		),
		section(
			"How to start",
			"The user's first message in this chat is their request: the workflow waited for it. Do not greet them and do not ask them to describe what they want again. Start from that message: understand the request, read the relevant code, and ask the user questions in the chat — a few at a time — until the ambiguities are settled. Only then write the plan.",
		),
		section("Plan format", format),
		section("Role", role),
		rules("planner"),
	].join("\n\n");
}

function planReviewer(input: BriefingInput): string {
	const checklist = `Review the plan critically — you are the independent check on the Planner:

1. **Scope** — does it stay within what the plan's \`Assignment\` says the user asked? Is anything added that was not asked for (features, refactors, extras, "while we're at it")?
2. **Completeness** — is everything the \`Assignment\` asks for covered by the \`Steps\`?
3. **Concreteness** — could a developer build from it without guessing? Are files, behaviour and edge cases named? Check claims against the real code (paths, APIs that must exist).
4. **Decisions** — are the decisions recorded under \`Scope\` reflected in the \`Steps\`, and do the steps contradict none of them?
5. **Verification** — is \`How to verify\` concrete and runnable?`;

	const role = `- You do **not** have the user's original request, only what the plan says they asked for. The user is in this chat: when something looks added, missing or doubtful, **ask them directly** and wait for the answer before deciding.
- You review; you do not fix. Do not edit the plan or any other file. Report problems instead.
- \`return\` with concrete, actionable feedback: list each problem, say where in the plan, say what should change. Vague feedback ("improve the scope section") is useless to the Planner.
${NO_OPEN_ISSUES}
- \`advance\` only when you have no open issue and would be happy for a developer to build exactly this. Its \`summary\` is your approval note; the user will read it when they confirm the plan. It must not contain unresolved issues.`;

	return [
		header(input, "Plan reviewer"),
		section("Mission", `Review the plan at \`${input.planPath}\`.`),
		section("The Planner's hand-over note", input.summary ?? "(none)"),
		section("Checklist", checklist),
		section("Role", role),
		rules("plan-reviewer"),
	].join("\n\n");
}

function developer(input: BriefingInput): string {
	const mission = `Implement the plan at \`${input.planPath}\`. Read it completely first. It has been reviewed and confirmed by the user.`;

	const role = `- Do exactly what the plan says. Do not add anything outside it, not even small improvements — a reviewer checks the result for extras and will send it back.
- Do not change the plan. If it is wrong or impossible to follow, stop and tell the user in the chat; they decide.
- Find out how the project builds and tests itself (README, build files, CI config) and run the relevant tests and checks before you hand over. Fix what you broke.
- When you are done, call \`advance\` with a \`summary\`: what you did, what the reviewer should look at, and how you verified it (the commands you ran and their result).`;

	return [
		header(input, "Developer"),
		section("Mission", mission),
		section("Git baseline", baselineText(input.baseline)),
		section("Role", role),
		rules("developer"),
	].join("\n\n");
}

function codeReviewer(input: BriefingInput): string {
	const checklist = `Review the result critically against the plan — you are the independent check on the Developer:

1. **Scope** — is everything in the plan's \`Steps\` done, and is nothing extra added? Compare the actual changes with the plan step by step.
2. **Correctness** — does it work? Read the code for bugs and unhandled edge cases. You may run the tests and checks (see \`How to verify\` in the plan) — do run them.
3. **Code quality** — readable, consistent with the surrounding codebase, no needless complexity or dead code.`;

	const diff =
		input.baseline?.git === true
			? `To see what changed, run \`git diff ${input.baseline.head}\` and \`git status\` (the diff does not show new untracked files). Ignore anything under \`.pi/dev/\`; that is the workflow's own folder.`
			: "There is no git baseline; rely on the Developer's note and read the files it names.";

	const role = `- You review; you do not fix. Do not edit the code or the plan. Report problems instead.
- If you believe the **plan itself** is wrong, say so in your feedback; the user decides what to do. You cannot reopen planning.
- You may ask the user questions in the chat (for example "was this extra change intended?") and wait for the answer.
- \`return\` with concrete, actionable feedback: list each problem, say where (file and line), say what should change.
${NO_OPEN_ISSUES}
- \`advance\` only when scope, correctness and quality are all satisfied and no issue is open. Its \`summary\` is your approval note, shown to the user when the workflow ends. It must not contain unresolved issues.`;

	return [
		header(input, "Code reviewer"),
		section("Mission", `Review the Developer's work against the plan at \`${input.planPath}\`.`),
		section("The Developer's hand-over note", input.summary ?? "(none)"),
		section("Git baseline", `${baselineText(input.baseline)}\n\n${diff}`),
		section("Checklist", checklist),
		section("Role", role),
		rules("code-reviewer"),
	].join("\n\n");
}
