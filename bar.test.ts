import assert from "node:assert/strict";
import { test } from "node:test";
import { type BarStyle, type BarUsage, type BarView, createBar, plainStyle, renderBar } from "./bar.ts";

const view = (patch: Partial<BarView> = {}): BarView => ({
	agent: "plan-reviewer",
	round: { planning: 2, development: 1 },
	roundLimit: { planning: 3, development: 3 },
	visited: ["planner"],
	...patch,
});
const width = (line: string) => [...line].length;

test("planning, round 2: Planner ✓, Plan reviewer ▶, development not started", () => {
	const lines = renderBar(view(), 120);
	assert.equal(lines.length, 3);
	assert.match(lines[0], /^╭─ Planning · round 2\/3 ─+╮ ╭─ Development · not started ─+╮$/);
	assert.match(lines[1], /^│ ✓ Planner {3}▶ Plan reviewer {3}│ │ {3}Developer {5}Code reviewer │$/);
	assert.match(lines[2], /^╰─+╯ ╰─+╯$/);
});

test("every row has the same width, and both boxes are equally wide", () => {
	for (const v of [view(), view({ agent: "code-reviewer", visited: ["developer"] }), view({ agent: "planner", visited: [] })]) {
		const lines = renderBar(v, 200);
		assert.equal(new Set(lines.map(width)).size, 1, lines.join("\n"));
		const [left, right] = lines[2].split(" ");
		assert.equal(width(left), width(right));
	}
});

test("development: planning is done (both ✓), the round counter moves to development", () => {
	const lines = renderBar(view({ agent: "developer", visited: [], round: { planning: 2, development: 2 } }), 120);
	assert.match(lines[0], /Planning · done/);
	assert.match(lines[0], /Development · round 2\/3/);
	assert.match(lines[1], /✓ Planner {3}✓ Plan reviewer/);
	assert.match(lines[1], /▶ Developer {3} {2}Code reviewer/);
});

test("the highlight moves back when work is returned; the reviewer keeps its ✓", () => {
	const lines = renderBar(view({ agent: "planner", visited: ["plan-reviewer"], round: { planning: 3, development: 1 } }), 120);
	assert.match(lines[0], /Planning · round 3\/3/);
	assert.match(lines[1], /▶ Planner {3}✓ Plan reviewer/);
});

test("the limit shown follows a granted extra round", () => {
	const lines = renderBar(view({ roundLimit: { planning: 4, development: 3 }, round: { planning: 4, development: 1 } }), 120);
	assert.match(lines[0], /Planning · round 4\/4/);
});

test("too narrow for two boxes: one line, still fits", () => {
	assert.deepEqual(renderBar(view(), 60), ["Planning 2/3 · ▶ Plan reviewer"]);
	assert.deepEqual(renderBar(view({ agent: "code-reviewer", round: { planning: 1, development: 2 } }), 60), [
		"Development 2/3 · ▶ Code reviewer",
	]);
	const tiny = renderBar(view(), 12);
	assert.equal(tiny.length, 1);
	assert.ok(width(tiny[0]) <= 12);
	assert.ok(tiny[0].endsWith("…"));
});

test("styling is applied per piece and does not change the layout", () => {
	const style = {
		active: (t: string) => `<A>${t}</A>`,
		done: (t: string) => `<D>${t}</D>`,
		waiting: (t: string) => `<W>${t}</W>`,
		accent: (t: string) => `<C>${t}</C>`,
		muted: (t: string) => `<M>${t}</M>`,
		item: (t: string) => `<I>${t}</I>`,
		warning: (t: string) => `<X>${t}</X>`,
		error: (t: string) => `<E>${t}</E>`,
	};
	const plain = renderBar(view(), 120);
	const styled = renderBar(view(), 120, style);
	const strip = (s: string) => s.replace(/<\/?[ADWCM]>/g, "");
	assert.deepEqual(styled.map(strip), plain);
	assert.match(styled[1], /<D>✓ Planner<\/D>/);
	assert.match(styled[1], /<A>▶ Plan reviewer<\/A>/);
	assert.match(styled[1], /<W> {2}Developer<\/W>/);
});

