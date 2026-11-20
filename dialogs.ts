/**
 * The workflow's dialogs. pi's built-in select and editor treat Esc and Ctrl+C as one "cancel" key, so a dialog that
 * must not be skipped (Esc) cannot also quit pi (Ctrl+C). Here the select is a component of this extension, and the
 * editor is wrapped. Ctrl+C quits pi from either: the dialog calls `shutdown()` and ends with `QUIT`.
 *
 * The key handling is pure (`isCtrlC`, `selectAction`, `moveSelection`), so it is testable without a terminal.
 */

import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { type Component, Container, matchesKey, Spacer, Text } from "@earendil-works/pi-tui";

/** What a dialog returns when the user pressed Ctrl+C: nothing was decided. */
export const QUIT: unique symbol = Symbol("quit");
export type Quit = typeof QUIT;

/** Ctrl+C in the legacy encoding (`\x03`) and in the Kitty keyboard protocol (`\x1b[99;5u`). */
export function isCtrlC(data: string): boolean {
	return matchesKey(data, "ctrl+c");
}

export type SelectAction = { type: "move"; delta: -1 | 1 } | { type: "confirm" } | { type: "quit" } | { type: "ignore" };

/** What a key does in the select dialog. Esc, like every key not listed here, does nothing. */
export function selectAction(data: string): SelectAction {
	if (isCtrlC(data)) return { type: "quit" };
	if (matchesKey(data, "up") || data === "k") return { type: "move", delta: -1 };
	if (matchesKey(data, "down") || data === "j") return { type: "move", delta: 1 };
	if (matchesKey(data, "enter") || data === "\n") return { type: "confirm" };
	return { type: "ignore" };
}

/** The selection after moving by `delta`, clamped to the list. */
export function moveSelection(index: number, delta: number, count: number): number {
	return Math.max(0, Math.min(count - 1, index + delta));
}

/** The part of pi's `Theme` the select draws with. */
export interface SelectTheme {
	fg(color: "accent" | "border" | "dim" | "muted" | "text", text: string): string;
	bold(text: string): string;
}

export const SELECT_HINT = "↑↓ navigate  enter select  ctrl+c quit";

/** A list of options in the look of pi's built-in select: border, title, `→` on the selection, key hint. */
export class SelectDialog implements Component {
	private selected = 0;
	private readonly body = new Container();

	private readonly theme: SelectTheme;
	private readonly title: string;
	private readonly options: string[];
	private readonly onChoose: (option: string) => void;
	private readonly onQuit: () => void;
	private readonly onChange: () => void;

	constructor(
		theme: SelectTheme,
		title: string,
		options: string[],
		onChoose: (option: string) => void,
		onQuit: () => void,
		onChange: () => void = () => {},
	) {
		this.theme = theme;
		this.title = title;
		this.options = options;
		this.onChoose = onChoose;
		this.onQuit = onQuit;
		this.onChange = onChange;
		this.build();
	}

	get selectedIndex(): number {
		return this.selected;
	}

	private build(): void {
		const { theme } = this;
		const border = { render: (width: number) => [theme.fg("border", "─".repeat(Math.max(1, width)))], invalidate: () => {} };
		this.body.clear();
		this.body.addChild(border);
		this.body.addChild(new Spacer(1));
		this.body.addChild(new Text(theme.fg("accent", theme.bold(this.title)), 1, 0));
		this.body.addChild(new Spacer(1));
		this.options.forEach((option, i) => {
			const line = i === this.selected ? theme.fg("accent", `→ ${option}`) : `  ${theme.fg("text", option)}`;
			this.body.addChild(new Text(line, 1, 0));
		});
		this.body.addChild(new Spacer(1));
		this.body.addChild(new Text(theme.fg("dim", SELECT_HINT), 1, 0));
		this.body.addChild(new Spacer(1));
		this.body.addChild(border);
	}

	handleInput(data: string): void {
		const action = selectAction(data);
		switch (action.type) {
			case "move":
				this.selected = moveSelection(this.selected, action.delta, this.options.length);
				this.build();
				this.onChange();
				return;
			case "confirm": {
				const option = this.options[this.selected];
				if (option !== undefined) this.onChoose(option);
				return;
			}
			case "quit":
				this.onQuit();
				return;
			case "ignore":
				return;
		}
	}

	render(width: number): string[] {
		return this.body.render(width);
	}

	invalidate(): void {
		this.body.invalidate();
	}
}

/**
 * A select that ends only with a choice or with Ctrl+C: Esc does nothing. Ctrl+C asks pi to shut down and returns
 * `QUIT`. Reported to the terminal as `blocked`, as the built-in select is.
 */
export function ask(ctx: ExtensionContext, title: string, options: string[]): Promise<string | Quit> {
	return ctx.ui.custom<string | Quit>(
		(tui, theme, _keybindings, done) =>
			new SelectDialog(
				theme,
				title,
				options,
				(option) => done(option),
				() => {
					ctx.shutdown();
					done(QUIT);
				},
				() => tui.requestRender(),
			),
		{ blocked: { kind: "question", message: title } },
	);
}

/**
 * `ui.editor` that also quits on Ctrl+C. Esc and Enter give what `ui.editor` gives (`undefined` or the text). On
 * Ctrl+C `shutdown()` is called once and the result is `QUIT`. The key is not consumed, so pi's editor closes itself;
 * the race returns even if it does not.
 */
export async function editText(
	ui: Pick<ExtensionUIContext, "editor" | "onTerminalInput">,
	shutdown: () => void,
	title: string,
	prefill: string,
): Promise<string | undefined | Quit> {
	let requested = false;
	let quit: (value: Quit) => void = () => {};
	const quitting = new Promise<Quit>((resolve) => {
		quit = resolve;
	});
	const unsubscribe = ui.onTerminalInput((data) => {
		if (!requested && isCtrlC(data)) {
			requested = true;
			shutdown();
			quit(QUIT);
		}
		return undefined;
	});
	try {
		const result = await Promise.race([ui.editor(title, prefill), quitting]);
		return requested ? QUIT : result;
	} finally {
		unsubscribe();
	}
}
