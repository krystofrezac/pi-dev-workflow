/**
 * Chooses which briefing to build for an agent and formats the banner preview. Pure: strings in, string out.
 *
 * The prompt text itself is in `prompts/`: one file per agent for its first briefing, `prompts/continuation.ts` for
 * the short message an agent gets when it is activated again, and `prompts/shared.ts` for what they share.
 */

import { codeReviewer } from "./prompts/code-reviewer.ts";
import { continuation } from "./prompts/continuation.ts";
import { developer } from "./prompts/developer.ts";
import { planReviewer } from "./prompts/plan-reviewer.ts";
import { planner } from "./prompts/planner.ts";
import { type BriefingInput, briefingTitle } from "./prompts/shared.ts";

export type { BriefingInput };
export { briefingTitle };

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
