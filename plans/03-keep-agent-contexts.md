# dev-workflow — keep agent contexts when work is returned (business plan)

Follow-up to `01-BUSINESS-PLAN.md`. When work goes back and forth between an author and a reviewer, each agent
carries on with its own earlier conversation.
Implements the TODO item "Keep agent contexts when work is returned".

## Problem

- **Every activation starts clean.** An author whose work is returned has no memory of what it did, what it asked
  you or what it decided. It has to rediscover all of that from the files and the feedback. Questions you already
  answered, and the reasons behind a choice, are not in its view.
- **Reviewers re-review without remembering.** A reviewer that sees the work a second time does not know what it
  found the first time, so it cannot check that a point it raised was fixed the way it meant it.

## Goal / What changes

Every agent that is activated again continues with its own earlier conversation: its first briefing, what it said
and did, and its own hand-over. On top of that it gets one short message saying what is new. The message has two
forms:

- work comes back to an author:
  `Returned from Plan reviewer: add the word REVIEWED to the plan`
- the author hands over again to a reviewer:
  `Handed over from Planner: plan revised`

The message has the usual one-line title above it (`# Planning · Planner · round 2/3`), so the agent still knows
the stage and the round. It does not repeat the role, the plan format, the git baseline or the rules: the agent
has them in its own earlier conversation.

An agent never sees another agent's conversation. The reviewer's feedback and the author's hand-over note reach it
only through the short message.

The screen is unchanged: the banner marks every switch, and the whole chat stays on screen.

**The one exception.** When *you* send the plan back from the plan confirmation, the message to the Planner is
`Returned from the user: <your comments>`, followed by one fixed sentence: the plan file may have been edited by
the user since the Planner wrote it, so it should read the file before it changes anything. The reason is that you
can edit the plan in "Edit plan…" before sending it back, and a Planner that works from its memory of the plan it
wrote could overwrite your edits. Reading the file first prevents that. The sentence is the same every time,
whether or not you actually edited the plan. Reviewers' returns and hand-overs get no such sentence.

## Who

- All four agents: Planner, Plan reviewer, Developer, Code reviewer.
- The Planner also resumes its conversation when you send the plan back at the plan confirmation.
- A new workflow (a new `/dev`, also after a stop) always starts clean: no agent sees anything from an earlier
  workflow.
- After the workflow ends, the model sees only the closing note and what follows it; the screen keeps everything.

## What does not change

- Rounds, round limits, the dialogs and the tools.
- The bottom bar. Its context figure appears after the agent's first answer.
- The cost totals.
- The first briefing of each agent: its content is the same, apart from one rule in the shared rules, which says
  what the agent sees (see Decision 5).

## Supersedes

These statements in earlier documents do not hold any more. The documents are left as they are, on purpose
(decided with the user); where they disagree with this plan, this plan is right.

- `01-BUSINESS-PLAN.md`: the bullet "Every agent starts with a clean context" (it receives only the plan, the
  reviewer's latest feedback and the project files), and Confirmed decision 1, "Clean context also applies on
  return" (the author starts fresh and does not resume its old conversation).
- `01-TECHNICAL-PLAN.md` §1, item 3: "a context window — the model sees only messages since its own briefing".
- `01-TECHNICAL-PLAN.md` §6: "Rule: drop every message before the latest marker" and "each agent sees its briefing
  and its own conversation, nothing else". An agent keeps its own earlier segments since the last closing note; every
  other agent's segments and everything before the workflow stay hidden.
- `01-TECHNICAL-PLAN.md` §7, the table: the text "On a later round: …" in the Planner row (the Plan reviewer's
  feedback, or your comments, and "the plan on disk is the current draft") and in the Developer row (the Code
  reviewer's feedback). A later round brings only the short `Returned from …` message; the full text appears only in
  the first briefing. Also the paragraph below the table, "A fresh agent on a return round gets no memory of its
  earlier attempt …".
- `01-TECHNICAL-PLAN.md` §12: the statement that a long single-agent segment is "uncommon". An agent's context holds
  all its rounds and can be long.
- `01-TECHNICAL-PLAN.md` §14: the line "Keeping an author's context when work is returned to it is in `TODO.md`".
- `02-agent-context-and-workflow-cost.md`, the line "The workflow's whole point is that each agent works with a
  small, clean context": it does not hold for an agent's later rounds, because its context also holds its own
  earlier rounds. The rest of that document ("its briefing and its own conversation") holds in substance.

## Known limitation: compaction

pi compacts the whole session, not one agent's conversation. An agent's context holds its earlier rounds, so it
grows over the workflow and can reach the compaction limit. After a compaction an agent may have lost part of its
earlier conversation, and the chat view is rebuilt from the compaction on, so the earlier agents vanish from the
screen. The only compaction that is prevented is the spurious one right after a hand-off.

Making compaction work per agent is the TODO item "Make compaction aware of agents".

## Success criteria

- An agent that is activated again sees its own earlier conversation and nothing of any other agent's.
- The message it gets is the title line plus one `Returned from …` or `Handed over from …` sentence.
- After you send the plan back, the Planner's new message also contains the fixed reminder about the plan file; no
  other returned or handed-over message does.

## Decisions

1. Every agent keeps its own earlier context, reviewers included.
2. Your send-back at the plan confirmation resumes the Planner's earlier conversation.
3. The re-activation message is the title line `# <Stage> · <Agent> · round N/M`, a blank line, and
   `Returned from <label>: <text>` (work comes back to an author) or `Handed over from <label>: <notes>` (the
   author hands over again). The label is the reviewer's name, the author's name, or `the user` for your send-back.
   It contains no role text, plan format, git baseline or reminders.
4. The fixed sentence for your send-back: the message `Returned from the user: <comments>` is followed by one fixed
   sentence telling the Planner that the plan file may have been edited by the user since it wrote it and that it
   should read it before changing it. No other message carries it.
5. The rules of the first briefing say: no other agent's conversation is visible; the agent's own conversation
   continues when work comes to it again; the two message forms. After a compaction an agent may lose part of its
   earlier conversation (see Known limitation).
6. "Briefed before" is derived from the session, so it is right after `/resume`, `/reload` and `/tree`.
7. The bar's agent-context figure appears after the agent's first answer and shows the size reported for its newest
   answer.
