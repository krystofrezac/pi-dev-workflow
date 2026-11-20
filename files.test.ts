import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	allocateRunDir,
	commitMessagePath,
	commitMessageProblem,
	developmentConversationPath,
	type Exec,
	gitBaseline,
	planningConversationPath,
	planPath,
	planProblem,
	runsRoot,
} from "./files.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "dev-workflow-test-"));

test("allocateRunDir: 0001 first, then the next free number; other folders are ignored", () => {
	const cwd = tmp();
	try {
		assert.equal(allocateRunDir(cwd).id, "0001");
		assert.equal(allocateRunDir(cwd).id, "0002");
		mkdirSync(join(runsRoot(cwd), "0007"));
		mkdirSync(join(runsRoot(cwd), "notes"));
		writeFileSync(join(runsRoot(cwd), "0099"), "a file, not a run");
		const run = allocateRunDir(cwd);
		assert.equal(run.id, "0008");
		assert.equal(run.dir, join(cwd, ".pi", "dev", "0008"));
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("planProblem: missing file, missing Scope section, fine", () => {
	const cwd = tmp();
	try {
		const { dir } = allocateRunDir(cwd);
		assert.match(planProblem(dir) ?? "", /does not exist/);
		writeFileSync(planPath(dir), "# Plan\n\n## Steps\n1. do it\n");
		assert.match(planProblem(dir) ?? "", /no "Scope" section/);
		writeFileSync(planPath(dir), "# Plan\n\nThe scope is large.\n");
		assert.match(planProblem(dir) ?? "", /no "Scope" section/); // prose is not a heading
		writeFileSync(planPath(dir), "# Plan\n\n## Assignment\nx\n\n## Scope\n- in: x\n");
		assert.equal(planProblem(dir), undefined);
		writeFileSync(planPath(dir), "# Plan\n\n### scope & decisions\n");
		assert.equal(planProblem(dir), undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("planProblem: prose or a quote does not satisfy the Scope gate", () => {
	const cwd = tmp();
	try {
		const { dir } = allocateRunDir(cwd);
		writeFileSync(planPath(dir), "# Plan\n\n## Assignment\n> Scope should be documented\n\nThe scope is below.\n\n## Design\n- in: x\n");
		assert.match(planProblem(dir) ?? "", /no "Scope" section/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

const script =
	(answers: Record<string, { stdout: string; code: number }>): Exec =>
	async (command, args) =>
		answers[[command, ...args].join(" ")] ?? { stdout: "", code: 1 };

test("gitBaseline: clean tree", async () => {
	const exec = script({ "git rev-parse HEAD": { stdout: "abc123\n", code: 0 }, "git status --porcelain": { stdout: "", code: 0 } });
	assert.deepEqual(await gitBaseline(exec), { git: true, head: "abc123", dirtyFiles: [] });
});

test("gitBaseline: dirty files are listed, the workflow's own folder is not", async () => {
	const exec = script({
		"git rev-parse HEAD": { stdout: "abc123\n", code: 0 },
		"git status --porcelain": { stdout: " M src/a.ts\n?? notes.md\n?? .pi/dev/\nA  b.ts\n", code: 0 },
	});
	assert.deepEqual(await gitBaseline(exec), { git: true, head: "abc123", dirtyFiles: ["src/a.ts", "notes.md", "b.ts"] });
});

test("gitBaseline: long lists are capped", async () => {
	const many = Array.from({ length: 40 }, (_, i) => ` M f${i}.ts`).join("\n");
	const exec = script({ "git rev-parse HEAD": { stdout: "abc\n", code: 0 }, "git status --porcelain": { stdout: many, code: 0 } });
	const baseline = await gitBaseline(exec);
	assert.ok(baseline.git);
	if (baseline.git) {
		assert.equal(baseline.dirtyFiles.length, 31);
		assert.equal(baseline.dirtyFiles.at(-1), "… and 10 more");
	}
});

test("gitBaseline: not a repository, no commits, or git missing → { git: false }", async () => {
	assert.deepEqual(await gitBaseline(script({ "git rev-parse HEAD": { stdout: "", code: 128 } })), { git: false });
	assert.deepEqual(await gitBaseline(script({ "git rev-parse HEAD": { stdout: "\n", code: 0 } })), { git: false });
	assert.deepEqual(
		await gitBaseline(async () => {
			throw new Error("spawn git ENOENT");
		}),
		{ git: false },
	);
});

test("the conversation files are named after their stage", () => {
	assert.equal(planningConversationPath("/p/.pi/dev/0001"), "/p/.pi/dev/0001/planning-conversation.md");
	assert.equal(developmentConversationPath("/p/.pi/dev/0001"), "/p/.pi/dev/0001/development-conversation.md");
});

test("commitMessagePath is commit.md in the run folder", () => {
	assert.equal(commitMessagePath("/p/.pi/dev/0001"), join("/p/.pi/dev/0001", "commit.md"));
});

test("commitMessageProblem: a missing file, an empty or lower-case subject and a missing description are reported", () => {
	const cwd = tmp();
	try {
		const { dir } = allocateRunDir(cwd);
		const check = (text: string) => {
			writeFileSync(commitMessagePath(dir), text);
			return commitMessageProblem(dir) ?? "";
		};
		assert.match(commitMessageProblem(dir) ?? "", /does not exist/);
		assert.match(check(""), /first line .* is empty/);
		assert.match(check("\n\nAdd x\n\nBecause."), /first line .* is empty/);
		assert.match(check("add x\n\nBecause."), /upper-case letter/);
		assert.match(check("# Add x\n\nBecause."), /upper-case letter/);
		assert.match(check("Add x\n"), /description/);
		assert.match(check("Add x\n\n  \n\n"), /description/);
		assert.match(check("Add x\nBecause."), /blank line/);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("commitMessageProblem: a subject, a blank line and a description are fine, Markdown headings in the description too", () => {
	const cwd = tmp();
	try {
		const { dir } = allocateRunDir(cwd);
		writeFileSync(
			commitMessagePath(dir),
			"Add a feature X\n\n## Context\n\nIt works like this.\n\n```mermaid\nflowchart LR\n  A --> B\n```\n",
		);
		assert.equal(commitMessageProblem(dir), undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
