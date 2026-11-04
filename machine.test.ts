import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Agent,
	initialState,
	type Next,
	parseState,
	resolvePlanConfirmation,
	resolveRoundLimit,
	type Step,
	transition,
	type WorkflowState,
} from "./machine.ts";

const fresh = (): WorkflowState => initialState({ id: "0001", dir: "/p/.pi/dev/0001", savedTools: ["read", "bash"] });
const at = (agent: Agent, patch: Partial<WorkflowState> = {}): WorkflowState => ({ ...fresh(), agent, ...patch });
const advance = (text = "ok") => ({ kind: "advance" as const, text });
const ret = (text = "fix it") => ({ kind: "return" as const, text });
const nextOf = <T extends Next["type"]>(step: Step, type: T) => {
	assert.equal(step.next.type, type);
	return step.next as Extract<Next, { type: T }>;
};

test("starts with the Planner in planning round 1, limit 3", () => {
	const s = fresh();
	assert.equal(s.agent, "planner");
	assert.deepEqual(s.round, { planning: 1, development: 1 });
	assert.deepEqual(s.roundLimit, { planning: 3, development: 3 });
	assert.deepEqual(s.visited, []);
	assert.equal(s.baseline, undefined);
});

test("Planner advance → Plan reviewer, carrying the summary; Planner is ✓", () => {
	const step = transition(fresh(), advance("plan ready"));
	assert.equal(step.state.agent, "plan-reviewer");
	assert.deepEqual(step.state.visited, ["planner"]);
	assert.equal(nextOf(step, "activate").summary, "plan ready");
});

test("Plan reviewer return → Planner, round + 1, feedback from the reviewer", () => {
	const step = transition(at("plan-reviewer", { visited: ["planner"] }), ret("add tests"));
	assert.equal(step.state.agent, "planner");
	assert.equal(step.state.round.planning, 2);
	assert.deepEqual(nextOf(step, "activate").feedback, { from: "reviewer", text: "add tests" });
	// The Planner is working again, so it is not ✓; the reviewer handed over earlier in this stage.
	assert.deepEqual(step.state.visited, ["plan-reviewer"]);
});

test("Plan reviewer advance → plan confirmation, reviewer's note", () => {
	const step = transition(at("plan-reviewer", { visited: ["planner"] }), advance("looks right"));
	assert.equal(step.state.agent, "plan-reviewer");
	assert.deepEqual(nextOf(step, "confirm-plan"), { type: "confirm-plan", note: "looks right", approved: true });
	assert.deepEqual(step.state.visited, ["planner", "plan-reviewer"]);
});

test("plan confirmation: approve → Developer, a fresh stage without ✓ marks", () => {
	const confirm = transition(at("plan-reviewer", { visited: ["planner"] }), advance());
	const step = resolvePlanConfirmation(confirm.state, { kind: "approve" });
	assert.equal(step.state.agent, "developer");
	assert.deepEqual(step.state.visited, []);
	assert.equal(step.state.round.development, 1);
	assert.equal(nextOf(step, "activate").feedback, undefined);
});

test("plan confirmation: send back → Planner with your comments, round NOT increased", () => {
	const s = at("plan-reviewer", { round: { planning: 2, development: 1 }, visited: ["planner"] });
	const step = resolvePlanConfirmation(transition(s, advance()).state, { kind: "send-back", comments: "drop step 3" });
	assert.equal(step.state.agent, "planner");
	assert.equal(step.state.round.planning, 2);
	assert.deepEqual(nextOf(step, "activate").feedback, { from: "user", text: "drop step 3" });
});

test("plan confirmation: stop → end stopped", () => {
	const step = resolvePlanConfirmation(at("plan-reviewer"), { kind: "stop" });
	assert.deepEqual(step.next, { type: "end", outcome: "stopped" });
});

test("Developer advance → Code reviewer", () => {
	const step = transition(at("developer"), advance("implemented"));
	assert.equal(step.state.agent, "code-reviewer");
	assert.equal(nextOf(step, "activate").summary, "implemented");
	assert.deepEqual(step.state.visited, ["developer"]);
});

test("Code reviewer return → Developer, round + 1; advance → finished with the note", () => {
	const back = transition(at("code-reviewer", { visited: ["developer"] }), ret("bug in x"));
	assert.equal(back.state.agent, "developer");
	assert.equal(back.state.round.development, 2);
	assert.equal(back.state.round.planning, 1);
	assert.deepEqual(nextOf(back, "activate").feedback, { from: "reviewer", text: "bug in x" });

	const done = transition(at("code-reviewer"), advance("all good"));
	assert.deepEqual(done.next, { type: "end", outcome: "finished", note: "all good" });
});

