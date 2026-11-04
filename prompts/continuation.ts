/**
 * The short message for an agent that is activated again: the title line, then `Returned from <label>: …` or
 * `Handed over from <label>: …`.
 */

import { AGENT_LABEL, authorOf, reviewerOf, stageOf } from "../machine.ts";
import { type BriefingInput, briefingTitle } from "./shared.ts";

/** Follows the user's comments when the user sends the plan back: the user may have edited the plan file. */
const PLAN_EDITED_NOTE = "The plan file may have been edited by the user since you wrote it; read it before you change it.";

/** The message for an agent that is activated again: its earlier conversation is in its context, so only the news follows. */
export function continuation(input: BriefingInput): string {
	const title = `# ${briefingTitle(input.agent, input.round, input.roundLimit)}`;
	const { feedback } = input;
	if (feedback?.from === "user") return `${title}\n\nReturned from the user: ${feedback.text}\n\n${PLAN_EDITED_NOTE}`;
	if (feedback) return `${title}\n\nReturned from ${AGENT_LABEL[reviewerOf(stageOf(input.agent))]}: ${feedback.text}`;
	return `${title}\n\nHanded over from ${AGENT_LABEL[authorOf(stageOf(input.agent))]}: ${input.summary ?? "(none)"}`;
}
