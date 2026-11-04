/**
 * The workflow as a state machine. Pure: no pi imports, no I/O, no dialogs.
 *
 * `transition()` turns a hand-off (`advance` / `return`) into the next step. Where the user has to
 * decide something (plan confirmation, round limit) the step says so and the caller — which owns the
 * dialogs — feeds the answer back through `resolvePlanConfirmation()` / `resolveRoundLimit()`.
 * Every function returns new objects; a state is never mutated.
 */

export type Agent = "planner" | "plan-reviewer" | "developer" | "code-reviewer";
export type Stage = "planning" | "development";
export type Outcome = "finished" | "stopped";

export const AGENTS: readonly Agent[] = ["planner", "plan-reviewer", "developer", "code-reviewer"];
export const STAGES: readonly Stage[] = ["planning", "development"];

export const AGENT_LABEL: Record<Agent, string> = {
	planner: "Planner",
	"plan-reviewer": "Plan reviewer",
	developer: "Developer",
	"code-reviewer": "Code reviewer",
};

export const STAGE_LABEL: Record<Stage, string> = {
	planning: "Planning",
	development: "Development",
};

export const DEFAULT_ROUND_LIMIT = 3;

/** Name of the session entry that mirrors the state (`data: null` = no workflow). */
export const STATE_ENTRY = "dev-state";

export const stageOf = (agent: Agent): Stage => (agent === "planner" || agent === "plan-reviewer" ? "planning" : "development");
export const isReviewer = (agent: Agent): boolean => agent === "plan-reviewer" || agent === "code-reviewer";
export const authorOf = (stage: Stage): Agent => (stage === "planning" ? "planner" : "developer");
export const reviewerOf = (stage: Stage): Agent => (stage === "planning" ? "plan-reviewer" : "code-reviewer");
export const agentsOf = (stage: Stage): [Agent, Agent] => [authorOf(stage), reviewerOf(stage)];

/** Where the working tree stood when development started. `git: false` → not a repository (or no commits). */
export type Baseline = { git: false } | { git: true; head: string; dirtyFiles: string[] };

export interface WorkflowState {
	/** "0003" — also the run directory name. */
	id: string;
	/** Absolute path of `<project>/.pi/dev/<id>`. */
	dir: string;
	agent: Agent;
	/** Current author⇄reviewer cycle per stage, starting at 1. */
	round: Record<Stage, number>;
	roundLimit: Record<Stage, number>;
	/** Agents that have handed over in the current stage (drives the ✓ marks). */
	visited: Agent[];
	/** The tool set that was active before `/dev`; restored when the workflow ends. */
	savedTools: string[];
	/** Set when development starts. */
	baseline?: Baseline;
}

export function initialState(input: { id: string; dir: string; savedTools: string[] }): WorkflowState {
	return {
		id: input.id,
		dir: input.dir,
		agent: "planner",
		round: { planning: 1, development: 1 },
		roundLimit: { planning: DEFAULT_ROUND_LIMIT, development: DEFAULT_ROUND_LIMIT },
		visited: [],
		savedTools: [...input.savedTools],
	};
}

// ───────────────────────────── hand-offs and steps ─────────────────────────────

/** What a tool call asked for. `text` is the summary (`advance`) or the feedback (`return`). */
export interface HandOff {
	kind: "advance" | "return";
	text: string;
}

/** Feedback an author is given when work comes back: from a reviewer, or from you at the plan confirmation. */
export interface Feedback {
	from: "reviewer" | "user";
	text: string;
}

export type Next =
	/** `state.agent` is the agent to brief. `summary` is the author's hand-over note (for a reviewer). */
	| { type: "activate"; summary?: string; feedback?: Feedback }
	/** Ask the user to confirm the plan. `approved`: the Plan reviewer approved it (`note` is its approval note); otherwise the user accepted it at the round limit. */
	| { type: "confirm-plan"; note: string; approved: boolean }
	/** Ask the user what to do after `roundLimit` rounds without approval. */
	| { type: "round-limit"; stage: Stage; feedback: string }
	| { type: "end"; outcome: Outcome; note?: string };

export interface Step {
	state: WorkflowState;
	next: Next;
}

/** Hand `agent` the work. Entering another stage starts with no ✓ marks; the active agent is never ✓. */
function activate(state: WorkflowState, agent: Agent, extra: { summary?: string; feedback?: Feedback } = {}): Step {
	const visited = stageOf(agent) === stageOf(state.agent) ? state.visited.filter((a) => a !== agent) : [];
	return { state: { ...state, agent, visited }, next: { type: "activate", ...extra } };
}

