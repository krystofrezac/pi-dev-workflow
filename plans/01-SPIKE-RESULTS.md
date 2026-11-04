# dev-workflow — spike results

Outcome of the spike specified in `01-TECHNICAL-PLAN.md` §12. Code and how to re-run it: `../spike/`.
Tested against pi 1.4.0.

**Verdict: the approach works.** All five assumptions hold; two of them needed a refinement
(items 4 and the new finding on `terminate`). Nothing found that blocks the plan.

## How it was tested

A miniature of the real extension (four agents, briefing + tool set + context filter, transitions at
`turn_end`, dialogs) driven by a scripted fake model, so every run is deterministic. The fake model logs
exactly what the provider is sent, which is stronger evidence for context isolation than reading pi's
session. Three layers:

| Layer | What it adds |
|---|---|
| `drive.mjs` — pi in RPC mode, scripted "user" | the mechanics; 77 checks across 8 scenarios, all green |
| `drive-tui.py` — pi in a real terminal (pty + pyte) | what only the screen shows: dialogs, scrollback, effect of compaction |
| `drive.mjs real` — same workflow, `github-copilot/claude-haiku-5.5` | real provider accepts the shapes; a real model hands over with the tools |

## The five risks

### 1. `turn_end` → `{ entries: [custom_message], continue: true }` starts the next agent — **confirmed**

- After every hand-off the very next provider request began with the new briefing and nothing else
  (all 8 activations, in the expected order `planner#1 → plan-reviewer#1 → planner#2 → plan-reviewer#2 →
  developer#1 → code-reviewer#1 → developer#2 → code-reviewer#2`). No request was made for the old agent
  after its hand-off.
- `pi.setActiveTools()` called in the same handler applied to that next request: `advance` always,
  `return` only for reviewers (checked in the request's tool list, and in the real provider's payload).
- A `custom` entry (state snapshot) and a `custom_message` entry in the same boundary both work.
- The whole workflow runs inside **one pi run per user message** (one `agent_start`/`agent_settled` pair
  covers planner → … → end). `agent_settled` therefore is not an "agent finished" signal; the extension's own
  `turn_end` is.

### 2. The `context` filter shortens the request; the screen keeps everything — **confirmed**

- Every provider request carried exactly one briefing, as its first message. Conversation sizes over the
  whole run: `1,3,5 | 1 | 1,3 | 1 | 1,3 | 1 | 1,3 | 1` while the session grew to 50–60 entries. With the real
  provider (`before_provider_request`): `1,3,5,1,1,3,5,1,1,3,1,1,3,5,1` messages.
- pi's own system messages (prompt, tool-set changes) are not affected by the filter, so the tool list stays
  correct.
