/**
 * Pieces the agent prompts share: the input every prompt is built from, the title line, the "How this workflow
 * works" rules block, the reviewers' "no open issues" bullets, and the section/header/baseline helpers.
 */

import { AGENT_LABEL, type Agent, type Baseline, type Feedback, isReviewer, STAGE_LABEL, stageOf } from "../machine.ts";

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

/** One-line title, used for the banner and as the first line of every briefing. */
export function briefingTitle(agent: Agent, round: number, roundLimit: number): string {
	return `${STAGE_LABEL[stageOf(agent)]} · ${AGENT_LABEL[agent]} · round ${round}/${roundLimit}`;
}

export function rules(agent: Agent): string {
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
export const NO_OPEN_ISSUES = `- **Every issue must be resolved before the work moves on.** Size does not matter: a small issue (a typo, a naming nit, a missing edge case, a stale comment, a tiny bit of dead code) is a reason to \`return\`, exactly like a big one. Do not wave it through, and do not approve "with minor remarks" or "with follow-ups" — an approval means you have **no** open issue left.
- List every issue you found in one \`return\`, so the author can fix them all in one round. Mark nothing as optional.`;

export function section(title: string, body: string): string {
	return `## ${title}\n\n${body.trim()}`;
}

export function header(input: BriefingInput, role: string): string {
	return `# ${briefingTitle(input.agent, input.round, input.roundLimit)}\n\nYou are the **${role}**.`;
}

export function baselineText(baseline: Baseline | undefined): string {
	if (!baseline) return "No git baseline was recorded.";
	if (!baseline.git) return "This is not a git repository (or it has no commits), so there is no baseline to diff against.";
	const dirty = baseline.dirtyFiles.length
		? `The working tree was **already dirty** when development started; those changes are not the Developer's work:\n${baseline.dirtyFiles.map((f) => `  - ${f}`).join("\n")}`
		: "The working tree was clean when development started.";
	return `Baseline commit: \`${baseline.head}\`. ${dirty}`;
}
