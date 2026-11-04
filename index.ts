/**
 * dev-workflow — plan → build with four agents, run in the user's current pi session.
 *
 *   /dev      start a workflow (or, while one runs, offer to stop it)
 *
 * No child sessions, no extra processes. An "agent" is three things this extension swaps at every hand-off:
 *   1. a briefing   — a custom message with the role, the task and the file paths,
 *   2. a tool set   — `advance` always, `return` for reviewers only,
 *   3. a context    — the `context` hook shows the model the agent's own segments since the workflow started (each
 *                     beginning at one of its briefings) and hides the rest; after a compaction it shows the agent's
 *                     first briefing, its summary and its recent messages, then its own segments since; the screen
 *                     keeps all of it.
 *
 * Hand-offs are applied at the `turn_end` boundary, after the tool call has finished. The bar also shows the active
 * agent's context size and the workflow's cost so far, recomputed from the session record at each `turn_end`.
 * When the active agent's context passes pi's compaction threshold, the extension summarises that agent's older
 * conversation at the same boundary and appends the summary as a message in the chat. pi's own compaction is
 * cancelled while a workflow runs.
 * Plans: plans/01-BUSINESS-PLAN.md (what) and plans/01-TECHNICAL-PLAN.md (how).
 */

import { readFileSync, writeFileSync } from "node:fs";
import type {
	BoundaryResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { compact, DEFAULT_COMPACTION_SETTINGS, estimateTokens, findCutPoint, shouldCompact } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { type BriefingDetails, type EndDetails, type EndUsage, registerBanners } from "./banners.ts";
import { type BarUsage, createBar, themeStyle } from "./bar.ts";
import { buildBriefing } from "./briefings.ts";
import { agentView, collectFileOps, compactionSettings, planCompaction, summaryMessage, type ViewMessage } from "./compaction.ts";
import { BRIEFING_TYPE, briefedBefore, END_TYPE, type EntryLike, visibleMessages } from "./context.ts";
import { allocateRunDir, gitBaseline, planPath, planProblem } from "./files.ts";
import {
	AGENT_LABEL,
	type Feedback,
	type HandOff,
	initialState,
	isReviewer,
	type LimitChoice,
	type Next,
	type Outcome,
	type PlanChoice,
	parseState,
	resolvePlanConfirmation,
	resolveRoundLimit,
	STAGE_LABEL,
	STATE_ENTRY,
	type Stage,
	type Step,
	stageOf,
	transition,
	type WorkflowState,
} from "./machine.ts";
import { registerTools } from "./tools.ts";
import { agentContextTokens, isNoPrice, workflowTotals } from "./usage.ts";

const WIDGET_KEY = "dev-workflow";
const HAND_OFF_TOOLS = ["advance", "return"];

const APPROVE = "Approve and start development";
const EDIT_PLAN = "Edit plan…";
const SEND_BACK = "Send back to Planner…";
const STOP = "Stop workflow";
const CONTINUE = "Continue (one more round)";
const ACCEPT = "Accept as is";

/** Shown after /dev: the Planner makes no request until the user writes their first message. */
const READY_HINT = "Planner is ready — describe what you want to build.";

/** A dialog dismissed this many times in a row (Esc) counts as "stop", so nothing can spin forever. */
const MAX_DISMISSALS = 3;
/** Keep dialog titles short: the full text is already on screen in the hand-over call. */
const PREVIEW_CHARS = 300;

const preview = (text: string): string => {
	const flat = text.trim();
	return flat.length > PREVIEW_CHARS ? `${flat.slice(0, PREVIEW_CHARS)}…` : flat;
};

export default function devWorkflow(pi: ExtensionAPI): void {
	/** The running workflow. One at a time. Mirrored to the session as `dev-state` entries. */
	let state: WorkflowState | undefined;
	/** Recorded by a tool, consumed at `turn_end`. Deliberately not persisted. */
	let pending: HandOff | undefined;
	/** Names of the tool calls in the newest assistant message (recorded at `message_end`, before the tools run). */
	let lastCalls: string[] = [];
	let barTui: TUI | undefined;
	/** The figures next to the bar's boxes. Computed at events, read when the bar renders. */
	let usage: BarUsage | undefined;

	// ───────────────────────────── tools ─────────────────────────────

	const isHandOffTool = (name: string) => HAND_OFF_TOOLS.includes(name);
	const baseTools = (s: WorkflowState) => s.savedTools.filter((t) => !isHandOffTool(t));
	const toolsFor = (s: WorkflowState): string[] => [...baseTools(s), "advance", ...(isReviewer(s.agent) ? ["return"] : [])];

	function dropHandOffTools(): void {
		const active = pi.getActiveTools();
		if (active.some(isHandOffTool)) pi.setActiveTools(active.filter((t) => !isHandOffTool(t)));
	}

	registerTools(pi, {
		agent: () => state?.agent,
		hasPending: () => pending !== undefined,
		setPending: (handOff) => {
			pending = handOff;
		},
		siblingCalls: () => lastCalls,
		planProblem: () => (state ? planProblem(state.dir) : undefined),
	});
	registerBanners(pi);

	// ───────────────────────────── bar ─────────────────────────────

	function showBar(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				barTui = tui;
				return createBar(
					() => state,
					() => usage,
					themeStyle(theme),
				);
			},
			{ placement: "belowEditor" },
		);
	}

	function hideBar(ctx: ExtensionContext): void {
		barTui = undefined;
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET_KEY, undefined);
	}

	const refreshBar = () => barTui?.requestRender();

	/** What workflow `id` has cost, from the session record, and whether that should read "no price". */
	function measureTotals(ctx: ExtensionContext, id: string): EndUsage {
		const totals = workflowTotals(ctx.sessionManager.getBranch(), id);
		return { totals, noPrice: isNoPrice(totals.cost, ctx.model?.cost) };
	}

	/** The figures for the bar: the workflow's cost and the active agent's context (absent until it has answered). */
	function measureUsage(ctx: ExtensionContext, s: WorkflowState): BarUsage {
		const { totals, noPrice } = measureTotals(ctx, s.id);
		const tokens = agentContextTokens(ctx.sessionManager.getBranch(), estimateTokens);
		const window = ctx.model?.contextWindow;
		return {
			cost: totals.cost,
			noPrice,
			...(tokens === undefined ? {} : { context: { tokens, ...(window && window > 0 ? { window } : {}) } }),
		};
	}

	// ───────────────────────────── messages ─────────────────────────────

	/** `resumed`: the agent has been briefed before in this workflow, so its message is the short one. */
	function briefingMessage(s: WorkflowState, extra: { summary?: string; feedback?: Feedback }, resumed: boolean) {
		const stage = stageOf(s.agent);
		const details: BriefingDetails = { agent: s.agent, round: s.round[stage], roundLimit: s.roundLimit[stage] };
		return {
			customType: BRIEFING_TYPE,
			content: buildBriefing({ ...details, planPath: planPath(s.dir), baseline: s.baseline, ...extra, resumed }),
			display: true,
			details,
		};
	}

	function endMessage(s: WorkflowState, outcome: Outcome, spent: EndUsage, note?: string) {
		const plan = planPath(s.dir);
		const details: EndDetails = { outcome, planPath: plan, ...(note ? { note } : {}), usage: spent };
		const lines = [
			`[dev-workflow] Workflow ${s.id} ${outcome}.`,
			`Plan: ${plan}`,
			...(note ? [`Note: ${note}`] : []),
			...(outcome === "stopped" ? ["Files already written stay in place."] : []),
			"The workflow's conversations are not part of this context.",
		];
		return { customType: END_TYPE, content: lines.join("\n"), display: true, details };
	}

	/** Everything that ends a workflow except writing the closing note: tools, bar, state. */
	function closeDown(ctx: ExtensionContext, s: WorkflowState, outcome: Outcome): void {
		pi.setActiveTools(baseTools(s));
		state = undefined;
		pending = undefined;
		usage = undefined;
		hideBar(ctx);
		ctx.ui.notify(outcome === "finished" ? `Workflow ${s.id} finished.` : `Workflow ${s.id} stopped.`, "info");
	}

	// ───────────────────────────── restore ─────────────────────────────

	/** Rebuild everything from the newest `dev-state` entry on the current branch. */
	function restore(ctx: ExtensionContext): void {
		let restored: WorkflowState | undefined;
		const branch = ctx.sessionManager.getBranch() as { type: string; customType?: string; data?: unknown }[];
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type === "custom" && e.customType === STATE_ENTRY) {
				restored = parseState(e.data);
				break;
			}
		}
		state = restored;
		pending = undefined;
		usage = state ? measureUsage(ctx, state) : undefined;
		if (state) {
			pi.setActiveTools(toolsFor(state));
			showBar(ctx);
		} else {
			dropHandOffTools();
			hideBar(ctx);
		}
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => hideBar(ctx));

	// ───────────────────────────── context isolation ─────────────────────────────

	pi.on("context", (event) => {
		const visible = visibleMessages(event.messages as { role: string; customType?: string; details?: unknown }[]);
		return visible === event.messages ? undefined : { messages: visible as typeof event.messages };
	});

	pi.on("message_end", (event) => {
		const message = event.message as { role: string; content?: unknown };
		if (message.role !== "assistant") return;
		const content = Array.isArray(message.content) ? (message.content as { type: string; name?: string }[]) : [];
		lastCalls = content.filter((c) => c.type === "toolCall").map((c) => c.name ?? "");
	});

	/**
	 * pi compacts the whole session: it would summarise every agent's conversation together and redraw the chat from the
	 * summary. So pi's own compaction is cancelled while a workflow runs, and the extension compacts each agent itself.
	 */
	pi.on("session_before_compact", (event, ctx) => {
		if (!state) return;
		if (event.reason === "manual") {
			ctx.ui.notify("/compact is not available while a workflow runs: each agent's context is compacted automatically.", "warning");
		}
		return { cancel: true };
	});

	// ───────────────────────────── dialogs ─────────────────────────────

	/** `select` that re-asks when dismissed; `undefined` after `MAX_DISMISSALS` dismissals in a row. */
	async function ask(ctx: ExtensionContext, title: string, options: string[]): Promise<string | undefined> {
		for (let i = 0; i < MAX_DISMISSALS; i++) {
			const choice = await ctx.ui.select(title, options);
			if (choice !== undefined) return choice;
		}
		return undefined;
	}

	async function askPlan(ctx: ExtensionContext, s: WorkflowState, next: Extract<Next, { type: "confirm-plan" }>): Promise<PlanChoice> {
		const plan = planPath(s.dir);
		const said = next.approved ? `The Plan reviewer approved the plan: ${preview(next.note)}` : preview(next.note);
		const title = `Confirm the plan\n${plan}\n\n${said}`;
		for (;;) {
			switch (await ask(ctx, title, [APPROVE, EDIT_PLAN, SEND_BACK, STOP])) {
				case APPROVE:
					return { kind: "approve" };
				case EDIT_PLAN: {
					const before = readFileSync(plan, "utf8");
					const after = await ctx.ui.editor("Edit plan", before);
					if (after !== undefined && after !== before) writeFileSync(plan, after);
					continue; // ask again
				}
				case SEND_BACK: {
					const comments = (await ctx.ui.editor("Comments for the Planner", ""))?.trim();
					if (comments) return { kind: "send-back", comments };
					continue; // nothing written → ask again
				}
				default:
					return { kind: "stop" };
			}
		}
	}

	async function askLimit(ctx: ExtensionContext, s: WorkflowState, stage: Stage, feedback: string): Promise<LimitChoice> {
		const title = `Round limit reached — ${STAGE_LABEL[stage]}: ${s.round[stage]} round(s) without approval\nLast feedback: ${preview(feedback)}`;
		switch (await ask(ctx, title, [CONTINUE, ACCEPT, STOP])) {
			case CONTINUE:
				return "continue";
			case ACCEPT:
				return "accept";
			default:
				return "stop";
		}
	}

	/** Follow a step through the dialogs until it is something the boundary can apply: `activate` or `end`. */
	async function settle(ctx: ExtensionContext, start: Step): Promise<Step> {
		let step = start;
		for (;;) {
			const { next } = step;
			switch (next.type) {
				case "activate":
				case "end":
					return step;
				case "confirm-plan":
					step = resolvePlanConfirmation(step.state, await askPlan(ctx, step.state, next));
					break;
				case "round-limit":
					step = resolveRoundLimit(step.state, next.stage, next.feedback, await askLimit(ctx, step.state, next.stage, next.feedback));
					break;
			}
		}
	}

	// ───────────────────────────── compaction ─────────────────────────────

	/**
	 * Summarise the active agent's older conversation when its context (`tokens`, as the bar shows it) is over pi's
	 * threshold. Returns the `dev-summary` message to append and what the summary cost; `undefined` when there is
	 * nothing to do, the run was interrupted, or the summary could not be written (that is reported).
	 */
	async function compactAgent(
		ctx: ExtensionContext,
		s: WorkflowState,
		tokens: number | undefined,
	): Promise<{ draft: SessionBoundaryDraft; cost: number } | undefined> {
		const model = ctx.model;
		if (ctx.signal?.aborted || tokens === undefined || !model) return undefined;
		if (typeof model.contextWindow !== "number" || !(model.contextWindow > 0)) return undefined;
		const settings = compactionSettings(pi.getSettings(), model, DEFAULT_COMPACTION_SETTINGS);
		if (!shouldCompact(tokens, model.contextWindow, settings)) return undefined;

		const view = agentView(ctx.sessionManager.buildSessionProjection().messages as unknown as ViewMessage[]);
		const plan = planCompaction(view, { keepRecentTokens: settings.keepRecentTokens, findCutPoint });
		if (!plan) return undefined;

		const label = AGENT_LABEL[s.agent];
		ctx.ui.notify(`Compacting ${label}'s context…`, "info");
		try {
			// `compact()` wants a non-empty id for the first kept entry and hands it back unused: the kept messages are
			// counted in the summary message, not named.
			const result = await compact(
				{
					firstKeptEntryId: "dev-workflow",
					messagesToSummarize: plan.messagesToSummarize,
					turnPrefixMessages: plan.turnPrefixMessages,
					isSplitTurn: plan.isSplitTurn,
					tokensBefore: tokens,
					previousSummary: plan.previousSummary,
					fileOps: collectFileOps(plan.messagesToSummarize, plan.turnPrefixMessages, plan.previousFiles),
					settings,
				} as Parameters<typeof compact>[0],
				model,
				undefined,
				undefined,
				undefined,
				ctx.signal,
				ctx.thinkingLevel,
				// Through the session's provider, authenticated when the request is made.
				(m, context, options) => ctx.modelRegistry.streamSimple(m as never, context as never, options as never),
			);
			const details = result.details as { readFiles?: string[]; modifiedFiles?: string[] } | undefined;
			const cost = result.usage?.cost?.total ?? 0;
			const message = summaryMessage({
				agent: s.agent,
				view,
				plan,
				tokensBefore: tokens,
				summary: result.summary,
				readFiles: details?.readFiles ?? [],
				modifiedFiles: details?.modifiedFiles ?? [],
				usage: result.usage,
				noPrice: isNoPrice(cost, model.cost),
				estimate: estimateTokens,
			});
			return { draft: { type: "custom_message", ...message }, cost };
		} catch (error) {
			// Esc aborts the run, and with it the summary request: that is not a failure to report.
			if (ctx.signal?.aborted) return undefined;
			ctx.ui.notify(`Could not compact ${label}'s context: ${error instanceof Error ? error.message : String(error)}`, "warning");
			return undefined;
		}
	}

	/** A summary is about to be written: the agent's context figure is gone until it answers again, and the summary's cost counts. */
	function countCompaction(ctx: ExtensionContext, cost: number): void {
		const total = (usage?.cost ?? 0) + cost;
		usage = { cost: total, noPrice: isNoPrice(total, ctx.model?.cost) };
		refreshBar();
	}

	// ───────────────────────────── the hand-off boundary ─────────────────────────────

	pi.on("turn_end", async (event, ctx): Promise<BoundaryResult | undefined> => {
		// The answer and its tool results are in the session now: refresh the figures, so a dialog below shows them.
		if (state) {
			usage = measureUsage(ctx, state);
			refreshBar();
		}
		const tokens = usage?.context?.tokens;
		const handOff = pending;
		pending = undefined;
		// The turn did not complete (Esc, error): the agent stays as it is.
		if (!state || event.outcome !== "completed") return;

		const current = state;
		if (!handOff) {
			// Nothing handed over: the agent's context may have grown past the threshold.
			const compacted = await compactAgent(ctx, current, tokens);
			if (!compacted || state !== current) return;
			countCompaction(ctx, compacted.cost);
			return { entries: [compacted.draft] };
		}

		const step = await settle(ctx, transition(current, handOff));
		if (state !== current) return; // stopped (or replaced) while a dialog was open

		const next = step.next;
		if (next.type === "end") {
			const message = endMessage(step.state, next.outcome, measureTotals(ctx, step.state.id), next.note);
			closeDown(ctx, step.state, next.outcome);
			// No `continue`: the run ends because the hand-off tool batch terminated.
			return {
				entries: [
					{ type: "custom", customType: STATE_ENTRY, data: null },
					{ type: "custom_message", ...message },
				],
			};
		}

		if (next.type !== "activate") return; // settle() only returns activate / end

		// Another agent follows: the one that just answered is compacted, and its summary goes in before the new briefing.
		const compacted = await compactAgent(ctx, current, tokens);
		if (state !== current) return;

		let entering = step.state;
		if (entering.agent === "developer" && !entering.baseline) {
			entering = { ...entering, baseline: await gitBaseline((cmd, args) => pi.exec(cmd, args, { cwd: ctx.cwd })) };
			if (state !== current) return;
		}
		state = entering;
		if (compacted) countCompaction(ctx, compacted.cost);
		usage = usage && { ...usage, context: undefined }; // the previous agent's figure is gone at once
		pi.setActiveTools(toolsFor(entering));
		refreshBar();
		// "Briefed before" is read from the session, so it is right after `/resume`, `/reload` and `/tree`. The new
		// briefing is not in the branch yet.
		const resumed = briefedBefore(ctx.sessionManager.getBranch() as EntryLike[], entering.agent);
		const entries: SessionBoundaryDraft[] = [
			...(compacted ? [compacted.draft] : []),
			{ type: "custom", customType: STATE_ENTRY, data: entering },
			{ type: "custom_message", ...briefingMessage(entering, { summary: next.summary, feedback: next.feedback }, resumed) },
		];
		return { entries, continue: true };
	});

	// ───────────────────────────── /dev ─────────────────────────────

	async function start(ctx: ExtensionContext): Promise<void> {
		if (!ctx.isIdle()) {
			ctx.ui.notify("Wait for the current response to finish, then run /dev again.", "warning");
			return;
		}
		const { id, dir } = allocateRunDir(ctx.cwd);
		state = initialState({ id, dir, savedTools: pi.getActiveTools() });
		pending = undefined;
		pi.setActiveTools(toolsFor(state));
		pi.appendEntry(STATE_ENTRY, state);
		usage = { cost: 0, noPrice: isNoPrice(0, ctx.model?.cost) };
		showBar(ctx);
		// The workflow now waits for the user's first message: the briefing is only appended, no turn starts.
		pi.sendMessage(briefingMessage(state, {}, false));
		ctx.ui.notify(READY_HINT, "info");
	}

	async function stop(ctx: ExtensionCommandContext): Promise<void> {
		const running = state;
		if (!running) return;
		const choice = await ctx.ui.select(`Workflow ${running.id} is running — ${AGENT_LABEL[running.agent]} is active`, [STOP, "Cancel"]);
		if (choice !== STOP) return;
		if (!ctx.isIdle()) {
			ctx.abort();
			await ctx.waitForIdle();
		}
		if (state !== running) return; // it ended by itself in the meantime
		const message = endMessage(running, "stopped", measureTotals(ctx, running.id));
		closeDown(ctx, running, "stopped");
		pi.appendEntry(STATE_ENTRY, null);
		pi.sendMessage(message);
	}

	pi.registerCommand("dev", {
		description: "Start the plan → build workflow with four agents (while one runs: stop it)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/dev works in the interactive terminal UI only.", "error");
				return;
			}
			if (state) await stop(ctx);
			else await start(ctx);
		},
	});
}