- Stateless, as designed: after `switch_session` to the same file, and after quitting pi mid-workflow and
  starting it with `--session`, the next request is still correct (after a restart the Planner sees briefing +
  its question + the user's answer, nothing else).
- Screen: in the real TUI every earlier agent's messages stay on screen — while the dialogs are open and after
  the end note. Custom messages render by default as `[spike-briefing]` followed by the full text, expanded;
  the planned banner renderer is still needed.
- After the workflow, the model sees only the end note and what follows. Same after *Stop*.

### 3. `ctx.ui.select` / `ctx.ui.editor` from inside `turn_end` — **confirmed**

- Worked in RPC mode and in the real TUI. The dialog blocks: with a user who takes 400 ms to answer, the
  dialogs stayed open that long and no model request was made meanwhile; the workflow carried on after
  each answer. `editor` result was written back to the plan file. The limit dialog granted exactly one more
  round.
- The extension also works when `ctx.mode === "rpc"` (dialogs are forwarded), so the plan's "TUI only" is a
  choice, not a constraint.

### 4. Spurious auto-compaction after a hand-off — **real; the guard works, keep it**

pi decides whether to compact *before the next request* from the last assistant message's usage **plus an
estimate of what was added since** (the tool results and the new briefing). Right after a hand-off that usage
belongs to the previous agent.

- Set the threshold just above what the Planner itself ever needed (11,998 tokens). The new Plan reviewer's real
  context was ~2,000 tokens, yet pi estimated 12,118 at the hand-off and **compacted** — twice in one run
  (both Planner → Plan reviewer hand-offs).
- Consequences, observed in the real TUI: the chat view was rebuilt from the compaction onwards (about 140 lines
  on screen instead of 450; the Planner's question and the first briefings gone), and a summarisation call was
  billed (6.3k tokens) for a context nobody was going to use.
- The `session_before_compact` guard from §12.4 works: cancelling when the newest assistant message predates the
  newest briefing gave **0 compactions**, the workflow completed, the screen stayed intact.
- It only bites when the previous agent ended within one briefing's worth of tokens of the threshold — rare, but
  the guard is a few lines, so keep it. Legitimate compaction (the *new* agent's own context too large) is not
  affected: by then its own assistant message postdates the briefing.

### 5. `advance` + another tool call in the same message — **confirmed, with a wrinkle** (see below)

The transition happens exactly once at `turn_end`, and the other call (`bash`) still ran and its result is in the
session. A real model (haiku-5.5) produced this combined call on its own when told to.

## New finding: the tools must end the run themselves

The plan (§5) has `advance` / `return` "record `pending` and return a short result". That is not enough.

- After a tool batch, pi asks the model again unless **every** tool of the batch says `terminate: true`.
  For a hand-off *to another agent* that does not matter — the follow-up request is simply the new agent's first
  request. For the **last** hand-off (Code reviewer approves → workflow ends) there is no next agent: without
  `terminate`, pi makes **one extra request** whose whole context is the end note, and the model answers it. The
  answer lands in the chat after "Workflow finished" and in the post-workflow context (confirmed, scenario
  `terminate0`).
- With `terminate: true` on the tools the extra request disappears (scenario `base`) — **except** when `advance` shares
  its message with a non-terminating tool such as `bash` (scenario `finish-combo`: extra request again).
- Fix, tested (scenario `finish-combo-solo`): `advance` and `return` **throw if they are not the only tool call in
  their assistant message** ("call it again on its own"). The model retries alone; zero extra requests. Needs the names
  of the calls of the newest assistant message, recorded in a `message_end` handler (it runs before the tools do).

## Changes to make in `01-TECHNICAL-PLAN.md`

1. **§5 Tools** — both tools return `terminate: true`; both reject a call that shares its message with other tool calls;
   say so in every briefing ("hand over with `advance` on its own").
2. **§4 Finish / stop** — note that the closing note is appended with no `continue`, and the run ends because the
   last batch terminated.
3. **§12 item 4** — keep the guard; specify it: on `session_before_compact` with `reason === "threshold"`, cancel when no
   assistant message exists after the newest `dev-briefing` entry. Mark risks 1, 2, 3, 5 as verified.
4. **§3 State** — restoring from the `dev-state` entry also survives a full restart (`--session`); this can now be
   promised, not just called a side effect. (Only the agent/round/limit state was tested; `pending` is deliberately not
   persisted.)
5. **§10** — `/dev` could work in RPC mode too; stays TUI-only if you prefer.

## Not covered by the spike (left for the build / prompt-tuning steps)

- **Esc / abort** at various moments, and *Stop* while an agent is running (`ctx.abort()` + `waitForIdle()` path is
  written in the spike but only the idle case was exercised).
- Whether real **reviewers actually catch** added scope or deviations — that is §13 step 6 (prompt tuning); the spike's
  models follow a script.
- `/tree` navigation inside a workflow, model / thinking-level changes mid-workflow, and an agent whose *own* context
  outgrows the window (known limitation in §12).
- Bottom bar and banner rendering (build step 4).
- The real-model run only checked the plumbing (hand-offs, tool sets, request sizes), not the quality of any prompt.
