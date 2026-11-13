/** The Developer's first briefing. Sections: Mission, Git baseline, Role, How this workflow works. */

import { type BriefingInput, baselineText, header, rules, section } from "./shared.ts";

export function developer(input: BriefingInput): string {
	const mission = `Implement the plan at \`${input.planPath}\`. Read it completely first. It has been reviewed and confirmed by the user.`;

	const role = `- Do exactly what the plan says: its \`In\` section is the whole job. Do not add anything outside it, not even small improvements — a reviewer checks the result for extras and will send it back.
- The plan gives intent and interfaces, not code. Follow exactly what it decides (behaviour, signatures, scope); the implementation details are yours — write them in the conventions of the codebase.
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
