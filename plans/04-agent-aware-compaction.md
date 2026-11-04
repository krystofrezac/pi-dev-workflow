# dev-workflow — agent-aware compaction (business plan)

Follow-up to `03-keep-agent-contexts.md`. When an agent's context gets close to the limit, only that agent's own
older conversation is summarised, and the chat stays as it is.
Implements the TODO item "Make compaction aware of agents".

## Problem

- **pi compacts the whole session.** A compaction summarises all agents' messages together. An agent can lose part
  of its own earlier conversation in it, and it can end up with a summary that is mostly about other agents' work.
- **The chat is redrawn.** pi rebuilds the chat from the compaction on, so the earlier agents, their banners and
  their messages vanish from the screen.
- **An agent's context grows.** It holds all of the agent's rounds, so over a workflow it can reach the limit.

## What changes

While a workflow runs, pi's own compaction is switched off: `/compact` says so and does nothing. Instead, when the
active agent's context passes pi's usual threshold, the extension summarises that agent's older conversation, the way
pi summarises (same summary format, same file lists, same handling of a turn that is cut in the middle).

After a compaction the agent keeps:

1. its first briefing of the workflow, as it was (it holds the agent's role, rules and file paths),
2. the summary of its older conversation,
3. its most recent messages as they were (about pi's `keepRecentTokens`, 20k by default).

A later compaction of the same agent folds its earlier summary into the new one. Other agents are not touched, and
an agent still never sees another agent's conversation.

The chat is never rebuilt. A banner appears in it where the compaction happened:

```
▼ Developer · context compacted · 182k → ~14k tokens · $0.042
```

It shows the agent, the context size before and after, and what the compaction cost (`no price` when the model
declares no price, as in the bar). The size after is an estimate (hence the `~`); it includes the part of the
before figure that is not in the messages, such as the system prompt. Expanded, the banner shows the summary.

The compaction's cost counts in the workflow's cost and token totals, in the bar and in the closing banner.

## When

- After an agent's turn, using pi's compaction settings: `enabled`, `reserveTokens`, `keepRecentTokens` and the
  per-model overrides. With `compaction.enabled: false` nothing is compacted.
- At a hand-off the agent that just answered is compacted. This happens after the dialogs (plan confirmation, round
  limit) have been answered, and only when another agent follows; when the workflow ends there is no compaction. The
  summary appears before the new agent's banner.
- Nothing is compacted when there is nothing to summarise (the recent messages already take up all there is).
- A compaction that fails shows a warning and the workflow goes on; it is tried again at the agent's next turn.
- Esc stops the run as usual. A compaction that is being written at that moment is dropped. A hand-off that was
  under way still takes place, and the new agent waits for your next message.

## What does not change

- Rounds, limits, dialogs, tools, the bar and the content of each agent's first briefing.
- Without a workflow pi compacts as usual.
- pi still checks its own threshold before requests while a workflow runs. Each time the extension cancels that
  check, pi shows its "Auto-compacting…" indicator and a dim `Auto-compaction cancelled` line in the chat. This
  happens after every extension compaction, and an extension cannot switch it off.
- A manual `/compact` during a workflow shows the notice, followed by pi's own `Error: Compaction cancelled` line.
  An extension cannot suppress that line.

## Not covered

- `/compact` during a workflow is refused; there is no per-agent manual compaction.
- A request the provider rejects as too large is not recovered by compacting and retrying; you see the provider's
  error.
- An agent's size is not checked when it is activated again, only after its turns (pi's reserve covers a short
  message).

## Supersedes

These statements in earlier documents do not hold any more. The documents are left as they are, on purpose
(decided with the user); where they disagree with this plan, this plan is right.

- `03-keep-agent-contexts.md`: the section "Known limitation: compaction", and the sentence in Decision 5 "After a
  compaction an agent may lose part of its earlier conversation".
- `01-TECHNICAL-PLAN.md` §12, item 4: the guard against a spurious compaction right after a hand-off is replaced by
  cancelling every pi compaction while a workflow runs. Also the "Known limitation" paragraph after §12.
- `01-SPIKE-RESULTS.md` §4: "keep the guard".

## Success criteria

- A compaction summarises only the active agent's conversation.
- The chat keeps every earlier banner and message.
- No pi compaction is written during a workflow.
- After a compaction the agent sees its first briefing, the summary and its most recent messages.
- The banner shows the price of the compaction, and the workflow's totals include it.

## Decisions

1. pi's own compaction is cancelled for the whole workflow, and `/compact` is refused.
2. The extension compacts the active agent itself, after its turn, with pi's summariser, cut rule and threshold.
3. The agent keeps its first briefing, the summary and its most recent messages (`keepRecentTokens`).
4. A banner in the chat shows the agent, the size before and after, and the price.
5. The cost of a compaction counts in the workflow's totals.
6. Recovery from a request the provider rejects as too large, and a size check when an agent is activated again,
   are not covered.
