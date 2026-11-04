/**
 * Banners in the chat: a band whenever the active agent changes, one when an agent's context is compacted, and one when
 * the workflow ends. All are `display: true` custom messages; these renderers replace pi's default drawing.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import { briefingTitle } from "./briefings.ts";
import { type SummaryDetails, summaryTitle } from "./compaction.ts";
import { BRIEFING_TYPE, END_TYPE, SUMMARY_TYPE } from "./context.ts";
import { AGENT_LABEL, type Agent, type Outcome } from "./machine.ts";
import { summaryLines, type UsageTotals } from "./usage.ts";

/** `details` of a `dev-briefing` message. */
export interface BriefingDetails {
	agent: Agent;
	round: number;
	roundLimit: number;
}

/** What a whole workflow cost, and whether that should read "no price". */
export type EndUsage = { totals: UsageTotals; noPrice: boolean };

/** `details` of a `dev-end` message. */
export interface EndDetails {
	outcome: Outcome;
	planPath: string;
	/** The closing reviewer's approval note, or why the workflow ended otherwise. */
	note?: string;
	/** What the whole workflow cost, measured when it ended. Absent on older messages. */
	usage?: EndUsage;
}

export function registerBanners(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<BriefingDetails>(BRIEFING_TYPE, (message, { expanded, outputPad }, theme) => {
		const d = message.details;
		if (!d) return undefined;
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", theme.bold(`▶ ${briefingTitle(d.agent, d.round, d.roundLimit)}`)), 0, 0));
		if (expanded) {
			const text =
				typeof message.content === "string" ? message.content : message.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			box.addChild(new Text("", 0, 0));
			box.addChild(new Markdown(text, 0, 0, getMarkdownTheme()));
		}
		return box;
	});

	pi.registerMessageRenderer<SummaryDetails>(SUMMARY_TYPE, (message, { expanded, outputPad }, theme) => {
		const d = message.details;
		if (!d) return undefined;
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", theme.bold(summaryTitle(AGENT_LABEL[d.agent], d))), 0, 0));
		if (expanded) {
			box.addChild(new Text("", 0, 0));
			box.addChild(new Markdown(d.summary, 0, 0, getMarkdownTheme()));
		}
		return box;
	});

	pi.registerMessageRenderer<EndDetails>(END_TYPE, (message, { outputPad }, theme) => {
		const d = message.details;
		if (!d) return undefined;
		const finished = d.outcome === "finished";
		const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const head = finished ? theme.fg("success", theme.bold("✓ Workflow finished")) : theme.fg("warning", theme.bold("✗ Workflow stopped"));
		box.addChild(new Text(head, 0, 0));
		box.addChild(new Text(theme.fg("muted", `Plan: ${d.planPath}`), 0, 0));
		if (d.note) box.addChild(new Text(theme.fg("muted", d.note), 0, 0));
		if (d.usage) for (const line of summaryLines(d.usage.totals, d.usage.noPrice)) box.addChild(new Text(theme.fg("muted", line), 0, 0));
		return box;
	});
}
