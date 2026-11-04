# dev-workflow — technical plan

Implements `01-BUSINESS-PLAN.md`. Read that first; this document only covers *how*.

## 1. Approach in one paragraph

There are no child sessions and no new processes. The whole workflow runs **in the user's current
pi session**, so the active agent is simply the normal chat agent and you talk to it in the normal
editor. An "agent" is nothing more than three things the extension swaps at each hand-off:

1. a **briefing** — a message that gives the agent its role, task and file paths,
2. a **tool set** — `advance` always, `return` only for reviewers,
3. a **context window** — the model sees only messages since its own briefing (the `context` hook
   filters the rest out), while the transcript on screen keeps everything.

All built-in tools stay available to every agent; there is no permission system.

The extension is a small state machine plus these three levers and a bottom-bar widget.

## 2. What was verified in pi, and the approaches rejected

Checked against pi's type declarations (`dist/core/extensions/types.d.ts`) and bundled source.

| Need | Mechanism | Status |
|---|---|---|
| Interactive agent, no extra question tool | The agent just ends its turn with a question; the user replies in the editor. A hand-off happens only through a tool call. | by design |
| Open the Planner from `/dev` without a turn | `pi.sendMessage(briefing)` (no `triggerTurn`) from the command handler; the first turn starts with the user's first prompt | declared in API |
| End of an agent's turn → start the next agent | `turn_end` boundary handler returns `{ entries: [custom_message], continue: true }` — appends the next briefing and requests one more model request | declared in API; **verified** (`01-SPIKE-RESULTS.md` §1) |
| Swap tools per agent | `pi.setActiveTools()`; applied before the next request, also mid-run | declared in API; **verified** |
| Hide earlier agents from the model, keep them on screen | `context` event: returns a filtered `messages` array for the request only; session entries are untouched | declared in API; **verified** |
| Bottom bar | `ctx.ui.setWidget(key, factory, { placement: "belowEditor" })` with a custom component | declared in API |
| Banner in the transcript | `pi.registerMessageRenderer(customType, …)` for a `display: true` custom message | declared in API |
| Dialogs (plan confirmation, round limit, stop) | `ctx.ui.select / editor / confirm`, callable from handlers | declared in API; **verified** from inside `turn_end` |
| Persisting state | `pi.appendEntry()` + rebuild from `ctx.sessionManager.getBranch()` on `session_start` | documented pattern |

**Rejected:**

- **Child sessions as in `pi-workflow`.** They are headless; letting the user type into them would
  mean intercepting the editor and proxying input. Far more machinery than context filtering.
- **A new session per agent (`ctx.newSession()`).** The old conversation leaves the screen, which
  contradicts "keep it visible with banners". It also reloads the extension runtime, so state would
  have to be smuggled across.
