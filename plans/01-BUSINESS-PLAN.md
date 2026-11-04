# dev-workflow — business plan

A simpler sibling of `pi-workflow`. One fixed development workflow, started with `/dev`,
where four agents hand work to each other and you talk directly to whichever one is active.

## Problem

Asking one agent to plan, build and judge its own work produces plans that quietly grow
features, code that drifts from the plan, and "looks good to me" reviews written by the author.
`pi-workflow` solves this with configurable, headless steps — more flexible than needed, and the
agents cannot simply ask you something.

## Goal

A single command that runs a disciplined **plan → build** process in which:

- every piece of work is **checked by a separate agent** against what you actually asked for,
- the reviewer can **send work back** and the author fixes it, until the reviewer is satisfied,
- you can **talk to the active agent at any time** — answering questions, giving direction —
  without any special "ask the user" mechanism,
- you always **see where the workflow is**: which stage, which agent, which round.

## The workflow

```
 PLANNING                                   DEVELOPMENT
 ┌─────────┐    ┌───────────────┐          ┌───────────┐    ┌───────────────┐
 │ Planner │ ⇄  │ Plan reviewer │ ─ you ─▶ │ Developer │ ⇄  │ Code reviewer │ ─▶ done
 └─────────┘    └───────────────┘ confirm  └───────────┘    └───────────────┘
```

### Start

`/dev` takes no arguments. It opens the **Planner** and shows a hint; the Planner responds only
after you send your first message, your assignment. You describe what you want in the chat; the
Planner asks follow-up questions in the same chat.

### Planning stage

1. **Planner** — turns your assignment into a plan. Asks you questions until the ambiguities are
   settled, then writes the plan and calls `advance` to hand it over for review.
2. **Plan reviewer** — critically reviews the plan against what *you* asked for:
   - does it stay within the scope you gave, with nothing added that you did not ask for?
   - is anything you asked for missing?
   - is it concrete enough that a developer could build from it without guessing?
   - are the decisions you made during questioning reflected?

   It either calls `advance` (approves) or `return` (sends the plan back to the Planner with
   concrete feedback). The Planner revises, calls `advance` again, and the loop repeats.
3. **You confirm the plan.** When the Plan reviewer approves, you see the plan and decide:
   approve it, send it back to the Planner with your comments, or stop. Development never
   starts without your confirmation.

### Development stage

1. **Developer** — implements the confirmed plan, runs the project's tests/checks, and calls
   `advance` to hand the result over for review.
2. **Code reviewer** — reviews the result against the plan:
   - **scope** — everything in the plan is done, and nothing extra was added,
   - **correctness** — it works and the tests/checks pass,
   - **code quality** — readable, consistent with the codebase, no needless complexity.

   It either calls `advance` (approves) or `return` (sends the work back to the Developer with
   concrete feedback). The Developer fixes it, calls `advance` again, and the loop repeats.
3. **Done.** When the Code reviewer calls `advance`, the workflow ends. There is no
   confirmation step from you here — you review the final result yourself, as you would any finished work.

The Code reviewer can only send work back to the Developer. It never reopens Planning; if it
believes the plan itself is wrong, it says so in its feedback and you decide what to do.

## Working with an agent

- **Only one agent is active at a time, and it is your chat partner.** Anything it needs from
  you, it simply asks in the chat. Reviewers can do the same (for example: "was this extra
  feature intended?").
- **Handing over is an explicit action.** An agent finishes its part by using one of just two
  tools:
  - `advance` — "my part is done, move on". For an author (Planner, Developer) it submits the
    work for review. For a reviewer (Plan reviewer, Code reviewer) it approves the work.
  - `return` — "this is not good enough, take it back", with concrete feedback. Reviewers only.

  Authors have `advance` only; reviewers have both. An agent that merely stops talking has
  **not** handed over; the workflow keeps waiting.
- **Every agent starts with a clean context.** It receives only what it needs — the plan, the
  reviewer's latest feedback, and the current state of the project files — not the previous
  agent's conversation, and not your original assignment. This keeps reviewers independent of the
  author's reasoning. The earlier conversations stay visible in the chat for you to scroll back to.
- **The plan is a document**, saved as a file in the project, that you can read and edit. It has
  a mandatory **Scope** section (what is in, what is out, and the decisions you made). Both
  reviewers judge against it; the Planner's job is to get it right. Because the Plan reviewer does
  not see your original assignment, it checks the plan against what the plan itself says you
  asked for, and it can ask you in the chat when something looks added or missing.
- **Every agent has all the usual tools.** There is no permission system; the roles are kept by
  instructions, not by blocking tools. (Reviewers are told to report problems, not fix them.)
- **All agents use the model you currently have selected.**
- **After the workflow ends, the chat starts clean.** The model does not remember the workflow's
  conversations, nor what was said before `/dev`. A short note records the outcome and where the
  plan is. The full history stays visible on screen.

## Rounds and the limit

A **round** is one hand-over to a reviewer and the reviewer's answer. Each stage counts its own
rounds. After **3 rounds** without approval, the workflow stops and asks you what to do:
let the loop continue for **one more round**, accept the current result as it is, or stop the
workflow. Changes you request at the plan confirmation do not count as a round.

## What you see

### In the chat

Every time the active agent changes, a **banner** marks the switch (stage, agent, round). The
previous agent's conversation stays above it, so the whole history remains in one scrollable
place.

### At the bottom of the session

Four boxes, one per agent, grouped by stage (visually bordered together). Each stage shows its
current round:

```
╭─ Planning · round 2/3 ───────────────────╮  ╭─ Development · not started ─────────────╮
│  ✓ Planner      ▶ Plan reviewer          │  │    Developer        Code reviewer       │
╰──────────────────────────────────────────╯  ╰─────────────────────────────────────────╯
```

- **Active agent** — strongly highlighted.
- **Finished agent** (handed over earlier) — dimmed, with a check mark.
- **Waiting agent** (not reached yet) — muted.
- The highlight moves back and forth as work is returned, and the round counter goes up.

The display is visible for the whole workflow and disappears when it ends.

## Starting, stopping, and edge cases

- `/dev` is the only command. Run while no workflow is active, it starts one. Run during an
  active workflow, it offers to stop it.
- Only one workflow can be active at a time.
- Stopping discards the active workflow's state; files already written (the plan, code changes)
  stay.

## Success criteria

- You can go from an idea to reviewed, working code using only `/dev` and chat.
- A plan with a feature you never asked for is caught and returned by the Plan reviewer.
- Code that deviates from the plan, or has a bug, is caught and returned by the Code reviewer.
- At any moment you can tell, at a glance, which agent you are talking to, and how many rounds
  each stage has used.
- Having used it once, you need no documentation.

## Confirmed decisions

1. **Clean context also applies on return.** When a reviewer returns work, the author starts
   fresh with the plan, the feedback and the current project files — it does not resume its old
   conversation. (Simplest; the work itself lives in files, so little is lost.)
2. **No separate stop/resume commands**, per "just `/dev`". Stopping goes through `/dev` while a
   workflow is active; an interrupted session means starting over.
3. **At the round limit in Planning**, "accept as it is" means "go to your plan confirmation",
   and in Development it means "finish".