const handedOver = (state: WorkflowState): WorkflowState =>
	state.visited.includes(state.agent) ? state : { ...state, visited: [...state.visited, state.agent] };

/** A reviewer sent the work back. */
function returned(state: WorkflowState, feedback: string): Step {
	const stage = stageOf(state.agent);
	if (state.round[stage] >= state.roundLimit[stage]) {
		return { state, next: { type: "round-limit", stage, feedback } };
	}
	const next = activate(state, authorOf(stage), { feedback: { from: "reviewer", text: feedback } });
	return { ...next, state: { ...next.state, round: { ...next.state.round, [stage]: state.round[stage] + 1 } } };
}

/** The active agent called `advance` or `return`. */
export function transition(state: WorkflowState, handOff: HandOff): Step {
	const done = handedOver(state);
	if (handOff.kind === "return" && !isReviewer(state.agent)) {
		throw new Error(`${AGENT_LABEL[state.agent]} cannot return work.`);
	}
	switch (state.agent) {
		case "planner":
			return activate(done, "plan-reviewer", { summary: handOff.text });
		case "developer":
			return activate(done, "code-reviewer", { summary: handOff.text });
		case "plan-reviewer":
			return handOff.kind === "advance"
				? { state: done, next: { type: "confirm-plan", note: handOff.text, approved: true } }
				: returned(done, handOff.text);
		case "code-reviewer":
			return handOff.kind === "advance"
				? { state: done, next: { type: "end", outcome: "finished", note: handOff.text } }
				: returned(done, handOff.text);
	}
}

// ───────────────────────────── the user's answers ─────────────────────────────

export type PlanChoice = { kind: "approve" } | { kind: "send-back"; comments: string } | { kind: "stop" };

/** The user answered the plan confirmation. (Editing the plan changes no state, so it is not a choice.) */
export function resolvePlanConfirmation(state: WorkflowState, choice: PlanChoice): Step {
	switch (choice.kind) {
		case "approve":
			return activate(state, "developer");
		case "send-back":
			// The round number is not increased: your comments are not a reviewer round.
			return activate(state, "planner", { feedback: { from: "user", text: choice.comments } });
		case "stop":
			return { state, next: { type: "end", outcome: "stopped" } };
	}
}

export type LimitChoice = "continue" | "accept" | "stop";

/** The user answered the round-limit dialog for `stage`; `feedback` is the reviewer's last feedback. */
export function resolveRoundLimit(state: WorkflowState, stage: Stage, feedback: string, choice: LimitChoice): Step {
	switch (choice) {
		case "continue": {
			// One more round: raise the limit by one, then it is an ordinary return.
			const raised = { ...state, roundLimit: { ...state.roundLimit, [stage]: state.roundLimit[stage] + 1 } };
			return returned(raised, feedback);
		}
		case "accept": {
			const note = `Accepted as is after ${state.round[stage]} round(s), without the reviewer's approval. Last feedback: ${feedback}`;
			return stage === "planning"
				? { state, next: { type: "confirm-plan", note, approved: false } }
				: { state, next: { type: "end", outcome: "finished", note } };
		}
		case "stop":
			return { state, next: { type: "end", outcome: "stopped" } };
	}
}

// ───────────────────────────── persistence ─────────────────────────────

/** Validate a `dev-state` entry's data. Anything malformed counts as "no workflow". */
export function parseState(data: unknown): WorkflowState | undefined {
	if (!data || typeof data !== "object") return undefined;
	const { id, dir, agent, round, roundLimit, visited, savedTools, baseline } = data as Record<string, unknown>;
	const isAgent = (v: unknown): v is Agent => AGENTS.includes(v as Agent);
	const isCount = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1;
	const isRound = (v: unknown): v is Record<Stage, number> => !!v && STAGES.every((s) => isCount((v as Record<string, unknown>)[s]));
	const ok =
		typeof id === "string" &&
		typeof dir === "string" &&
		isAgent(agent) &&
		isRound(round) &&
		isRound(roundLimit) &&
		Array.isArray(visited) &&
		visited.every(isAgent) &&
		Array.isArray(savedTools) &&
		savedTools.every((t: unknown) => typeof t === "string");
	if (!ok) return undefined;
	return {
		id,
		dir,
		agent,
		round: { planning: round.planning, development: round.development },
		roundLimit: { planning: roundLimit.planning, development: roundLimit.development },
		visited: [...visited],
		savedTools: [...savedTools],
		...(baseline && typeof baseline === "object" ? { baseline: baseline as Baseline } : {}),
	};
}