// ── the figures to the right of the boxes ──

const tagged: BarStyle = {
	active: (t) => `<A>${t}</A>`,
	done: (t) => `<D>${t}</D>`,
	waiting: (t) => `<W>${t}</W>`,
	accent: (t) => `<C>${t}</C>`,
	muted: (t) => `<M>${t}</M>`,
	item: (t) => `<I>${t}</I>`,
	warning: (t) => `<X>${t}</X>`,
	error: (t) => `<E>${t}</E>`,
};
const usage = (patch: Partial<BarUsage> = {}): BarUsage => ({
	context: { tokens: 1200, window: 200_000 },
	cost: 0.087,
	noPrice: false,
	...patch,
});
const CONTEXT = "agent ctx 1.2k/200k · 1%";
const WORKFLOW = "workflow $0.087";

test("figures to the right of the boxes: the context on the top row, the workflow on the middle row", () => {
	const base = renderBar(view(), 200);
	const lines = renderBar(view(), 200, plainStyle, usage());
	assert.equal(lines.length, 3);
	assert.equal(lines[0], `${base[0]}  ${CONTEXT}`);
	assert.equal(lines[1], `${base[1]}  ${WORKFLOW}`);
	assert.equal(lines[2], base[2]); // the bottom row is unchanged
	assert.ok(width(lines[0]) > width(lines[2]) && width(lines[1]) > width(lines[2]), "the rows have different widths now");
});

test("figures: without a context item the workflow item stays on the middle row, the top row is the plain box row", () => {
	const base = renderBar(view(), 200);
	for (const [patch, text] of [
		[{ context: undefined }, WORKFLOW],
		[{ context: undefined, cost: 0, noPrice: true }, "workflow no price"],
	] as [Partial<BarUsage>, string][]) {
		const lines = renderBar(view(), 200, plainStyle, usage(patch));
		assert.deepEqual(lines, [base[0], `${base[1]}  ${text}`, base[2]]);
	}
	// …and it is the same row, with the same indent, as when the context item is present
	const withContext = renderBar(view(), 200, plainStyle, usage());
	assert.equal(
		withContext[1].indexOf("workflow"),
		renderBar(view(), 200, plainStyle, usage({ context: undefined }))[1].indexOf("workflow"),
	);
});

test("figures: they go right of the boxes exactly when the widest one fits, else on one extra row", () => {
	const boxes = width(renderBar(view(), 200)[0]);
	const fits = boxes + 2 + CONTEXT.length;
	const right = renderBar(view(), fits, plainStyle, usage());
	assert.equal(right.length, 3);
	assert.ok(right.every((line) => width(line) <= fits));
	const below = renderBar(view(), fits - 1, plainStyle, usage());
	assert.equal(below.length, 4);
	assert.deepEqual(below.slice(0, 3), renderBar(view(), fits - 1));
	assert.equal(below[3], `${CONTEXT} │ ${WORKFLOW}`);
	// without a context item the workflow item alone is narrower, so it still fits where both would not
	assert.equal(renderBar(view(), fits - 1, plainStyle, usage({ context: undefined })).length, 3);
	assert.deepEqual(renderBar(view(), boxes + 2 + WORKFLOW.length - 1, plainStyle, usage({ context: undefined })).slice(3), [WORKFLOW]);
});

test("figures below the collapsed one-line bar, and cut with … at a tiny width", () => {
	assert.deepEqual(renderBar(view(), 60, plainStyle, usage()), ["Planning 2/3 · ▶ Plan reviewer", `${CONTEXT} │ ${WORKFLOW}`]);
	assert.deepEqual(renderBar(view(), 60, plainStyle, usage({ context: undefined })), ["Planning 2/3 · ▶ Plan reviewer", WORKFLOW]);
	const tiny = renderBar(view(), 12, plainStyle, usage());
	assert.equal(tiny.length, 2);
	assert.ok(tiny.every((line) => width(line) <= 12));
	assert.ok(tiny[0].endsWith("…") && tiny[1].endsWith("…"));
	assert.equal(tiny[1], "agent ctx 1…");
});

