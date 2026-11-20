/**
 * The conversations the reviewers read, as markdown texts: what the user and the author of the stage (Planner or
 * Developer) said in the current workflow. Pure: no pi imports.
 *
 * Read from the session record, so a compacted author loses nothing. Only text appears: thinking, tool calls and tool
 * results do not, and neither does anything the reviewers' segments hold. Session files are not validated, so the
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

/** The comment text the user wrote at a confirmation: `details.userFeedback` of a briefing. */
function userFeedbackOf(details: unknown): string {
	const text = (details as { userFeedback?: unknown } | null | undefined)?.userFeedback;
	return typeof text === "string" ? text.trim() : "";
}

/**
 * The conversation of workflow `workflowId` between the user and `author`, in order, one labelled block each: the user's
 * messages ("User"), the text of the author's answers (`author.label`) and the user's comments at the stage's
 * confirmation (`author.commentLabel`). No such workflow, or nothing said → one line saying it is empty.
 */
function conversation(
	entries: readonly ConversationEntry[],
	workflowId: string,
	author: { agent: string; label: string; commentLabel: string },
): string {
	const start = startOf(entries, workflowId);
	if (start < 0) return EMPTY;

	const blocks: string[] = [];
	const add = (label: string, text: string): void => {
		if (text !== "") blocks.push(`## ${label}\n\n${text}`);
	};

	// An author segment starts at a briefing or summary written for the author and runs to the next marker.
	let inAuthor = false;
	for (let i = start + 1; i < entries.length; i++) {
		const entry = entries[i];
		if (entry.type === "custom_message") {
			const type = entry.customType;
			if (type !== BRIEFING_TYPE && type !== SUMMARY_TYPE && type !== END_TYPE) continue;
			inAuthor = type !== END_TYPE && markerAgent(entry.details) === author.agent;
			if (inAuthor && type === BRIEFING_TYPE) add(author.commentLabel, userFeedbackOf(entry.details));
			continue;
		}
		if (!inAuthor || entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role === "user") add("User", textOf(entry.message?.content));
		else if (role === "assistant") add(author.label, textOf(entry.message?.content));
	}
	return blocks.length > 0 ? `${blocks.join("\n\n")}\n` : EMPTY;
}

/** What the user and the Planner said, for the Plan reviewer; the user's comments at the plan confirmation are "User (plan confirmation)". */
export function planningConversation(entries: readonly ConversationEntry[], workflowId: string): string {
	return conversation(entries, workflowId, { agent: "planner", label: "Planner", commentLabel: "User (plan confirmation)" });
}

/** What the user and the Developer said, for the Code reviewer; the user's comments at the code confirmation are "User (code confirmation)". */
export function developmentConversation(entries: readonly ConversationEntry[], workflowId: string): string {
	return conversation(entries, workflowId, { agent: "developer", label: "Developer", commentLabel: "User (code confirmation)" });
}
