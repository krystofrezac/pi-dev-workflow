/**
 * The planning conversation as a markdown text: what the user and the Planner said in the current workflow. Pure: no pi
 * imports.
 *
 * Read from the session record, so a compacted Planner loses nothing. Only text appears: thinking, tool calls and tool
 * results do not, and neither does anything the Plan reviewer's segments hold. Session files are not validated, so the
 * entry type is structural and tolerant: an unknown shape counts as nothing.
 */

import { BRIEFING_TYPE, END_TYPE, markerAgent, SUMMARY_TYPE } from "./context.ts";
import { startOf } from "./usage.ts";

/** The part of a session entry read here. */
export interface ConversationEntry {
	type: string;
	customType?: string;
	data?: unknown;
	details?: unknown;
	message?: { role?: string; content?: unknown };
}

const EMPTY = "(The conversation is empty.)";

/** The text parts of a message's content, joined; non-text parts (images, thinking, tool calls) are left out. */
function textOf(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			const p = part as { type?: unknown; text?: unknown } | null;
			return p?.type === "text" && typeof p.text === "string" ? p.text.trim() : "";
		})
		.filter((text) => text !== "")
		.join("\n\n");
}

/** The comment text the user wrote when sending the plan back: `details.userFeedback` of a briefing. */
function userFeedbackOf(details: unknown): string {
	const text = (details as { userFeedback?: unknown } | null | undefined)?.userFeedback;
	return typeof text === "string" ? text.trim() : "";
}

/**
 * The conversation of workflow `workflowId` between the user and the Planner, in order, one labelled block each: the
 * user's messages ("User"), the text of the Planner's answers ("Planner") and the user's comments when they sent the
 * plan back ("User (plan confirmation)"). No such workflow, or nothing said → one line saying it is empty.
 */
export function planningConversation(entries: readonly ConversationEntry[], workflowId: string): string {
	const start = startOf(entries, workflowId);
	if (start < 0) return EMPTY;

	const blocks: string[] = [];
	const add = (label: string, text: string): void => {
		if (text !== "") blocks.push(`## ${label}\n\n${text}`);
	};

	// A Planner segment starts at a briefing or summary written for the Planner and runs to the next marker.
	let inPlanner = false;
	for (let i = start + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type === "custom_message") {
			const type = entry.customType;
			if (type !== BRIEFING_TYPE && type !== SUMMARY_TYPE && type !== END_TYPE) continue;
			inPlanner = type !== END_TYPE && markerAgent(entry.details) === "planner";
			if (inPlanner && type === BRIEFING_TYPE) add("User (plan confirmation)", userFeedbackOf(entry.details));
			continue;
		}
		if (!inPlanner || entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role === "user") add("User", textOf(entry.message?.content));
		else if (role === "assistant") add("Planner", textOf(entry.message?.content));
	}
	return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : EMPTY;
}
