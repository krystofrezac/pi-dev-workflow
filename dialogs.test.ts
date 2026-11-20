import assert from "node:assert/strict";
import { test } from "node:test";
import { editText, isCtrlC, moveSelection, QUIT, SELECT_HINT, SelectDialog, type SelectTheme, selectAction } from "./dialogs.ts";

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

test("isCtrlC: legacy and Kitty encodings, not Esc or a plain c", () => {
	assert.equal(isCtrlC("\x03"), true);
	assert.equal(isCtrlC("\x1b[99;5u"), true);
	assert.equal(isCtrlC(ESC), false);
	assert.equal(isCtrlC("c"), false);
});

/** A select over three options that records what it did. */
function select() {
	const log = { chosen: [] as string[], quit: 0, changed: 0 };
	const theme: SelectTheme = { fg: (_color, text) => text, bold: (text) => text };
	const dialog = new SelectDialog(
		theme,
		"Title",
		["one", "two", "three"],
		(option) => log.chosen.push(option),
		() => log.quit++,
		() => log.changed++,
	);
	return { log, dialog };
}

test("select: Ctrl+C quits, Esc is ignored, Enter confirms", () => {
	assert.deepEqual(selectAction("\x03"), { type: "quit" });
	assert.deepEqual(selectAction("\x1b[99;5u"), { type: "quit" });
	assert.deepEqual(selectAction(ESC), { type: "ignore" });
	assert.deepEqual(selectAction("x"), { type: "ignore" });
	assert.deepEqual(selectAction("\r"), { type: "confirm" });

	const { log, dialog } = select();
	dialog.handleInput(ESC);
	assert.deepEqual(log, { chosen: [], quit: 0, changed: 0 });
	dialog.handleInput(DOWN);
	dialog.handleInput("\r");
	assert.deepEqual(log.chosen, ["two"]);
	dialog.handleInput("\x03");
	assert.equal(log.quit, 1);
});

test("select: up/down and j/k move the selection and clamp at both ends", () => {
	assert.deepEqual(selectAction(UP), { type: "move", delta: -1 });
	assert.deepEqual(selectAction("k"), { type: "move", delta: -1 });
	assert.deepEqual(selectAction(DOWN), { type: "move", delta: 1 });
	assert.deepEqual(selectAction("j"), { type: "move", delta: 1 });
	assert.equal(moveSelection(0, -1, 3), 0);
	assert.equal(moveSelection(1, -1, 3), 0);
	assert.equal(moveSelection(1, 1, 3), 2);
	assert.equal(moveSelection(2, 1, 3), 2);

	const { dialog } = select();
	dialog.handleInput(UP);
	assert.equal(dialog.selectedIndex, 0);
	dialog.handleInput("j");
	dialog.handleInput(DOWN);
	dialog.handleInput("j");
	assert.equal(dialog.selectedIndex, 2);
	dialog.handleInput("k");
	assert.equal(dialog.selectedIndex, 1);
});

test("select: the hint says Ctrl+C quits and has no Esc or cancel", () => {
	const { dialog } = select();
	const text = dialog.render(80).join("\n");
	assert.ok(text.includes(SELECT_HINT));
	assert.ok(/ctrl\+c quit/.test(text));
	assert.ok(!/esc|cancel/i.test(text));
	assert.ok(text.includes("→ one"));
});

/** The `ui` subset `editText` needs, with an editor that resolves with `result` or never. */
function fakeUi(result: { text: string | undefined } | "never") {
	const log = { subscribed: 0, unsubscribed: 0, opened: [] as string[] };
	let listener: ((data: string) => unknown) | undefined;
	const ui = {
		onTerminalInput(handler: (data: string) => unknown) {
			log.subscribed++;
			listener = handler;
			return () => {
				log.unsubscribed++;
			};
		},
		editor(title: string, prefill?: string): Promise<string | undefined> {
			log.opened.push(`${title}|${prefill}`);
			return result === "never" ? new Promise(() => {}) : Promise.resolve(result.text);
		},
	};
	return { ui: ui as unknown as Parameters<typeof editText>[0], log, press: (data: string) => listener?.(data) };
}

test("editText: Ctrl+C shuts down once, returns QUIT although the editor stays open, and unsubscribes", async () => {
	const { ui, log, press } = fakeUi("never");
	let shutdowns = 0;
	const result = editText(ui, () => shutdowns++, "Edit", "text");
	assert.equal(press("a"), undefined);
	assert.equal(shutdowns, 0);
	assert.equal(press("\x03"), undefined); // not consumed
	press("\x1b[99;5u");
	assert.equal(await result, QUIT);
	assert.equal(shutdowns, 1);
	assert.deepEqual(log, { subscribed: 1, unsubscribed: 1, opened: ["Edit|text"] });
});

test("editText: a submit or Esc returns what the editor returned, without shutting down", async () => {
	for (const text of ["typed", undefined]) {
		const { ui, log } = fakeUi({ text });
		let shutdowns = 0;
		assert.equal(await editText(ui, () => shutdowns++, "Edit", ""), text);
		assert.equal(shutdowns, 0);
		assert.equal(log.unsubscribed, 1);
	}
});
