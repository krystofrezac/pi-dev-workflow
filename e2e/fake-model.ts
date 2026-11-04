/**
 * Scripted fake model for testing the REAL dev-workflow extension end to end (see drive-tui.py).
 *
 *   npm run e2e [-- scenario ...]     (`real` is opt-in: E2E_REAL_MODEL)
 *
 * It reads the real briefings it is sent (`# Planning · Planner · round 1/3`, …) and behaves like a very obedient
 * agent. The plan path comes from the agent's first briefing, the agent and the round from its newest one. Every
 * request is appended to E2E_LOG exactly as received — that is what a provider would have seen. A request to summarise
 * an agent's context (its system prompt starts with `You are a context summarization assistant`) is answered with a
 * fixed short summary and logged with `summary: true` and the full text of its user message.
 *
 * Env: E2E_LOG · E2E_PLAN_APPROVE_ROUND (default 2) · E2E_CODE_APPROVE_ROUND (default 2) ·
 *      E2E_PAD (chars of padding in the plan, to grow the planner's context) · E2E_CONTEXT_WINDOW ·
 *      E2E_NO_COMBO=1 (the Planner hands over with `advance` alone, instead of first trying `advance` + `bash`) ·
 *      E2E_SLEEP=<seconds> (the Planner's first answer to the assignment is a long `bash sleep`, so a run can be interrupted) ·
 *      E2E_ASK=1 (the Planner's first answer to the user's message is a plain-text question; its scripted turns then follow the user's reply)
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
	createFauxCore,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	getCurrentTools,
	type Message,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const LOG = process.env.E2E_LOG;
const PLAN_APPROVE_ROUND = Number(process.env.E2E_PLAN_APPROVE_ROUND ?? 2);
const CODE_APPROVE_ROUND = Number(process.env.E2E_CODE_APPROVE_ROUND ?? 2);
const PAD = Number(process.env.E2E_PAD ?? 0);
const CONTEXT_WINDOW = Number(process.env.E2E_CONTEXT_WINDOW ?? 128000);
const NO_COMBO = process.env.E2E_NO_COMBO === "1";
const SLEEP = Number(process.env.E2E_SLEEP ?? 0);
const ASK = process.env.E2E_ASK === "1";

const t0 = Date.now();
function log(ev: string, data: Record<string, unknown>) {
	if (!LOG) return;
	mkdirSync(dirname(LOG), { recursive: true });
	appendFileSync(LOG, `${JSON.stringify({ t: Date.now() - t0, ev, ...data })}\n`);
}

const text = (m: Message): string =>
	typeof m.content === "string"
		? m.content
		: (m.content ?? []).map((b) => (b.type === "text" ? b.text : b.type === "toolCall" ? `<call ${b.name}>` : "")).join("");

const HEAD = /^# (Planning|Development) · ([\w ]+) · round (\d+)\/(\d+)/;

const SUMMARY_REQUEST = "You are a context summarization assistant";

function brain(context: TranscriptContext) {
	const all = context.messages;
	const first = all.find((m) => m.role === "system");
	if (first && text(first).startsWith(SUMMARY_REQUEST)) {
		const asked = all.find((m) => m.role === "user");
		log("request", { summary: true, text: asked ? text(asked) : "" });
		return fauxAssistantMessage("## Goal\n(fake) summary of the conversation");
	}
	const conv = all.filter((m) => m.role !== "system");
	const tools = getCurrentTools(all).map((t) => t.name);
	const briefings = conv.map((m, i) => ({ m, i })).filter(({ m }) => m.role === "user" && HEAD.test(text(m)));
	log("request", {
		n: conv.length,
		conversation: conv.map((m) => `${m.role}:${text(m).replace(/\s+/g, " ").slice(0, 70)}`),
		briefings: briefings.map(({ m }) => text(m).split("\n")[0]),
		tools,
	});

	const call = (...c: ReturnType<typeof fauxToolCall>[]) => fauxAssistantMessage(c, { stopReason: "toolUse" });

	if (briefings.length === 0) {
		return fauxAssistantMessage(
			`(fake) no briefing in my context; I see ${conv.length} message(s): ${conv.map((m) => `${m.role}:${text(m).slice(0, 50)}`).join(" | ")}`,
		);
	}

	const { m: b, i: bi } = briefings[briefings.length - 1];
	const body = text(b);
	const head = HEAD.exec(body);
	if (!head) throw new Error(`not a briefing: ${body.slice(0, 80)}`);
	const [, , agentLabel, roundText] = head;
	const round = Number(roundText);
	// Every briefing in a request belongs to one agent; only its first one names the plan file.
	const planPath = /`(\/[^`]*plan\.md)`/.exec(text(briefings[0].m))?.[1] ?? "";
	// A re-activation message is the title line, a blank line, then `Returned from <label>: …`. The first-time briefing
	// has that phrase only inside its rules text, so the test is anchored at the start of the message.
	const returned = /^# .*\n\nReturned from [^:\n]+: ([\s\S]*)$/.exec(body);
	const runDir = dirname(planPath);
	const repo = dirname(dirname(dirname(runDir)));
	const after = conv.slice(bi + 1);
	const turns = after.filter((m) => m.role === "assistant").length;
	const lastUser = [...after].reverse().find((m) => m.role === "user");
	const pad = PAD > 0 ? `\n${"padding ".repeat(Math.ceil(PAD / 8)).slice(0, PAD)}\n` : "";

	switch (agentLabel) {
		case "Planner": {
			if (returned === null) {
				if (ASK && turns === 0) return fauxAssistantMessage("Which file name do you want?");
				const step = ASK ? turns - 1 : turns;
				if (step === 0 && SLEEP > 0) return call(fauxToolCall("bash", { command: `sleep ${SLEEP}` }));
				if (step === 0) {
					const answer = lastUser ? text(lastUser).trim() : "?";
					return call(
						fauxToolCall("write", {
							path: planPath,
							content: `# Plan\n\n## Assignment\nThe user said: "${answer}"\n\n## Scope\n- In: ${answer}\n- Out: everything else\n\n## Steps\n1. Create hello.txt in the project root.\n\n## How to verify\n\`cat hello.txt\`\n${pad}`,
						}),
					);
				}
				if (step === 1) {
					return NO_COMBO
						? call(fauxToolCall("advance", { summary: "plan ready" }))
						: call(fauxToolCall("advance", { summary: "plan ready" }), fauxToolCall("bash", { command: "echo parallel" })); // must be rejected
				}
				if (step === 2) return call(fauxToolCall("advance", { summary: "plan ready" }));
			} else {
				if (turns === 0) {
					const said = returned[1].slice(0, 200);
					return call(
						fauxToolCall("write", {
							path: planPath,
							content: `# Plan\n\n## Assignment\nrevised\n\n## Scope\n- In: REVIEWED (feedback was: ${said})\n\n## Steps\n1. Create hello.txt\n${pad}`,
						}),
					);
				}
				if (turns === 1) return call(fauxToolCall("advance", { summary: "plan revised" }));
			}
			break;
		}
		case "Plan reviewer":
			if (turns === 0) {
				return call(
					round < PLAN_APPROVE_ROUND
						? fauxToolCall("return", { feedback: "add the word REVIEWED to the plan" })
						: fauxToolCall("advance", { summary: "plan approved: it stays in scope" }),
				);
			}
			break;
		case "Developer":
			if (turns === 0)
				return call(fauxToolCall("write", { path: `${repo}/hello.txt`, content: round === 1 ? "hello\n" : "hello\nworld\n" }));
			if (turns === 1) return call(fauxToolCall("advance", { summary: "implemented hello.txt" }));
			break;
		case "Code reviewer":
			if (turns === 0) {
				return call(
					round < CODE_APPROVE_ROUND
						? fauxToolCall("return", { feedback: "add a second line to hello.txt" })
						: fauxToolCall("advance", { summary: "code approved: matches the plan" }),
				);
			}
			break;
	}
	return fauxAssistantMessage([fauxText(`(fake) nothing scripted for ${agentLabel} round ${round} after ${turns} turn(s)`)]);
}

export default function (pi: ExtensionAPI) {
	const core = createFauxCore({
		api: "e2e-faux",
		provider: "fake",
		models: [{ id: "fake-1", name: "Scripted fake model", contextWindow: CONTEXT_WINDOW, maxTokens: 4096 }],
	});
	pi.registerProvider("fake", {
		name: "Fake (scripted)",
		baseUrl: "http://localhost:0",
		apiKey: "fake",
		api: "e2e-faux",
		streamSimple: (model, context, options) => {
			core.appendResponses([(ctx) => brain(ctx)]);
			return core.streamSimple(model, context, options);
		},
		models: [
			{
				id: "fake-1",
				name: "Scripted fake model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: CONTEXT_WINDOW,
				maxTokens: 4096,
			},
		],
	});
}