- **Resetting context with a "retain-none" compaction entry.** It does exactly what we want for the
  model, but in interactive mode pi reacts to a compaction entry by *clearing the chat view and
  re-rendering from the compaction onwards* — the earlier agents would vanish from the screen. (Found in
  pi's interactive-mode source.) Same blocker for `context_edit` omissions on resume.

## 3. State

One workflow at a time, held in memory and mirrored to the session with `appendEntry("dev-state")` (`data: null` =
no workflow) after every change. Restored from the latest such entry on the current branch on `session_start` and
`session_tree`. This survives `/reload` **and a full restart** (`pi --continue` / `--session`; verified in the spike and in
`e2e/`). `pending` is deliberately not persisted. A session with no user or assistant message yet is not written to disk by pi, so `/dev` followed by a quit before the first message is not restored.

```
id:          "0003"                                    also the run directory name
dir:         <project>/.pi/dev/0003
agent:       planner | plan-reviewer | developer | code-reviewer      (= the stage is implied)
round:       { planning: 1.., development: 1.. }       current author⇄reviewer cycle, starts at 1
roundLimit:  { planning: 3, development: 3 }
visited:     agents that have handed over in the current stage (drives the ✓ marks)
savedTools:  the tool set before /dev, restored when the workflow ends
baseline:    git HEAD + files already dirty, recorded when development starts

pending:     advance | return(feedback) | undefined    in memory only: set by a tool, consumed at turn_end
```

`machine.ts` contains this state and the transition function as **pure code** (no pi imports), so it
is unit-testable.

## 4. Transitions

All transitions are applied at the `turn_end` boundary, after the tool call completes, not inside the tool.

| Trigger | Result |
|---|---|
| `/dev`, nothing active | allocate run dir; agent = Planner, planning round 1; append briefing and show a hint, no turn; the Planner's first turn starts with the user's first message |
| Planner `advance` | validate plan file → Plan reviewer |
| Plan reviewer `return` | round < limit → Planner, round + 1, feedback in briefing. Round = limit → **limit dialog** |
| Plan reviewer `advance` | **plan confirmation dialog** (below) |
| Developer `advance` | Code reviewer |
| Code reviewer `return` | round < limit → Developer, round + 1. Round = limit → **limit dialog** |
| Code reviewer `advance` | finish workflow |

**Plan confirmation dialog** — `select`: *Approve and start development* · *Edit plan…* (opens the plan in
`ctx.ui.editor`, saved back to the file, then asks again) · *Send back to Planner…* (user comments become the
feedback; the round number is **not** increased) · *Stop workflow*.

**Limit dialog** — *Continue* (limit += 1, i.e. one more round; author gets the feedback) · *Accept as is* (Planning: go to plan
confirmation; Development: finish) · *Stop workflow*.

**Finish / stop** — append the closing note (`dev-end`, §6), restore the previous active tool set, clear the
widget, notify. Files already written stay. At a boundary the note is appended **without** `continue`; the run ends because
the last tool batch terminated (§5). A turn that did not complete (Esc, error) drops any recorded hand-off: the agent stays.
A dialog that is dismissed (Esc) is asked again; three dismissals in a row count as *Stop*.

## 5. Tools

Both registered at load with `defaultActive: false`, so a normal session never sees them; activated by
`setActiveTools` only while the workflow runs. Neither does the transition itself: it records
`pending` and returns a short result **with `terminate: true`**. The transition runs at `turn_end`.

| Tool | Params | Who | Notes |
|---|---|---|---|
| `advance` | `summary: string` | all four | Authors: what was done, what to look at, how it was verified. Reviewers: approval note (shown to you at plan confirmation / in the closing banner). Planner's call is rejected with an error message if the plan file is missing or has no `Scope` section. |
| `return` | `feedback: string` | reviewers only | Required, non-empty, concrete. |

A second call while one is `pending` is rejected. Both are `executionMode: "sequential"`.

**Each must be the only tool call of its assistant message** (the tool throws otherwise: "call it again on its own"; the names of
the newest message's calls are recorded in a `message_end` handler, which runs before the tools). Without `terminate`, pi makes one
extra request after the last hand-off, where there is no next agent to take it; a non-terminating sibling such as `bash` would bring
it back (spike, scenarios `terminate0`, `finish-combo`, `finish-combo-solo`). Every briefing says: hand over on its own.

`return` is only *declared* to reviewers (via the active tool set), and `execute` also rejects a call from an
agent that should not use it. That is a sanity check on the state machine, not a permission system.

**No other restrictions.** `read`, `bash`, `edit`, `write` and the rest stay active for every agent, and there is no
`tool_call` guard. Roles are kept by the briefings alone (Planner: write the plan, not code; reviewers: report, don't
fix; Developer: don't change the plan).

## 6. Context isolation

Pure function `visibleMessages(messages)` in `context.ts`, run in the `context` hook. Markers are custom
messages with `customType` `dev-briefing` or `dev-end`.

**Rule: drop every message before the latest marker.** One rule, used whether or not a workflow is active.

- **Workflow active:** each agent sees its briefing and its own conversation, nothing else. Cuts always land
  right after a completed turn, so no tool-call / tool-result pair is split.
- **After the workflow:** the latest marker is `dev-end`, a short note (outcome, plan path, "the workflow's
  conversations are not part of this context"). The model therefore sees only that note and what follows. What was
  said before `/dev` is not restored (see `TODO.md` for the planned improvement).

Stateless: derived from the messages each time, so it is correct after `/resume`, `/reload` and `/tree`. With no
markers present it is a no-op, so the hook costs nothing in normal sessions. The screen is unaffected: the hook only
changes what each request carries.

## 7. Briefings

Built-in text in `briefings.ts`, one builder per agent. Every briefing contains: the role and mission, the
rules (ask the user in chat; hand off only with the tool; role boundaries as *instructions*), the absolute paths it
needs, and where relevant the feedback. Delivered as the `dev-briefing` custom message (display `true`, drawn as the
banner, collapsed by default; expandable to read the text).

| Agent | Briefing includes |
|---|---|
| Planner | Mission and plan format (mandatory sections: Assignment — the user's request, quoted where possible — **Scope** — in / out / decisions made with the user — Steps, How to verify). Plan file path. On a later round: the Plan reviewer's feedback, or your comments from the confirmation dialog; the plan on disk is the current draft. |
| Plan reviewer | Checklist from the business plan. The plan path and the Planner's `summary`. It does **not** get your original assignment: it judges the plan against what the plan says you asked for, and is told to ask you in the chat when something looks added or missing. |
| Developer | Mission: implement the plan, run the project's tests/checks, don't add anything outside the plan. Plan path, git baseline (§8). On a later round: the Code reviewer's feedback. |
| Code reviewer | Checklist: scope (done and nothing extra), correctness (tests/checks pass — may run them), code quality. Plan path, the Developer's `summary`, git baseline to diff against. |

A fresh agent on a return round gets no memory of its earlier attempt; the work is on disk (plan file, working tree)
and the feedback is in the briefing (decision from the business plan; keeping the author's context is in `TODO.md`).

**Known weakness.** Since the Plan reviewer never sees the original assignment, a plan whose *Assignment* section
has drifted from what you said can pass review unless you notice, or the reviewer asks you. The plan confirmation
dialog is the backstop. Fixing this is in `TODO.md`.

## 8. Files on disk

`<project>/.pi/dev/<NNNN>/` (number = next free, like `pi-workflow`).

| File | Written by | Purpose |
|---|---|---|
| `plan.md` | Planner (you may edit) | The plan; read by everyone downstream |

Git baseline: when development starts, record `HEAD` and whether the tree was dirty (via `pi.exec("git", …)`); the
Code reviewer diffs against it. Not a git repo → the briefing falls back to the Developer's `summary` and file list.

## 9. UI

**Bottom bar** — `setWidget("dev-workflow", factory, { placement: "belowEditor" })`; a component that renders
from the state and is re-rendered via `tui.requestRender()` after each change. Two bordered groups, one per stage:

```
╭─ Planning · round 2/3 ─────────────╮ ╭─ Development ──────────────────────╮
│  ✓ Planner     ▶ Plan reviewer     │ │    Developer       Code reviewer   │
╰────────────────────────────────────╯ ╰────────────────────────────────────╯
```

Active: accent colour + bold + `▶`. Visited this stage: dimmed + `✓`. Not reached: muted. Width-aware
(`visibleWidth` / `truncateToWidth`); below a minimum width it collapses to one line
(`Planning 2/3 · ▶ Plan reviewer`). Removed when the workflow ends.

**Banners** — `registerMessageRenderer("dev-briefing")`: a band like `▶ Development · Code reviewer · round 1/3`
and, expandable, the briefing text. `dev-end`: `✓ Workflow finished` / `✗ Workflow stopped`, plus the plan path.

**Interactive mode only.** `/dev` refuses with a message when `ctx.mode !== "tui"`. (A choice, not a constraint: the spike
ran the same mechanics in RPC mode.) `/dev` also refuses to start while the agent is busy.

## 10. Commands and lifecycle

- `/dev` — nothing active: start (§4). Active: `select` → *Stop workflow* / *Cancel*. Stop calls `ctx.abort()`
  if the agent is running, then finishes (§4). No arguments, no other commands.
- `session_start` — restore state, re-activate tools and widget if a workflow is active.
- `session_shutdown` — remove widget; leave persisted state alone.
- Esc during a run interrupts the current turn only; the workflow and the active agent stay as they are.
- All agents use whatever model and thinking level are currently selected. The extension never touches them.

## 11. Module layout

```
extensions/dev-workflow/
  index.ts        wiring: command, tools, event handlers, renderers
  machine.ts      pure: state, transition(), round / limit logic
  context.ts      pure: visibleMessages()
  briefings.ts    built-in briefing text per agent
  tools.ts        advance, return
  bar.ts          bottom-bar component
  banners.ts      message renderers
  files.ts        run dir, plan validation, git baseline
  machine.test.ts, context.test.ts, briefings.test.ts, files.test.ts, bar.test.ts     node --test extensions/dev-workflow/*.test.ts
  e2e/            fake-model.ts + drive-tui.py: the real extension in a real terminal against a scripted model
```

Footprint on a normal session: one command, two inactive tools, one no-op `context` hook, two message renderers.
No system-prompt changes, no context added.

## 12. Risks and the spike

Done first, in a throwaway extension (`../spike/`, results in `01-SPIKE-RESULTS.md`). Items 1, 2, 3 and 5 are **verified**.

1. `turn_end` returning a `custom_message` entry + `continue: true` really starts a follow-up request that
   includes that message, and `setActiveTools` made in the same handler applies to it.
2. The `context` filter really shortens the provider request (check with `before_provider_request`) while the
   screen keeps everything, including after `/resume`.
3. A `ctx.ui.select` / `ctx.ui.editor` opened from inside `turn_end` works and blocks cleanly.
4. **Spurious auto-compaction after a hand-off — real; guard kept.** pi estimates context size from the *last assistant message's*
   usage plus what was added since. Right after a hand-off that message belongs to the previous agent; if it was large, pi may
   compact before the new agent has answered. Compaction would summarise hidden messages and clear the screen. Guard:
   `session_before_compact` with `reason === "threshold"` cancels while no assistant message exists after the newest
   `dev-briefing` entry (`awaitingFirstAnswer()` in `context.ts`). Verified again against the real extension in `e2e/`
   (scenario `compaction`: without the guard the chat view is rebuilt, with it nothing happens).
5. A tool call in the same assistant message as other tool calls (`advance` + something) still transitions
   correctly at `turn_end`.

**Known limitation.** If one agent's own context grows past the limit, pi's normal compaction applies to the whole
session and clears the chat view. We accept that; a long single-agent segment is uncommon.

## 13. Implementation order

1. **Spike** (§12).
2. `machine.ts` + `context.ts` with tests (no pi needed).
3. Tools, transitions at `turn_end`, briefings, files — works headless in the log, no UI polish.
4. Bottom bar and banners.
5. Dialogs: plan confirmation, limit, stop.
6. Prompt tuning with a real run in a throwaway repo: plan that adds an unrequested feature (reviewer must
   catch it), code that deviates (reviewer must catch it), round limit reached, stop mid-way, `/resume`.

## 14. Settled decisions (from review of this plan)

- No permission system; every agent has all tools.
- After `/dev` ends, the context is clean: only the closing note. Restoring the pre-`/dev` conversation is in `TODO.md`.
- The Plan reviewer does not see the original assignment or the planning chat. Giving it access is in `TODO.md`.
- "Continue" at the round limit grants **one** more round.
- Keeping an author's context when work is returned to it is in `TODO.md`.

## 15. Open questions

None blocking. Everything left to learn is in the spike (§12).