test("figures: the context label is always an item piece; the value is an item piece up to 70 %, warning above 70 %, error above 90 %", () => {
	const ctx = (tokens: number, window?: number) => renderBar(view(), 200, tagged, usage({ context: { tokens, window } }))[0];
	assert.match(ctx(140_000, 200_000), /<I>agent ctx <\/I><I>140k\/200k · 70%<\/I>$/); // exactly 70 %
	assert.match(ctx(141_000, 200_000), /<I>agent ctx <\/I><X>141k\/200k · 71%<\/X>$/);
	assert.match(ctx(180_000, 200_000), /<I>agent ctx <\/I><X>180k\/200k · 90%<\/X>$/); // exactly 90 %
	assert.match(ctx(181_000, 200_000), /<I>agent ctx <\/I><E>181k\/200k · 91%<\/E>$/);
	assert.match(ctx(1200, 200_000), /<I>agent ctx <\/I><I>1\.2k\/200k · 1%<\/I>$/);
});

test("figures: an unknown window shows the tokens only, as a plain item piece without a threshold", () => {
	for (const window of [undefined, 0]) {
		const top = renderBar(view(), 200, tagged, usage({ context: { tokens: 500_000, window } }))[0];
		assert.match(top, /<I>agent ctx <\/I><I>500k<\/I>$/);
	}
});

test("figures: the workflow item is one item piece; the spaces between boxes and figures are not styled", () => {
	const lines = renderBar(view(), 200, tagged, usage());
	assert.match(lines[1], /<M>│<\/M> {2}<I>workflow \$0\.087<\/I>$/);
	assert.match(lines[0], /<M>─+╮<\/M> {2}<I>agent ctx <\/I>/);
	assert.match(renderBar(view(), 200, tagged, usage({ cost: 0, noPrice: true }))[1], / {2}<I>workflow no price<\/I>$/);
});

test("figures: the extra row is built from the same pieces, joined with ` │ ` in item style; a cut row is one item piece", () => {
	assert.equal(
		renderBar(view(), 60, tagged, usage({ context: { tokens: 181_000, window: 200_000 } }))[1],
		"<I>agent ctx </I><E>181k/200k · 91%</E><I> │ </I><I>workflow $0.087</I>",
	);
	assert.equal(renderBar(view(), 60, tagged, usage({ context: undefined }))[1], "<I>workflow $0.087</I>");
	const cut = renderBar(view(), 12, tagged, usage({ context: { tokens: 181_000, window: 200_000 } }));
	assert.equal(cut[1], "<I>agent ctx 1…</I>");
});

test("figures: styling does not change the layout", () => {
	const strip = (s: string) => s.replace(/<\/?[ADWCMIXE]>/g, "");
	for (const w of [200, 100, 60, 12]) {
		assert.deepEqual(renderBar(view(), w, tagged, usage()).map(strip), renderBar(view(), w, plainStyle, usage()));
	}
});

test("no usage: the very same rows as without the argument", () => {
	for (const w of [200, 60, 12]) assert.deepEqual(renderBar(view(), w, tagged, undefined), renderBar(view(), w, tagged));
});

test("createBar reads the view and the figures when it renders", () => {
	let current: BarView | undefined;
	let figures: BarUsage | undefined;
	const bar = createBar(
		() => current,
		() => figures,
		plainStyle,
	);
	assert.deepEqual(bar.render(200), []);
	current = view();
	assert.equal(bar.render(200).length, 3);
	assert.ok(!bar.render(200).join("\n").includes("workflow"));
	figures = usage({ context: undefined });
	assert.match(bar.render(200)[1], /workflow \$0\.087$/);
	figures = usage({ context: { tokens: 9000, window: 200_000 } });
	assert.match(bar.render(200)[0], /agent ctx 9k\/200k · 5%$/);
	figures = undefined;
	assert.ok(!bar.render(200).join("\n").includes("workflow"));
});
