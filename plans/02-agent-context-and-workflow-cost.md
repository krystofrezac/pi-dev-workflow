# dev-workflow — context size and workflow cost (business plan)

Follow-up to `01-BUSINESS-PLAN.md`. Two numbers you can trust while a workflow runs:
how full the **active agent's** context is, and what the **whole workflow** has cost so far.
Implements the TODO item "Show the current agent's context size", plus a running workflow total.

## Problem

- **The context figure in the footer is wrong after every switch.** The footer shows how full "the" context
  is, but it measures it from the last answer, and right after a hand-over that answer belongs to the
  *previous* agent. A Plan reviewer that starts with a few thousand tokens can appear to be carrying
  the Planner's 150k. The same happens when `/dev` starts (the footer still shows the earlier chat,
  which the Planner never sees) and when the workflow ends.
- **No idea what a workflow costs.** Four agents, several rounds, and the only cost figure is the session total, which
  also includes everything you did before `/dev`.

The workflow's whole point is that each agent works with a small, clean context. The figures should show that.

## Goal

At a glance, at any moment during a workflow:

1. **How full is the active agent's context** — and is it getting close to the limit?
2. **What has this workflow cost so far**, all agents and all rounds together?

## What you see

Two items in the bottom bar, to the right of the stage/agent boxes: the active agent's context on the top row,
the workflow's cost on the middle row. They are there for the whole workflow and go away with the bar when the
workflow ends or is stopped.

```
╭─ Planning · round 2/3 ──────────╮ ╭─ Development · not started ─────╮  agent ctx 1.2k/200k · 1%
│ ✓ Planner   ▶ Plan reviewer     │ │   Developer   Code reviewer     │  workflow $0.087
╰─────────────────────────────────╯ ╰─────────────────────────────────╯
```

On a terminal too narrow for them next to the boxes, they go on one extra row below the bar, side by side:
`agent ctx 1.2k/200k · 1% │ workflow $0.087`.

When the workflow ends (finished or stopped), the final banner shows what it cost, in price and tokens:

```
✓ Workflow finished
Plan: …/plan.md
Cost: $0.412
Tokens: 120k in · 8.2k out · 1.2M cache read · 30k cache write
```

### Agent context

- Shows the **active agent's own context only**: its briefing and its own conversation. Earlier agents
  and your pre-`/dev` chat do not count, because the agent never sees them.
- When the active agent changes, the previous agent's figure disappears at once; the new agent's own figure
  appears after its first answer.
- No estimate and no `~`: right after `/dev` and right after a hand-over nobody can measure the new agent's
  context yet, so the figure is absent until the agent's first answer. After that it is the figure the model
  provider reported for the agent's newest answer, plus pi's estimate of what was added since.
- Changes colour as the limit approaches (above 70% and 90%), the same as the built-in figure.

### Workflow cost

- **All four agents, all rounds** — including work that was returned and redone, and your conversation
  with the Planner. Nothing from before `/dev` is included.
- **Running total**, updated each time an agent finishes a response.
- If the model has no price information (a custom or local model), it says "no price" instead of
  `$0.000`, so a missing price is never mistaken for "free".
- Survives closing and reopening the session: the figure is rebuilt from the session's own record.
- When the workflow ends, finished or stopped, the final banner shows the total price and tokens.

## What does not change

- The footer's built-in figures stay as they are, including its context percentage. That figure keeps its
  flaw after hand-overs; the figures in the bar are the ones to read during a workflow. (Fixing the built-in figure
  would be a change in pi itself.)
- After the workflow ends, the figures are gone with the bar; the banner keeps the totals. The built-in figure is
  the only one again.

## Not in this plan

Still in `TODO.md`, under "Cost and token tracking":

- cost and tokens per agent and per stage,
- a fuller summary when the workflow ends (this plan only puts the two totals, cost and tokens, in the banner),
- a budget or a warning when a workflow gets expensive.

This plan builds the whole-workflow totals and the banner they will extend.

## Success criteria

- Right after the Planner hands a large conversation to the Plan reviewer, the previous figure is gone at once,
  and the reviewer's own small figure appears after its first answer.
- At `/dev` start in a long conversation there is no context figure until the Planner has answered, and then it
  is the Planner's small context, not the old chat.
- The workflow total equals the sum over the session record from the start of the workflow: the responses, and
  also tool-result, `usage` and compaction entries that carry a cost. It can be checked against the session record.
- The total keeps growing when work is returned, and is the same after quitting and resuming the session.
- The final banner, finished or stopped, shows the workflow's total price and tokens.
- Needs no explanation: `agent ctx` and `workflow` say what each figure is.

## Decisions

1. ~~A separate footer line, not a replacement footer.~~ **Superseded:** the figures are in the bar, to the right of
   the stage/agent boxes. Pi's own footer is untouched. So they show in the terminal UI only, like the bar.
2. ~~The workflow total sits in the same line as the agent's context size.~~ **Superseded** by 1: the context figure
   is on the top row, the workflow figure on the middle row, both right of the boxes.
3. **Nothing until known**: no estimate, no `~`. The context figure is absent until the agent has answered once.
   (Replaces "estimate marked `~`".)
4. **The figures go with the bar when the workflow ends or is stopped, but the final banner keeps price and tokens**,
   in both "finished" and "stopped". (Replaces "the line disappears when the workflow ends".)
5. **"No price" instead of `$0.000`** when the model reports no prices. Confirmed.
