/**
 * The short message for an agent that is activated again: the title line, then `Returned from <label>: …` or
 * `Handed over from <label>: …`.
 */

import { AGENT_LABEL, authorOf, reviewerOf, stageOf } from "../machine.ts";
import { commitInstruction, messageCommentsInstruction } from "./committer.ts";
import { type BriefingInput, briefingTitle, USER_REQUESTS_IN_SCOPE } from "./shared.ts";

/** Follows the user's comments when the user sends the plan back: the user may have edited the plan file. */
const PLAN_EDITED_NOTE = "The plan file may have been edited by the user since you wrote it; read it before you change it.";

/** Follows the user's comments for the Developer: they are part of the job, whatever the plan lists. */
const COMMENTS_INSTRUCTION =
	'These comments are part of the job and in scope even if the plan does not list them; for these comments only, this overrides "do not add anything outside the plan" in your first briefing. If a comment is unclear, ask the user in the chat. When you are done, hand over with `advance` and a summary, as usual; all your other rules stand.';

/** What follows the user's comments (or approval) for the agent that gets them. */
function afterUser(input: BriefingInput): string {
	switch (input.agent) {
		case "developer":
			return COMMENTS_INSTRUCTION;
		case "committer":
			return input.commitApproved ? commitInstruction(input) : messageCommentsInstruction(input);
		default:
			return PLAN_EDITED_NOTE;
	}
}

/** The message for an agent that is activated again: its earlier conversation is in its context, so only the news follows. */
export function continuation(input: BriefingInput): string {
	const title = `# ${briefingTitle(input.agent, input.round, input.roundLimit)}`;
	const { feedback } = input;
	if (feedback?.from === "user") return `${title}\n\nReturned from the user: ${feedback.text}\n\n${afterUser(input)}`;
	const reviewer = reviewerOf(stageOf(input.agent));
	if (feedback && reviewer) return `${title}\n\nReturned from ${AGENT_LABEL[reviewer]}: ${feedback.text}`;
	const handedOver = `${title}\n\nHanded over from ${AGENT_LABEL[authorOf(stageOf(input.agent))]}: ${input.summary ?? "(none)"}`;
	if (!input.conversationPath) return handedOver;
	const asker = input.agent === "code-reviewer" ? "Developer" : "Planner";
	const refreshed = `${handedOver}\n\nThe conversation between the user and the ${asker} was refreshed; read it again: \`${input.conversationPath}\``;
	return input.agent === "code-reviewer" ? `${refreshed}\n\n${USER_REQUESTS_IN_SCOPE}` : refreshed;
}
