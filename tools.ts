/**
 * `advance` and `return` — the only two ways an agent hands over.
 *
 * Registered at load with `defaultActive: false`, so an ordinary session never sees them; the workflow
 * activates them with `setActiveTools()`. Neither tool performs the transition: it validates, records the
 * hand-off through the host and returns. The transition itself runs at `turn_end`.
 *
 * Both return `terminate: true` (pi would otherwise ask the model once more after the batch) and refuse to
 * run unless they are the only tool call of their assistant message — a sibling that does not terminate would
 * bring the extra request back, and on the very last hand-off there is no next agent to take it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type Agent, type HandOff, isReviewer } from "./machine.ts";

/** What the tools need from the running workflow. */
export interface ToolHost {
	/** The active agent, `undefined` when no workflow runs. */
	agent(): Agent | undefined;
	/** Is a hand-off already recorded for this turn? */
	hasPending(): boolean;
	setPending(handOff: HandOff): void;
	/** Names of all tool calls in the newest assistant message. */
	siblingCalls(): readonly string[];
	/** A reason the Planner may not hand over yet, or `undefined`. */
	planProblem(): string | undefined;
}

type Kind = HandOff["kind"];

function handOver(host: ToolHost, kind: Kind, text: string) {
	const agent = host.agent();
	if (!agent) throw new Error("No workflow is running; there is nothing to hand over.");
	if (host.siblingCalls().length > 1) {
		throw new Error(`\`${kind}\` must be the only tool call in its response. Call it again on its own.`);
	}
	if (host.hasPending()) throw new Error("A hand-over is already recorded for this turn.");
	if (kind === "return" && !isReviewer(agent)) throw new Error("Only reviewers can return work.");
	if (!text.trim())
		throw new Error(
			kind === "return" ? "Feedback must not be empty: say concretely what has to change." : "The summary must not be empty.",
		);
	if (kind === "advance" && agent === "planner") {
		const problem = host.planProblem();
		if (problem) throw new Error(problem);
	}
	host.setPending({ kind, text });
	return {
		content: [{ type: "text" as const, text: kind === "advance" ? "Hand-over recorded." : "Work returned; the feedback is recorded." }],
		details: undefined,
		terminate: true,
	};
}

export function registerTools(pi: ExtensionAPI, host: ToolHost): void {
	pi.registerTool({
		name: "advance",
		label: "Advance",
		description:
			"Hand over: your part of the workflow is done. As an author (Planner, Developer) it submits your work for review. As a reviewer it approves the work, only allowed when no issue is open. Call it on its own, never together with other tool calls.",
		parameters: Type.Object({
			summary: Type.String({
				description: "Authors: what was done, what to look at, how it was verified. Reviewers: your approval note (the user reads it).",
			}),
		}),
		defaultActive: false,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return handOver(host, "advance", params.summary);
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("advance"))}\n${theme.fg("toolOutput", args.summary ?? "")}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "return",
		label: "Return",
		description:
			"Reviewers only: send the work back to its author with concrete feedback. Use it for any open issue, however small — the work only moves on once no issue is left. The author gets the feedback and fixes the work. Call it on its own, never together with other tool calls.",
		parameters: Type.Object({
			feedback: Type.String({ description: "Concrete, actionable feedback: each problem, where it is, what should change." }),
		}),
		defaultActive: false,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			return handOver(host, "return", params.feedback);
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("return"))}\n${theme.fg("toolOutput", args.feedback ?? "")}`, 0, 0);
		},
	});
}
