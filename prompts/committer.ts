/**
 * The Committer's messages. Its first briefing (sections: Mission, Git baseline, Role, How this workflow works) asks for the
 * commit message as a file; the two messages it gets when it is activated again follow the user's answer to that file.
 */

import { type BriefingInput, baselineText, header, rules, section } from "./shared.ts";

const baselineHead = (input: BriefingInput): string => (input.baseline?.git === true ? input.baseline.head : "<baseline head>");

export function committer(input: BriefingInput): string {
	const { planPath, commitPath } = input;

	const mission = `Commit the Developer's work. The work was reviewed and approved, and the user chose to commit it. Your first job is to write the commit message to \`${commitPath}\`; the user reads and edits that file, and only after they approve it do you commit.

Read the plan at \`${planPath}\` first: it says what the change is for.`;

	const diff = `To see what the Developer changed, run \`git diff ${baselineHead(input)}\` and \`git status\` (the diff does not show new untracked files), and \`git log\` for the recent commits, so you know how this repository writes its messages. Ignore anything under \`.pi/dev/\`; that is the workflow's own folder.`;

	const role = `- Write \`${commitPath}\`. **The file is the commit message and nothing else**: no preamble, no remarks to the user, no code fence around it. It is committed verbatim.
- Its format is fixed: a subject line, a blank line, then the description.
- The subject is one short line that describes the feature. It starts with an upper-case letter and a present-tense verb, for example \`Add a feature X\` or \`Resolve bug XY\`.
- The description is context for the reviewers of the merge request: what changed, how it works in general and how the pieces interact. It is Markdown; mermaid diagrams are welcome where they make it clearer. Keep it short enough to read in a few minutes.
- Never mention anything that was tried or considered but is not in the final result (rejected approaches, removed code, features that were not implemented).
- **Do not commit yet.** Do not stage anything and do not run \`git commit\`: the user reviews the message first.
- When the file is written, call \`advance\` with a short \`summary\`. It is rejected if the file is missing or malformed.`;

	return [
		header(input, "Committer"),
		section("Mission", mission),
		section("Git baseline", `${baselineText(input.baseline)}\n\n${diff}`),
		section("Role", role),
		rules("committer"),
	].join("\n\n");
}

/** Follows `Returned from the user: approved`: now the commit is made. */
export function commitInstruction(input: BriefingInput): string {
	const { commitPath } = input;
	return `The user approved the commit message. Re-read \`${commitPath}\` (the user may have edited it), then commit with \`git commit -F ${commitPath} --cleanup=whitespace\`, so Markdown \`#\` headings survive.

Stage only the Developer's files: not the files that were already dirty when development started, and nothing under \`.pi/dev/\`. The list of dirty files in your first briefing is capped at 30 and may end with an entry like "… and N more" that is not a file name, so treat it as a hint only: decide from \`git status\` and \`git diff ${baselineHead(input)}\`, and ask the user in the chat when it is unclear which changes are the Developer's.

Never push. If anything fails (a hook rejects the commit, for example), do not retry blindly: tell the user in the chat, then \`advance\` with an account of what was and was not committed. Otherwise \`advance\` with the commit hash and the subject.`;
}

/** Follows the user's comments on the commit message. */
export function messageCommentsInstruction(input: BriefingInput): string {
	return `Change \`${input.commitPath}\` accordingly; re-read it first, because the user may have edited it. Do not commit. When you are done, call \`advance\` again, as before.`;
}