test("an author cannot return work", () => {
	assert.throws(() => transition(at("planner"), ret()), /cannot return/);
	assert.throws(() => transition(at("developer"), ret()), /cannot return/);
});

test("round limit: a return in the last round asks instead of looping", () => {
	const s = at("plan-reviewer", { round: { planning: 3, development: 1 }, visited: ["planner"] });
	const step = transition(s, ret("still wrong"));
	assert.deepEqual(step.next, { type: "round-limit", stage: "planning", feedback: "still wrong" });
	assert.equal(step.state.agent, "plan-reviewer");
	assert.equal(step.state.round.planning, 3);
});

test("round limit: Continue grants exactly one more round", () => {
	const s = at("code-reviewer", { round: { planning: 1, development: 3 }, visited: ["developer"] });
	const asked = transition(s, ret("nope"));
	const step = resolveRoundLimit(asked.state, "development", "nope", "continue");
	assert.equal(step.state.agent, "developer");
	assert.equal(step.state.round.development, 4);
	assert.equal(step.state.roundLimit.development, 4);
	assert.deepEqual(nextOf(step, "activate").feedback, { from: "reviewer", text: "nope" });
	// …and the next return in that round asks again
	const again = transition({ ...step.state, agent: "code-reviewer" }, ret("still"));
	assert.equal(again.next.type, "round-limit");
});

test("round limit: Accept as is → plan confirmation (planning) / finish (development)", () => {
	const planning = resolveRoundLimit(at("plan-reviewer", { round: { planning: 3, development: 1 } }), "planning", "meh", "accept");
	const confirm = nextOf(planning, "confirm-plan");
	assert.equal(confirm.approved, false);
	assert.match(confirm.note, /Accepted as is after 3 round\(s\).*meh/);

	const development = resolveRoundLimit(at("code-reviewer", { round: { planning: 1, development: 3 } }), "development", "meh", "accept");
	const end = nextOf(development, "end");
	assert.equal(end.outcome, "finished");
	assert.match(end.note ?? "", /Accepted as is/);
});

test("round limit: Stop → end stopped", () => {
	const step = resolveRoundLimit(at("plan-reviewer"), "planning", "x", "stop");
	assert.deepEqual(step.next, { type: "end", outcome: "stopped" });
});

test("states are never mutated", () => {
	const s = at("plan-reviewer", { visited: ["planner"] });
	const frozen = JSON.stringify(s);
	transition(s, ret("x"));
	transition(s, advance());
	resolvePlanConfirmation(s, { kind: "approve" });
	resolveRoundLimit(s, "planning", "x", "continue");
	assert.equal(JSON.stringify(s), frozen);
});

test("a whole workflow: planning loop, confirmation, development loop, done", () => {
	let step = transition(fresh(), advance("plan v1")); // planner → plan-reviewer
	step = transition(step.state, ret("v1 adds a feature nobody asked for")); // → planner, round 2
	assert.equal(step.state.round.planning, 2);
	step = transition(step.state, advance("plan v2")); // → plan-reviewer
	step = transition(step.state, advance("approved")); // → confirmation
	step = resolvePlanConfirmation(step.state, { kind: "approve" }); // → developer
	step = transition(step.state, advance("built")); // → code-reviewer
	step = transition(step.state, ret("misses an edge case")); // → developer, round 2
	assert.equal(step.state.round.development, 2);
	step = transition(step.state, advance("fixed")); // → code-reviewer
	step = transition(step.state, advance("approved")); // end
	assert.deepEqual(step.next, { type: "end", outcome: "finished", note: "approved" });
	assert.deepEqual(step.state.round, { planning: 2, development: 2 });
});

test("parseState round-trips a state and rejects anything malformed", () => {
	const s = at("code-reviewer", {
		round: { planning: 2, development: 3 },
		visited: ["developer"],
		baseline: { git: true, head: "abc123", dirtyFiles: ["a.txt"] },
	});
	assert.deepEqual(parseState(JSON.parse(JSON.stringify(s))), s);
	assert.equal(parseState(null), undefined);
	assert.equal(parseState("x"), undefined);
	assert.equal(parseState({}), undefined);
	assert.equal(parseState({ ...s, agent: "wizard" }), undefined);
	assert.equal(parseState({ ...s, round: { planning: 0, development: 1 } }), undefined);
	assert.equal(parseState({ ...s, visited: ["nobody"] }), undefined);
	assert.equal(parseState({ ...s, savedTools: [1] }), undefined);
});
