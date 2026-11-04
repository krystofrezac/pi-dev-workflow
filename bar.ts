/**
 * Bottom bar: two bordered groups, one per stage, each with its two agents, and two figures to the right of them:
 * how full the active agent's context is (top row, absent until that agent has answered) and what the whole
 * workflow has cost (middle row).
 *
 *   ╭─ Planning · round 2/3 ──────────╮ ╭─ Development · not started ─────╮  agent ctx 1.2k/200k · 1%
 *   │ ✓ Planner   ▶ Plan reviewer     │ │   Developer   Code reviewer     │  workflow $0.087
 *   ╰─────────────────────────────────╯ ╰─────────────────────────────────╯
 *
 * Where the figures do not fit to the right (a narrow terminal), they go on one extra row below the bar, joined
 * with ` │ ` (`agent ctx 1.2k/200k · 1% │ workflow $0.087`); the collapsed one-line bar gets that row too.
 *
 * `renderBar()` is pure. It lays the bar out as plain text first (so widths are exact) and styles the pieces
 * afterwards. The only pi imports are types, so the layout is unit-testable.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { AGENT_LABEL, type Agent, agentsOf, STAGE_LABEL, STAGES, type Stage, stageOf, type WorkflowState } from "./machine.ts";
import { contextParts, workflowText } from "./usage.ts";

/** The part of the state the bar draws. */
export type BarView = Pick<WorkflowState, "agent" | "round" | "roundLimit" | "visited">;

export interface BarStyle {
	/** The active agent: accent + bold. */
	active(text: string): string;
	/** An agent that handed over in this stage: dimmed. */
	done(text: string): string;
	/** An agent not reached yet: muted. */
	waiting(text: string): string;
	/** Border and title of the stage that is running. */
	accent(text: string): string;
	/** Border and title of the other stage. */
	muted(text: string): string;
	/** The figures to the right of the boxes: normal weight, muted. */
	item(text: string): string;
	/** The context value above 70 %. */
	warning(text: string): string;
	/** The context value above 90 %. */
	error(text: string): string;
}

/** The figures the bar shows next to the boxes. */
export interface BarUsage {
	/** The active agent's context; absent until it has answered. `window` is unknown when absent. */
	context?: { tokens: number; window?: number };
	/** What the workflow has cost so far. */
	cost: number;
	/** Show `no price` instead of the amount. */
	noPrice: boolean;
}

export const plainStyle: BarStyle = {
	active: (t) => t,
	done: (t) => t,
	waiting: (t) => t,
	accent: (t) => t,
	muted: (t) => t,
	item: (t) => t,
	warning: (t) => t,
	error: (t) => t,
};

export function themeStyle(theme: Theme): BarStyle {
	return {
		active: (t) => theme.fg("accent", theme.bold(t)),
		done: (t) => theme.fg("dim", t),
		waiting: (t) => theme.fg("muted", t),
		accent: (t) => theme.fg("accent", t),
		muted: (t) => theme.fg("borderMuted", t),
		item: (t) => theme.fg("muted", t),
		warning: (t) => theme.fg("warning", t),
		error: (t) => theme.fg("error", t),
	};
}

type Mark = "active" | "done" | "waiting";

function markOf(view: BarView, agent: Agent): Mark {
	if (agent === view.agent) return "active";
	const current = STAGES.indexOf(stageOf(view.agent));
	const own = STAGES.indexOf(stageOf(agent));
	if (own < current) return "done";
	if (own > current) return "waiting";
	return view.visited.includes(agent) ? "done" : "waiting";
}

const GLYPH: Record<Mark, string> = { active: "▶", done: "✓", waiting: " " };
const cellText = (mark: Mark, agent: Agent) => `${GLYPH[mark]} ${AGENT_LABEL[agent]}`;
const GAP = 3; // spaces between the two agents of a stage

function titleOf(view: BarView, stage: Stage): string {
	const current = STAGES.indexOf(stageOf(view.agent));
	const own = STAGES.indexOf(stage);
	if (own < current) return `${STAGE_LABEL[stage]} · done`;
	if (own > current) return `${STAGE_LABEL[stage]} · not started`;
	return `${STAGE_LABEL[stage]} · round ${view.round[stage]}/${view.roundLimit[stage]}`;
}

/** Natural width of a stage box (border included). */
function naturalWidth(view: BarView, stage: Stage): number {
	const [a, b] = agentsOf(stage);
	const content = 1 + cellText("done", a).length + GAP + cellText("done", b).length + 1;
	return Math.max(content + 2, titleOf(view, stage).length + 6);
}

