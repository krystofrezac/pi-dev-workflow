import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { allocateRunDir, type Exec, gitBaseline, planPath, planProblem, runsRoot } from "./files.ts";

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

test("planProblem: missing file, missing Scope or Questions and answers section, fine", () => {
	const cwd = tmp();
	try {
		const { dir } = allocateRunDir(cwd);
		assert.match(planProblem(dir) ?? "", /does not exist/);
		writeFileSync(planPath(dir), "# Plan\n\n## Steps\n1. do it\n");
		assert.match(planProblem(dir) ?? "", /no "Scope" section/);
		writeFileSync(planPath(dir), "# Plan\n\nThe scope is large.\n");
		assert.match(planProblem(dir) ?? "", /no "Scope" section/); // prose is not a heading
		writeFileSync(planPath(dir), "# Plan\n\n## Assignment\nx\n\n## Scope\n- in: x\n");
		assert.match(planProblem(dir) ?? "", /no "Questions and answers" section/);
		writeFileSync(planPath(dir), "# Plan\n\n## Assignment\nx\n\n## Questions and answers\nnone asked\n\n## Scope\n- in: x\n");
		assert.equal(planProblem(dir), undefined);
		writeFileSync(planPath(dir), "# Plan\n\n### scope & decisions\n\n### questions and answers\n");
		assert.equal(planProblem(dir), undefined);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("planProblem: prose or a quote does not satisfy the Questions and answers gate", () => {
	const cwd = tmp();
	try {
		const { dir } = allocateRunDir(cwd);
		writeFileSync(
			planPath(dir),
			"# Plan\n\n## Assignment\n> Questions and answers should be documented\n\nThe questions and answers are below.\n\n## Scope\n- in: x\n",
		);
		assert.match(planProblem(dir) ?? "", /no "Questions and answers" section/);
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
