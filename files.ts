/**
 * Files on disk: the run directory, the plan, the commit message, the git baseline.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Baseline } from "./machine.ts";

/** `<project>/.pi/dev` */
export const runsRoot = (cwd: string): string => join(cwd, ".pi", "dev");

export const planPath = (dir: string): string => join(dir, "plan.md");

/** The commit message the Committer drafts and the user approves; committed verbatim. */
export const commitMessagePath = (dir: string): string => join(dir, "commit.md");

/** The planning conversation, rewritten each time the Plan reviewer is activated. */
export const planningConversationPath = (dir: string): string => join(dir, "planning-conversation.md");

/** The development conversation, rewritten each time the Code reviewer is activated. */
export const developmentConversationPath = (dir: string): string => join(dir, "development-conversation.md");

/** Create `<project>/.pi/dev/<NNNN>/` — NNNN is the next free number. */
export function allocateRunDir(cwd: string): { id: string; dir: string } {
	const root = runsRoot(cwd);
	mkdirSync(root, { recursive: true });
	let next = 1;
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d{4,}$/.test(entry.name)) continue;
		next = Math.max(next, Number.parseInt(entry.name, 10) + 1);
	}
	const id = String(next).padStart(4, "0");
	const dir = join(root, id);
	mkdirSync(dir, { recursive: true });
	return { id, dir };
}

/** A problem with the plan that blocks the hand-over, or `undefined` when it is fine. */
export function planProblem(dir: string): string | undefined {
	const path = planPath(dir);
	if (!existsSync(path)) return `The plan file does not exist: ${path}. Write it first (with a "Scope" section), then call advance.`;
	const text = readFileSync(path, "utf8");
	if (!/^#{1,6}[ \t]+Scope\b/im.test(text)) {
		return `The plan (${path}) has no "Scope" section. Add a "## Scope" heading — in / decisions made with the user — then call advance again.`;
	}
	return undefined;
}

/**
 * A problem with the commit message that blocks the hand-over (or the commit), or `undefined` when it is fine: the
 * file exists, its first line is a subject starting with an upper-case letter, and a description follows the blank line.
 */
export function commitMessageProblem(dir: string): string | undefined {
	const path = commitMessagePath(dir);
	if (!existsSync(path)) return `The commit message file does not exist: ${path}. Write it first (subject, blank line, description).`;
	const [subject = "", ...rest] = readFileSync(path, "utf8").split("\n");
	if (subject.trim() === "")
		return `The first line of ${path} is empty: it must be the subject, a short line starting with an upper-case letter.`;
	if (!/^\p{Lu}/u.test(subject)) return `The subject of ${path} must start with an upper-case letter: "${subject.trim()}".`;
	if (rest[0]?.trim() !== "" || !rest.some((line) => line.trim() !== "")) {
		return `${path} needs a blank line after the subject, then a description (context for the reviewers of the merge request).`;
	}
	return undefined;
}

// ───────────────────────────── git baseline ─────────────────────────────

export type Exec = (command: string, args: string[]) => Promise<{ stdout: string; code: number }>;

const MAX_DIRTY_FILES = 30;

/** The workflow's own folder (or a parent that only contains it) is not "dirt" in the user's tree. */
const isWorkflowFolder = (file: string): boolean => file.startsWith(".pi/dev/") || ".pi/dev/".startsWith(file);

/** Record `HEAD` and which files were already dirty. Not a git repository (or no commits) → `{ git: false }`. */
export async function gitBaseline(exec: Exec): Promise<Baseline> {
	try {
		const head = await exec("git", ["rev-parse", "HEAD"]);
		const sha = head.stdout.trim();
		if (head.code !== 0 || !sha) return { git: false };
		const status = await exec("git", ["status", "--porcelain"]);
		const dirtyFiles =
			status.code === 0
				? status.stdout
						.split("\n")
						.filter((line) => line.length > 3)
						.map((line) => line.slice(3).trim())
						.filter((file) => !isWorkflowFolder(file))
				: [];
		const shown = dirtyFiles.slice(0, MAX_DIRTY_FILES);
		if (dirtyFiles.length > shown.length) shown.push(`… and ${dirtyFiles.length - shown.length} more`);
		return { git: true, head: sha, dirtyFiles: shown };
	} catch {
		return { git: false };
	}
}