function box(view: BarView, stage: Stage, width: number, style: BarStyle): [string, string, string] {
	const running = stageOf(view.agent) === stage;
	const border = running ? style.accent : style.muted;
	const title = titleOf(view, stage);
	const cells = agentsOf(stage).map((agent) => {
		const mark = markOf(view, agent);
		return { text: cellText(mark, agent), paint: style[mark] };
	});

	const inner = width - 2;
	const used = 1 + cells[0].text.length + GAP + cells[1].text.length;
	const top = `${border("╭─ ")}${border(title)} ${border(`${"─".repeat(width - title.length - 5)}╮`)}`;
	const middle = `${border("│")} ${cells[0].paint(cells[0].text)}${" ".repeat(GAP)}${cells[1].paint(cells[1].text)}${" ".repeat(inner - used)}${border("│")}`;
	const bottom = border(`╰${"─".repeat(inner)}╯`);
	return [top, middle, bottom];
}

/** Collapsed form for narrow terminals: `Planning 2/3 · ▶ Plan reviewer`. */
function oneLine(view: BarView, width: number, style: BarStyle): string[] {
	const stage = stageOf(view.agent);
	const text = `${STAGE_LABEL[stage]} ${view.round[stage]}/${view.roundLimit[stage]} · ▶ ${AGENT_LABEL[view.agent]}`;
	const chars = [...text];
	const fitted = chars.length > width ? `${chars.slice(0, Math.max(0, width - 1)).join("")}…` : text;
	return [style.active(fitted)];
}

function twoBoxes(view: BarView, boxWidth: number, style: BarStyle): string[] {
	const [left, right] = STAGES.map((stage) => box(view, stage, boxWidth, style));
	return [0, 1, 2].map((row) => `${left[row]} ${right[row]}`);
}

/** A run of text and how to paint it. The text is laid out first, the painting happens when a row is put together. */
interface Piece {
	text: string;
	paint: (text: string) => string;
}

const WARNING_PERCENT = 70;
const ERROR_PERCENT = 90;
const ITEM_GAP = "  "; // between the right box and the figures
const ITEM_JOIN = " │ "; // between the figures on the extra row

const plainOf = (pieces: Piece[]) => pieces.map((p) => p.text).join("");
const paintOf = (pieces: Piece[]) => pieces.map((p) => p.paint(p.text)).join("");

/**
 * The two figures as pieces. The context item is two pieces: the label, and the value (tokens, window and percent
 * together) that changes colour above 70 % / 90 %. The workflow item is one piece.
 */
function itemsOf(usage: BarUsage, style: BarStyle): { context?: Piece[]; workflow: Piece[] } {
	const workflow = [{ text: workflowText(usage.cost, usage.noPrice), paint: style.item }];
	if (!usage.context) return { workflow };
	const { label, value, percent } = contextParts(usage.context);
	const paint =
		percent === undefined ? style.item : percent > ERROR_PERCENT ? style.error : percent > WARNING_PERCENT ? style.warning : style.item;
	return {
		context: [
			{ text: label, paint: style.item },
			{ text: value, paint },
		],
		workflow,
	};
}

/** The figures on one row of their own: joined with ` │ `, and cut with a closing `…` when even that is too wide. */
function itemsRow(items: { context?: Piece[]; workflow: Piece[] }, width: number, style: BarStyle): string {
	const groups = items.context ? [items.context, items.workflow] : [items.workflow];
	const text = groups.map(plainOf).join(ITEM_JOIN);
	const chars = [...text];
	if (chars.length > width) return style.item(`${chars.slice(0, Math.max(0, width - 1)).join("")}…`);
	return groups.map(paintOf).join(style.item(ITEM_JOIN));
}

/**
 * The bar as rows. With `usage`: the figures go to the right of the boxes (context on the top row, workflow on the
 * middle row, which it keeps while the context is absent) when they fit there, else on one extra row below.
 */
export function renderBar(view: BarView, width: number, style: BarStyle = plainStyle, usage?: BarUsage): string[] {
	const boxWidth = Math.max(...STAGES.map((stage) => naturalWidth(view, stage)));
	const boxesWidth = boxWidth * 2 + 1;
	const collapsed = boxesWidth > width;
	const rows = collapsed ? oneLine(view, width, style) : twoBoxes(view, boxWidth, style);
	if (!usage) return rows;

	const items = itemsOf(usage, style);
	const widest = Math.max(...[items.context, items.workflow].map((item) => (item ? plainOf(item).length : 0)));
	if (collapsed || boxesWidth + ITEM_GAP.length + widest > width) return [...rows, itemsRow(items, width, style)];
	const [top, middle, bottom] = rows;
	return [items.context ? `${top}${ITEM_GAP}${paintOf(items.context)}` : top, `${middle}${ITEM_GAP}${paintOf(items.workflow)}`, bottom];
}

/**
 * The widget component: reads the view and the figures at render time, so `tui.requestRender()` is all a change
 * needs. The bar can be a row taller than its boxes, where the figures need a row of their own (a fourth row under
 * the boxes, a second one under the collapsed bar).
 */
export function createBar(getView: () => BarView | undefined, getUsage: () => BarUsage | undefined, style: BarStyle): Component {
	return {
		render(width: number): string[] {
			const view = getView();
			return view ? renderBar(view, width, style, getUsage()) : [];
		},
		invalidate() {},
	};
}
