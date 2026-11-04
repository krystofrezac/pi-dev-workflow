#!/usr/bin/env python3
"""
dev-workflow — end-to-end check of the REAL extension in a real terminal.

pi runs in a pseudo-terminal (pty) with the package's index.ts and the scripted fake model
(fake-model.ts); a terminal emulator (pyte) reads the screen; keystrokes play the user. The fake model logs
every request exactly as a provider would receive it, which is the ground truth for context isolation.

    npm run e2e [-- scenario ...]

`npm run e2e` (e2e/run.sh) creates the Python venv with pyte on first use and runs this file with the pinned `pi` from
node_modules. The fake-model scenarios run pi with their own empty agent directory (<work dir>/agent), so they do not depend
on your pi config; `real` keeps your agent directory, because it needs your credentials.

Scenarios (default: all)
    full        /dev (no model request until your first message) → Planner ⇄ Plan reviewer → confirmation (edit, approve)
                → Developer ⇄ Code reviewer → done; an agent activated again sees its own earlier conversation, nothing of another agent's
    stop        /dev while the Planner waits for your first message → Cancel / Stop; Stop from the plan confirmation
    limit       planning round limit: Continue, Accept as is, send back, Stop
    abort       Esc interrupts the turn only; /dev → Stop while an agent is running aborts it, then ends the workflow
    real        (opt-in, costs a few cents) the same flow with a real model: E2E_REAL_MODEL, default github-copilot/claude-haiku-5.5
    resume      quit pi mid-workflow (after the first message), restart with --continue → state, bar and tools restored
    compaction  per-agent compaction: the Planner's context passes the threshold and only the Planner's own older conversation is
                summarised; the chat is not rebuilt, the summary banner shows, the other agents are untouched
    manual-compact  /compact while a workflow runs is refused with a notice and changes nothing
    usage       the bar's `agent ctx` figure belongs to the active agent only (a big Planner context is not carried over to the
                Plan reviewer); the stopped banner shows cost and tokens

Work dir: /tmp/dev-e2e/<scenario>  (screen dumps, request log and session are kept there)
"""
import fcntl, json, os, pty, re, select, shutil, signal, struct, subprocess, sys, termios, time
import pyte

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.dirname(HERE) + "/index.ts"
FAKE = HERE + "/fake-model.ts"
WORK = os.environ.get("E2E_WORK", "/tmp/dev-e2e")
ROWS, COLS = 1500, 170  # very tall, so the whole chat is on "screen" at once

DOWN, ENTER = "\x1b[B", "\r"
BANNER = "▶ Planning · Planner · round 1/3"  # the "workflow started" signal
HINT = "Planner is ready — describe what you want to build."  # a literal on purpose: not imported from index.ts
results = []


def check(name, ok, detail=""):
    ok = bool(ok)
    results.append(ok)
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  — ' + str(detail)) if detail and not ok else ''}")
    return ok


class Tui:
    def __init__(self, name, env=None, resume=False, settings=None, model=None):
        self.dir = f"{WORK}/{name}"
        self.repo = f"{self.dir}/repo"
        self.log = f"{self.dir}/log.jsonl"
        if not resume:
            shutil.rmtree(self.dir, ignore_errors=True)
            os.makedirs(self.repo + "/.pi", exist_ok=True)
            git = ["git", "-c", "user.email=e2e@example.com", "-c", "user.name=e2e"]
            subprocess.run(git + ["init", "-q"], cwd=self.repo, check=True)
            open(self.repo + "/README.md", "w").write("throwaway repo for the dev-workflow e2e\n")
            subprocess.run(["git", "add", "."], cwd=self.repo, check=True)
            subprocess.run(git + ["commit", "-q", "-m", "init"], cwd=self.repo, check=True)
            if settings:
                json.dump(settings, open(self.repo + "/.pi/settings.json", "w"))
        self.screen = pyte.Screen(COLS, ROWS)
        self.stream = pyte.ByteStream(self.screen)
        args = ["pi", "--approve", "--no-extensions", "--extension", EXT] + ([] if model else ["--extension", FAKE]) + [
                "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-mcp", "--offline",
                "--session-dir", self.dir + "/sessions", "--model", model or "fake/fake-1", "--tui-mode", "regular"]
        if model:
            args += ["--thinking", "low"]
        if resume:
            args.append("--continue")
        env = dict(env or {})
        if not model:
            env.setdefault("PI_CODING_AGENT_DIR", self.dir + "/agent")
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(self.repo)
            os.execvpe("pi", args, dict(os.environ, TERM="xterm-256color", COLUMNS=str(COLS), LINES=str(ROWS), E2E_LOG=self.log, **env))
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        os.kill(self.pid, signal.SIGWINCH)
        self.pump(3)

    def pump(self, seconds):
        end = time.time() + seconds
        while time.time() < end:
            r, _, _ = select.select([self.fd], [], [], 0.1)
            if r:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    return False
                if not data:
                    return False
                self.stream.feed(data)
        return True

    def text(self):
        return "\n".join(line.rstrip() for line in self.screen.display).rstrip()

    def wait(self, needle, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.3)
            if needle in self.text():
                return True
        return False

    def wait_count(self, needle, n, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.3)
            if self.text().count(needle) >= n:
                return True
        return False

    def send(self, s, pause=0.4):
        os.write(self.fd, s.encode())
        self.pump(pause)

    def type_line(self, s):
        self.send(s, 0.8)  # let the autocomplete settle
        self.send(ENTER, 0.5)

    def dump(self, label):
        open(f"{self.dir}/screen-{label}.txt", "w").write(self.text())

    def requests(self):
        """Every request the fake model got, the summarisation requests included."""
        if not os.path.exists(self.log):
            return []
        return [r for r in (json.loads(l) for l in open(self.log) if l.strip()) if r["ev"] == "request"]

    def agent_requests(self):
        """The requests the agents made (not the summarisation requests)."""
        return [r for r in self.requests() if not r.get("summary")]

    def summary_requests(self):
        """The requests that asked for a summary of an agent's context."""
        return [r for r in self.requests() if r.get("summary")]

    # entries() and briefings() read the session files. pi writes a session file only once it holds a user or assistant
    # message, so call them only after a user message was sent — never between /dev and the first message.
    def entries(self):
        out = []
        for root, _, names in os.walk(self.dir + "/sessions"):
            for n in sorted(names):
                if n.endswith(".jsonl"):
                    out += [json.loads(l) for l in open(os.path.join(root, n)) if l.strip()]
        return out

    def briefings(self):
        """Text of every dev-briefing message in the session, in order."""
        return [e["content"] for e in self.entries() if e.get("type") == "custom_message" and e.get("customType") == "dev-briefing"]

    def close(self):
        for _ in range(2):
            try:
                self.send("\x03", 0.4)
            except OSError:
                break
        self.pump(0.5)
        try:
            os.kill(self.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(self.pid, 0)
        except ChildProcessError:
            pass


def tag(r):
    """The newest briefing of a request, shortened: `# Planning · Planner · round 1/3` → `planner#1`."""
    b = r["briefings"][-1] if r["briefings"] else ""
    m = re.match(r"# \w+ · ([\w ]+) · round (\d+)/", b)
    return f"{m.group(1).lower().replace(' ', '-')}#{m.group(2)}" if m else "none"


def activations(reqs):
    out, last = [], None
    for r in reqs:
        if tag(r) != last:
            out.append(tag(r))
        last = tag(r)
    return out


def bar_has(screen_text, title):
    return f"╭─ {title}" in screen_text


def bar_rows(screen_text):
    """The bottom bar's three rows (top, middle, bottom) as drawn on screen, or None when there is no bar."""
    lines = screen_text.split("\n")
    for i in range(len(lines) - 3, -1, -1):
        if "╭─ Planning ·" in lines[i]:
            return lines[i], lines[i + 1], lines[i + 2]
    return None


def ctx_tokens(row):
    """The number after `agent ctx` in a bar row (`agent ctx 3.4k/128k · 3%` → 3400.0), or None."""
    m = re.search(r"agent ctx (\d+(?:\.\d+)?)([kM]?)", row or "")
    return float(m.group(1)) * {"": 1, "k": 1e3, "M": 1e6}[m.group(2)] if m else None


def session_cost(entries):
    """Everything the session's entries cost: what pi's footer adds up (responses, usage entries, tool results, compactions)
    and the context summaries of the agents (`dev-summary` messages)."""
    total = 0.0
    for e in entries:
        u = None
        if e.get("type") == "message" and e["message"].get("role") in ("assistant", "toolResult"):
            u = e["message"].get("usage")
        elif e.get("type") in ("usage", "compaction", "branch_summary"):
            u = e.get("usage")
        elif e.get("type") == "custom_message" and e.get("customType") == "dev-summary":
            u = (e.get("details") or {}).get("usage")
        if u:
            total += u.get("cost", {}).get("total", 0)
    return total


# ───────────────────────────── scenarios ─────────────────────────────


def full():
    print("━━ full ━━")
    t = Tui("full")
    t.type_line("/dev")
    ok = t.wait(BANNER, 30)
    check("/dev starts the Planner without a model request", ok)
    if not ok:
        print(t.text()[-2500:])
        t.close()
        return
    s = t.text()
    check("banner on screen: ▶ Planning · Planner · round 1/3", BANNER in s)
    check("the hint tells the user to describe what they want, below the banner", HINT in s and s.index(BANNER) < s.index(HINT), s[-900:])
    check("bottom bar on screen: Planning · round 1/3, Planner active, Development not started",
          bar_has(s, "Planning · round 1/3") and "▶ Planner" in s and "Development · not started" in s, s[-900:])
    rows = bar_rows(s)
    check("before any answer: `workflow no price` on the bar's middle row, and no `agent ctx` anywhere", rows and "workflow no price" in rows[1] and "agent ctx" not in s, rows)
    t.pump(3)
    check("no model request was made between /dev and the first message", t.agent_requests() == [], t.agent_requests())

    t.type_line("a hello file")  # the assignment, the user's first message
    ok = t.wait("Confirm the plan", 60)
    check("Planner → Plan reviewer → Planner → Plan reviewer ran and the plan confirmation opened", ok)
    if not ok:
        print(t.text()[-3000:])
        t.close()
        return
    first = t.agent_requests()[0]
    check("the Planner's first request is its briefing + the user's first message, with `advance` but without `return`",
          first["n"] == 2 and len(first["briefings"]) == 1 and first["conversation"][0].startswith("user:# ")
          and first["conversation"][1].startswith("user:a hello file") and "advance" in first["tools"] and "return" not in first["tools"], first)
    check("all the usual tools stay available", all(x in first["tools"] for x in ["read", "bash", "edit", "write"]), first["tools"])
    s = t.text()
    t.dump("confirm")
    check("one-tool-call rule: `advance` next to `bash` was rejected, the Planner retried alone", "must be the only tool call in its response" in s)
    check("a banner for every switch (planner 1, reviewer 1, planner 2, reviewer 2)",
          all(x in s for x in ["▶ Planning · Planner · round 1/3", "▶ Planning · Plan reviewer · round 1/3", "▶ Planning · Planner · round 2/3", "▶ Planning · Plan reviewer · round 2/3"]))
    check("the earlier agents' conversation is still on screen", "a hello file" in s)
    check("the dialog shows the plan path and the reviewer's note", "plan approved: it stays in scope" in s and ".pi/dev/0001/plan.md" in s)
    check("the bar shows Planner ✓ and Plan reviewer ▶ in round 2/3", bar_has(s, "Planning · round 2/3") and "✓ Planner" in s and "▶ Plan reviewer" in s)
    rows = bar_rows(s)
    check("the bar's top row shows the active agent's context: `agent ctx …/128k`", rows and "agent ctx" in rows[0] and "/128k" in rows[0], rows)
    check("…and the middle row the workflow's cost: `workflow no price` (the fake model has no prices)", rows and "workflow no price" in rows[1], rows)

    # Edit plan… (2nd option) → editor → append text → Enter → asked again → Approve
    t.send(DOWN)
    t.send(ENTER, 1.0)
    check("'Edit plan…' opens the plan in the editor", t.wait("REVIEWED", 5) and "submit" in t.text())
    t.send("EDITED-BY-USER", 0.5)
    t.send(ENTER, 1.0)
    plan = open(t.repo + "/.pi/dev/0001/plan.md").read()
    check("the edited plan was written back to the file", "EDITED-BY-USER" in plan, plan[-200:])
    check("…and the confirmation is asked again", t.wait("Confirm the plan", 5))
    t.send(ENTER, 1.0)  # Approve and start development

    ok = t.wait("Workflow finished", 60)
    check("Developer ⇄ Code reviewer ran and the workflow finished", ok)
    t.pump(2)
    s = t.text()
    t.dump("final")
    if not ok:
        print(s[-3000:])
    check("banner: ✓ Workflow finished, with the Code reviewer's note", "✓ Workflow finished" in s and "code approved: matches the plan" in s)
    check("banners for the development stage",
          all(x in s for x in ["▶ Development · Developer · round 1/3", "▶ Development · Code reviewer · round 1/3", "▶ Development · Developer · round 2/3", "▶ Development · Code reviewer · round 2/3"]))
    check("everything is still on screen after the end (assignment, reviewer feedback)", "a hello file" in s and "add a second line to hello.txt" in s)
    tail = s.split("Workflow finished")[-1]
    check("the bottom bar is gone after the workflow", "╭─" not in tail)
    banner = s[s.rfind("✓ Workflow finished"):]
    check("the finished banner shows `Cost: no price` and a `Tokens:` line", "Cost: no price" in banner and re.search(r"Tokens: \S+ in\b", banner), banner)
    check("the figures went with the bar: no `agent ctx` and no `workflow …` below the banner", "agent ctx" not in tail and "workflow no price" not in tail, tail)

    reqs = t.agent_requests()
    expected = ["planner#1", "plan-reviewer#1", "planner#2", "plan-reviewer#2", "developer#1", "code-reviewer#1", "developer#2", "code-reviewer#2"]
    check("agents ran in the expected order", activations(reqs) == expected, activations(reqs))
    check("13 requests in total — none after the final hand-off", len(reqs) == 13, f"got {len(reqs)}")
    first_of = {}
    for r in reqs:
        first_of.setdefault(tag(r), r)
    check("`return` is declared to reviewers only", all(("return" in first_of[k]["tools"]) == ("reviewer" in k) for k in first_of), {k: v["tools"] for k, v in first_of.items()})
    check("every agent has `advance`", all("advance" in first_of[k]["tools"] for k in first_of))
    check("a reviewer's first request is its briefing alone", first_of["plan-reviewer#1"]["n"] == 1 and first_of["code-reviewer#1"]["n"] == 1)

    def own_titles(key):
        """The titles of an agent's briefings up to round k, as the key `<agent>#k` names them: `plan-reviewer#2` → rounds 1 and 2."""
        agent, k = key.split("#")
        stage = "Planning" if agent in ("planner", "plan-reviewer") else "Development"
        return [f"# {stage} · {agent.replace('-', ' ').capitalize()} · round {i}/3" for i in range(1, int(k) + 1)]

    check("an activation's first request carries exactly its own agent's briefings, rounds 1…k in order, and starts with the round-1 briefing",
          all(r["briefings"] == own_titles(k) and r["conversation"][0].startswith("user:" + own_titles(k)[0]) for k, r in first_of.items()),
          {k: r["briefings"] for k, r in first_of.items()})
    joined = {k: "\n".join(r["conversation"]) for k, r in first_of.items()}
    check("a re-activated reviewer sees its own earlier `return` and nothing of the author's (no `write`, no assignment)",
          all("<call return>" in joined[k] and "<call write>" not in joined[k] and "user:a hello file" not in joined[k] for k in ("plan-reviewer#2", "code-reviewer#2")),
          {k: first_of[k]["conversation"] for k in ("plan-reviewer#2", "code-reviewer#2")})
    check("the returned Planner sees the assignment and its own `write`, and no `return` of the reviewer",
          "user:a hello file" in joined["planner#2"] and "<call write>" in joined["planner#2"] and "<call return>" not in joined["planner#2"], first_of["planner#2"]["conversation"])
    check("the returned Developer sees its own `write` only (the Planner's plan writes are hidden) and no `return` of the reviewer",
          joined["developer#2"].count("<call write>") == 1 and "<call return>" not in joined["developer#2"], first_of["developer#2"]["conversation"])

    briefings = t.briefings()
    check("8 briefings were recorded", len(briefings) == 8, len(briefings))
    reviewer = next(b for b in briefings if b.startswith("# Planning · Plan reviewer · round 1"))
    check("the Plan reviewer's briefing has the Planner's summary and no assignment text", "plan ready" in reviewer and "a hello file" not in reviewer)
    developer = next(b for b in briefings if b.startswith("# Development · Developer · round 1"))
    check("the Developer's briefing carries the git baseline", re.search(r"Baseline commit: `[0-9a-f]{40}`", developer) is not None, developer[-600:])
    code = next(b for b in briefings if b.startswith("# Development · Code reviewer · round 1"))
    check("the Code reviewer's first briefing has the Developer's summary and the diff command", "implemented hello.txt" in code and "git diff " in code)
    for message in [
        "# Planning · Planner · round 2/3\n\nReturned from Plan reviewer: add the word REVIEWED to the plan",
        "# Planning · Plan reviewer · round 2/3\n\nHanded over from Planner: plan revised",
        "# Development · Developer · round 2/3\n\nReturned from Code reviewer: add a second line to hello.txt",
        "# Development · Code reviewer · round 2/3\n\nHanded over from Developer: implemented hello.txt",
    ]:
        title = message.split("\n")[0]
        got = [b for b in briefings if b.startswith(title)]
        check(f"{title[2:]}: the message is the title line and one sentence, nothing else", got == [message], got)

    t.type_line("what do you see?")
    ok = t.wait("I see 2 message(s)", 30)
    s = t.text()
    check("afterwards the model sees only the closing note and the new message", ok and "[dev-workflow] Workflow 0001 finished" in s.split("I see 2 message(s)")[-1], s[-600:])
    check("normal tools are back (no `advance` / `return`)", not ({"advance", "return"} & set(t.agent_requests()[-1]["tools"])), t.agent_requests()[-1]["tools"])
    check("the Developer's work is on disk", open(t.repo + "/hello.txt").read() == "hello\nworld\n")
    entries = t.entries()
    states = [e for e in entries if e.get("type") == "custom" and e.get("customType") == "dev-state"]
    check("the state is mirrored to the session: first 'planner', last 'no workflow'", states and states[0]["data"]["agent"] == "planner" and states[-1].get("data") is None)
    check("one closing note in the session", len([e for e in entries if e.get("customType") == "dev-end"]) == 1)
    t.close()


def stop():
    print("━━ stop ━━")
    t = Tui("stop")
    t.type_line("/dev")
    check("the workflow started", t.wait(BANNER, 30))
    t.type_line("/dev")
    check("/dev while a workflow runs offers Stop / Cancel", t.wait("is running — Planner is active", 10))
    t.send(DOWN)
    t.send(ENTER, 1.0)  # Cancel
    check("Cancel keeps the workflow", "Workflow stopped" not in t.text() and bar_has(t.text(), "Planning · round 1/3"))
    t.type_line("/dev")
    t.wait("is running — Planner is active", 10)
    t.send(ENTER, 1.5)  # Stop workflow
    ok = t.wait("Workflow stopped", 10)
    s = t.text()
    check("Stop ends the workflow with a banner naming the plan", ok and "✗ Workflow stopped" in s and "plan.md" in s)
    check("the bar is gone", "╭─" not in s.split("✗ Workflow stopped")[-1])
    banner = s[s.rfind("✗ Workflow stopped"):]
    check("the stopped banner shows `Cost:` and, as nothing was used, no `Tokens:` line", "Cost:" in banner and "Tokens:" not in banner, banner)
    t.type_line("hi")
    ok = t.wait("I see 2 message(s)", 20)
    check("after Stop the model sees only the closing note and the new message", ok, t.text()[-500:])
    check("…with the normal tool set", not ({"advance", "return"} & set(t.agent_requests()[-1]["tools"])))
    t.type_line("/dev")
    ok = t.wait_count(BANNER, 2, 20) and len(t.briefings()) >= 2
    check("a new /dev can be started afterwards, in a new run folder", ok and os.path.isdir(t.repo + "/.pi/dev/0002"))
    t.close()

    t = Tui("stop-confirm")
    t.type_line("/dev")
    t.wait(BANNER, 30)
    t.type_line("anything")
    check("(second run) plan confirmation reached", t.wait("Confirm the plan", 60))
    t.send(DOWN); t.send(DOWN); t.send(DOWN)
    t.send(ENTER, 1.5)  # Stop workflow
    ok = t.wait("Workflow stopped", 10)
    check("Stop at the plan confirmation ends the workflow; the plan stays on disk", ok and os.path.exists(t.repo + "/.pi/dev/0001/plan.md"))
    t.pump(1)
    s = t.text()
    banner = s[s.rfind("✗ Workflow stopped"):]
    check("the stopped banner shows `Cost:` and a `Tokens:` line (the Planner and the Plan reviewer answered)", "Cost:" in banner and re.search(r"Tokens: \S+ in\b", banner), banner)
    n = len(t.agent_requests())
    t.pump(2)
    check("…and no further model request was made", len(t.agent_requests()) == n)
    t.close()


def limit():
    print("━━ limit ━━")
    t = Tui("limit", env={"E2E_PLAN_APPROVE_ROUND": "99"})
    t.type_line("/dev")
    t.wait(BANNER, 30)
    t.type_line("something")
    ok = t.wait("Round limit reached", 90)
    s = t.text()
    check("after 3 rounds without approval the limit dialog opens", ok and "Planning: 3 round(s) without approval" in s, s[-1200:])
    check("…the bar showed round 3/3", bar_has(s, "Planning · round 3/3"))
    check("…three Planner briefings and three reviews happened",
          activations(t.agent_requests()) == ["planner#1", "plan-reviewer#1", "planner#2", "plan-reviewer#2", "planner#3", "plan-reviewer#3"], activations(t.agent_requests()))
    t.send(ENTER, 1.0)  # Continue (one more round)
    ok = t.wait("Planning: 4 round(s) without approval", 60)
    s = t.text()
    check("Continue grants exactly one more round (4/4), then the dialog comes back", ok and "Planning · Planner · round 4/4" in s and "Planning: 4 round(s) without approval" in s, s[-1200:])
    t.send(DOWN)
    t.send(ENTER, 1.0)  # Accept as is
    ok = t.wait("Confirm the plan", 10)
    s = t.text()
    check("Accept as is (planning) goes to the plan confirmation and says it was not approved", ok and "Accepted as is after 4 round(s)" in s.split("Planning: 4 round(s) without approval")[-1], s[-800:])
    t.send(DOWN); t.send(DOWN)
    t.send(ENTER, 1.0)  # Send back to Planner…
    check("'Send back…' asks for comments", t.wait("Comments for the Planner", 5))
    t.send("please simplify", 0.5)
    t.send(ENTER, 1.0)
    ok = t.wait("Planning: 4 round(s) without approval", 60)  # the first one was dismissed, so this is the second
    check("…the Planner revised and the reviewer's next return opens the limit dialog again", ok)
    briefings = t.briefings()
    fixed = "The plan file may have been edited by the user since you wrote it; read it before you change it."  # a literal on purpose: not imported from briefings.ts
    mine = [b for b in briefings if b.startswith("# Planning · Planner · round 4/4") and "Returned from the user: please simplify" in b and fixed in b]
    check("sending back activated the Planner again, still round 4/4, with the user's comments and the reminder about the plan file in its message", len(mine) == 1, [b[:60] for b in briefings[-3:]])
    check("…and no round 5 was started", not any("round 5/" in b.split("\n")[0] for b in briefings))
    t.send(DOWN); t.send(DOWN)
    t.send(ENTER, 1.5)  # Stop workflow
    check("Stop at the limit dialog ends the workflow", t.wait("Workflow stopped", 10))
    t.close()


def abort():
    print("━━ abort ━━")
    t = Tui("abort", env={"E2E_SLEEP": "120", "E2E_NO_COMBO": "1"})
    t.type_line("/dev")
    t.wait(BANNER, 30)
    t.type_line("an assignment")
    check("the Planner is running a long command", t.wait("sleep 120", 20))
    t.send("\x1b", 1.5)  # Esc: interrupt
    s = t.text()
    check("Esc interrupted the turn …", "Operation aborted" in s or "aborted" in s.lower(), s[-500:])
    check("… but the workflow and the active agent stay (bar, no 'stopped' banner)", bar_has(s, "Planning · round 1/3") and "▶ Planner" in s and "Workflow stopped" not in s)
    before = len(t.agent_requests())
    t.type_line("go on")
    ok = t.wait("plan file does not exist", 30)
    reqs = t.agent_requests()
    check("the same Planner carries on after the interruption (its briefing is still the first message)", len(reqs) > before and reqs[before]["conversation"][0].startswith("user:# Planning · Planner") and "advance" in reqs[before]["tools"], reqs[before:] and reqs[before]["conversation"])
    check("`advance` without a plan file is rejected with an explanation", ok, t.text()[-800:])
    check("…and nothing was handed over (still the Planner)", bar_has(t.text(), "Planning · round 1/3") and "▶ Planning · Plan reviewer" not in t.text())
    t.close()

    t = Tui("abort-stop", env={"E2E_SLEEP": "120", "E2E_NO_COMBO": "1"})
    t.type_line("/dev")
    t.wait(BANNER, 30)
    t.type_line("an assignment")
    check("(second run) the Planner is running a long command", t.wait("sleep 120", 20))
    t.type_line("/dev")
    check("/dev works while the agent is running", t.wait("is running — Planner is active", 10), t.text()[-500:])
    t.send(ENTER, 3.0)  # Stop workflow
    ok = t.wait("Workflow stopped", 20)
    s = t.text()
    check("Stop while an agent runs aborts it and ends the workflow", ok and "✗ Workflow stopped" in s, s[-800:])
    check("the bar is gone", "╭─" not in s.split("✗ Workflow stopped")[-1])
    n = len(t.agent_requests())
    t.pump(3)
    check("no model request after the stop", len(t.agent_requests()) == n)
    t.type_line("hi")
    ok = t.wait("I see 2 message(s)", 20)
    check("the session is usable afterwards: the model sees the closing note and the new message", ok, t.text()[-500:])
    t.type_line("/dev")
    check("a new workflow can be started", t.wait_count(BANNER, 2, 20) and os.path.isdir(t.repo + "/.pi/dev/0002"))
    t.close()


def real():
    """Smoke test with a real model: does it wait for the first message, ask, plan, hand over alone, review, implement, finish?
    A scripted 'user' answers any question with a go-ahead and approves the plan. Not part of the default run."""
    print("━━ real ━━")
    model = os.environ.get("E2E_REAL_MODEL", "github-copilot/claude-haiku-5.5")
    t = Tui("real", model=model)
    t.type_line("/dev")
    ok = t.wait(BANNER, 30)
    check("/dev starts the Planner", ok)
    # No model request yet: the hint is shown and nothing is working. (The session is not on disk before the first message.)
    t.pump(5)
    s = t.text()
    check("the Planner waits for the first message — the hint is shown and nothing is working", HINT in s and "Working" not in s, s[-800:])
    t.type_line("Create a file hello.txt in the project root containing exactly the single word hello. Nothing else is wanted: no tests, no README changes.")

    deadline = time.time() + 900
    answers = 0
    quiet = 0
    while time.time() < deadline:
        t.pump(1)
        s = t.text()
        if "Workflow finished" in s or "Workflow stopped" in s:
            break
        if "Confirm the plan" in s:
            t.dump("confirm")
            t.send(ENTER, 2.0)  # Approve and start development
            quiet = 0
            continue
        if "Round limit reached" in s:
            t.send(ENTER, 2.0)  # Continue
            continue
        quiet = quiet + 1 if "Working" not in s else 0
        if quiet >= 8 and answers < 6:  # a question is pending: give a go-ahead
            t.type_line("Yes, exactly as I described. No other requirements, no further questions please — go ahead.")
            answers += 1
            quiet = 0
    s = t.text()
    t.dump("final")
    done = "✓ Workflow finished" in s
    check("the workflow finished with a real model", done, s[-1500:])
    reqs = t.agent_requests()
    briefings = t.briefings()
    print(f"      briefings: {[b.splitlines()[0] for b in briefings]}")
    print(f"      user answers given: {answers}")
    check("the file was created as asked", os.path.exists(t.repo + "/hello.txt") and open(t.repo + "/hello.txt").read().strip() == "hello", os.listdir(t.repo))
    entries = t.entries()
    spent = session_cost(entries)  # /dev was the first thing in this session, so the whole session is the workflow
    m = re.search(r"Cost: (.+)", s[s.rfind("✓ Workflow finished"):])
    shown = m.group(1).strip() if m else None
    want = "no price" if spent == 0 else f"${spent:.3f}"
    check("the finished banner's `Cost:` is `no price` for a session that cost 0, else the sum of the session's costs", shown == want, f"banner {shown!r}, session {spent}")
    calls = []
    for e in entries:
        if e.get("type") == "message" and e["message"]["role"] == "assistant":
            calls.append([b["name"] for b in e["message"]["content"] if isinstance(b, dict) and b.get("type") == "toolCall"])
    handoffs = [c for c in calls if "advance" in c or "return" in c]
    print(f"      hand-over messages: {handoffs}")
    print(f"      hand-overs that shared a message with other calls (rejected and repeated): {sum(1 for c in handoffs if len(c) > 1)}")
    print(f"      work dir: {t.dir}")
    t.close()


def resume():
    print("━━ resume ━━")
    ask = {"E2E_ASK": "1"}  # both runs: the fake model's turn numbering must be the same
    t = Tui("resume", env=ask)
    t.type_line("/dev")
    t.wait(BANNER, 30)
    # Nothing is on disk yet: pi writes the session only from the first user message on.
    t.type_line("a hello file")
    t.wait("Which file name do you want?", 30)
    t.pump(1)
    states = [e for e in t.entries() if e.get("type") == "custom" and e.get("customType") == "dev-state"]
    check("the session on disk holds one briefing and a `dev-state` entry for the Planner",
          len(t.briefings()) == 1 and len(states) == 1 and states[0]["data"]["agent"] == "planner", (len(t.briefings()), states))
    check("exactly one request was made, with the briefing + the user's message (no greeting)",
          len(t.agent_requests()) == 1 and t.agent_requests()[0]["n"] == 2, t.agent_requests())
    t.close()
    t2 = Tui("resume", env=ask, resume=True)
    s = t2.text()
    check("after a restart (--continue) the bottom bar is back, Planner active", bar_has(s, "Planning · round 1/3") and "▶ Planner" in s, s[-1000:])
    check("the hint is not shown again after a restart", HINT not in s, s[-1000:])
    rows = bar_rows(s)
    check("after a restart the bar shows the Planner's `agent ctx` (it had answered) and `workflow no price`",
          rows and "agent ctx" in rows[0] and "workflow no price" in rows[1], rows)
    check("the chat was rebuilt from the right session: the Planner's question is on screen", "Which file name do you want?" in s, s[-1000:])
    before = len(t2.agent_requests())
    check("the restart itself made no model request", before == 1, before)
    t2.type_line("hello.txt")  # the answer
    check("the workflow carries on after the restart", t2.wait("Confirm the plan", 60))
    first = t2.agent_requests()[before]
    check("the Planner's request after the restart declares `advance`, not `return`", "advance" in first["tools"] and "return" not in first["tools"], first["tools"])
    conv = first["conversation"]
    check("…and carries briefing + first message + question + answer",
          first["n"] == 4 and conv[0].startswith("user:# ") and conv[1].startswith("user:a hello file")
          and conv[2].startswith("assistant:Which file name") and conv[3].startswith("user:hello.txt"), conv)
    t2.send(DOWN); t2.send(DOWN); t2.send(DOWN)
    t2.send(ENTER, 1.0)
    t2.close()


def compaction():
    print("━━ compaction ━━")
    # Per-agent compaction. Window 20000 tokens, reserve 9000, so an agent is compacted when its context passes 11000;
    # `keepRecentTokens` is 200, so the cut falls at the Planner's big `write`. The plan carries 20000 chars of padding
    # (~5k tokens), so the Planner's own answers report ~9.8k (the padded `write`) and ~12.6k (`advance`), the faux
    # provider counting the whole context plus the output. The Plan reviewer returns once, so the Planner runs twice.
    # Expected sequence:
    #  (a) Planner, round 1. The `write` answer is below the threshold; the `advance` answer is above it, so at the hand-off
    #      the Planner is compacted (compaction 1): only the user's one-line message lies before the cut (the cut splits a
    #      turn), so one summarisation request, for the turn's beginning. Kept: write, its result, advance, its result.
    #      The `dev-summary` is written before the Plan reviewer's briefing.
    #  (b) The Plan reviewer returns the plan.
    #  (c) Planner, round 2. Its first request shows [pinned round-1 briefing, summary 1, write, result, advance, result,
    #      round-2 message]. Its new padded `write` is over the threshold: compaction 2 at that turn's end, with no hand-off
    #      (the earlier summary is updated with the four kept messages, the round-2 message is the turn's beginning: two
    #      summarisation requests). Kept: the new write and its result.
    #  (d) The Planner's next request shows [pinned briefing, summary 2, write, result]. At the hand-off nothing but summary 2
    #      lies before the kept messages, so there is no third summary.
    #  (e) The Plan reviewer approves; the plan confirmation opens.
    # So: two `dev-summary` messages and three summarisation requests. pi's own `Auto-compaction cancelled` lines are on
    # screen and not checked.
    reserve = int(os.environ.get("E2E_RESERVE", "9000"))
    t = Tui("compaction", env={"E2E_CONTEXT_WINDOW": "20000", "E2E_PAD": "20000", "E2E_NO_COMBO": "1"},
            settings={"compaction": {"enabled": True, "reserveTokens": reserve, "keepRecentTokens": 200}})
    t.type_line("/dev")
    t.wait(BANNER, 30)
    t.type_line("a hello file")
    ok = t.wait("Confirm the plan", 120)
    t.pump(1)
    s = t.text()
    t.dump("confirm")
    check("the workflow reached the plan confirmation", ok)
    if not ok:
        print(s[-3000:])
        t.close()
        return
    check("the first banner and the assignment are still on screen (the chat view was not rebuilt)", BANNER in s and "a hello file" in s)
    banners = [line for line in s.split("\n") if "context compacted" in line]
    check("a `context compacted` banner is on screen, without a price (the fake model has none)", banners and all("no price" in line for line in banners), banners)
    entries = t.entries()
    check("the session has no `compaction` entry", not [e for e in entries if e.get("type") == "compaction"], [e.get("type") for e in entries][-10:])
    summaries = [e for e in entries if e.get("type") == "custom_message" and e.get("customType") == "dev-summary"]
    check("the session has exactly two `dev-summary` messages", len(summaries) == 2, len(summaries))
    check("each is the Planner's, with a summary, an integer `keep` and the usage of the summary requests",
          all(e["details"].get("agent") == "planner" and e["details"].get("summary") and isinstance(e["details"].get("keep"), int)
              and e["details"]["keep"] >= 0 and isinstance(e["details"].get("usage"), dict) for e in summaries), [e.get("details") for e in summaries])

    def position(match):
        return next((i for i, e in enumerate(entries) if match(e)), None)

    first_summary = position(lambda e: e.get("customType") == "dev-summary")
    reviewer = position(lambda e: e.get("customType") == "dev-briefing" and (e.get("details") or {}).get("agent") == "plan-reviewer")
    check("the first summary was written before the Plan reviewer's first briefing", first_summary is not None and reviewer is not None and first_summary < reviewer, (first_summary, reviewer))

    asked = t.summary_requests()
    check("three summarisation requests were made", len(asked) == 3, len(asked))
    if asked:
        check("the first one holds the user's message and nothing of the Plan reviewer",
              "a hello file" in asked[0]["text"] and "Plan reviewer" not in asked[0]["text"] and "return(" not in asked[0]["text"], asked[0]["text"][:500])

    reqs = t.agent_requests()
    again = next((r for r in reqs if tag(r) == "planner#2"), None)
    check("the Planner's first request of round 2 exists", again is not None, activations(reqs))
    if again:
        conv = again["conversation"]
        check("it starts with the pinned round-1 briefing, then the summary", len(conv) > 2 and conv[0].startswith("user:# Planning · Planner · round 1/3") and conv[1].startswith("user:Summary of your earlier conversation"), conv)
        check("…the reviewer's return reaches the Planner only through the round-2 message", any("Returned from Plan reviewer" in c for c in conv[2:]) and not any("<call return>" in c for c in conv), conv)
    first_of = {}
    for r in reqs:
        first_of.setdefault(tag(r), r)
    review2 = first_of.get("plan-reviewer#2")
    own = [f"# Planning · Plan reviewer · round {i}/3" for i in (1, 2)]
    check("the Plan reviewer is untouched: its round-2 request holds its own round-1 briefing and its own `return`, nothing of the Planner's",
          review2 is not None and review2["briefings"] == own and review2["conversation"][0].startswith("user:" + own[0])
          and any("<call return>" in c for c in review2["conversation"]) and not any("<call write>" in c or "Summary of your earlier" in c for c in review2["conversation"]),
          review2 and review2["conversation"])

    # Calibration, from the answers in the session: whose answer is above the threshold?
    threshold = 20000 - reserve
    answers, current = {}, None
    for e in entries:
        if e.get("type") == "custom_message" and e.get("customType") == "dev-briefing":
            current = e["details"]["agent"]
        elif e.get("type") == "message" and e["message"]["role"] == "assistant" and current:
            answers.setdefault(current, []).append(e["message"]["usage"]["totalTokens"])
    planner = answers.get("planner", [])
    check("calibration: the Planner's first answer is below the threshold, its second above it", len(planner) >= 2 and planner[0] < threshold < planner[1], f"{planner}, threshold {threshold}")
    others = [n for agent, ns in answers.items() if agent != "planner" for n in ns]
    check("calibration: no other agent's answer is above the threshold", all(n < threshold for n in others), f"{answers}, threshold {threshold}")
    t.send(DOWN); t.send(DOWN); t.send(DOWN)
    t.send(ENTER, 1.0)
    t.close()


def manual_compact():
    print("━━ manual-compact ━━")
    # `keepRecentTokens` is small, so pi's manual compaction finds something to summarise and reaches the extension's hook.
    t = Tui("manual-compact", env={"E2E_ASK": "1"}, settings={"compaction": {"enabled": True, "keepRecentTokens": 200}})
    t.type_line("/dev")
    t.wait(BANNER, 30)
    t.type_line("a hello file")
    check("the Planner asks its question and waits", t.wait("Which file name do you want?", 30))
    t.pump(1)
    t.type_line("/compact")
    ok = t.wait("/compact is not available while a workflow runs", 15)
    s = t.text()
    t.dump("manual")
    check("/compact is refused with a notice", ok, s[-1200:])
    check("the session has no `compaction` entry and no `dev-summary` message",
          not [e for e in t.entries() if e.get("type") == "compaction" or e.get("customType") == "dev-summary"], [e.get("type") for e in t.entries()][-10:])
    check("the workflow is untouched: the bar shows the Planner, the earlier chat is on screen", bar_has(s, "Planning · round 1/3") and "▶ Planner" in s and "Which file name do you want?" in s, s[-1200:])
    before = len(t.agent_requests())
    t.type_line("hello.txt")  # the answer to the question
    ok = t.wait("Confirm the plan", 60)
    check("the workflow still works: the Planner's next answers follow and the plan confirmation opens", ok and len(t.agent_requests()) > before, t.text()[-800:])
    t.send(DOWN); t.send(DOWN); t.send(DOWN)
    t.send(ENTER, 1.5)  # Stop workflow
    ok = t.wait("Workflow stopped", 10)
    check("the workflow can be stopped as usual", ok and not t.summary_requests(), t.text()[-500:])
    t.close()


def usage():
    print("━━ usage ━━")
    # A big Planner context (the plan carries 20000 chars of padding), then the Plan reviewer, whose own context is small.
    t = Tui("usage", env={"E2E_PAD": "20000", "E2E_NO_COMBO": "1"})
    t.type_line("/dev")
    t.wait(BANNER, 30)
    t.type_line("a hello file")
    ok = t.wait("Confirm the plan", 90)
    check("the workflow reached the plan confirmation", ok)
    if not ok:
        print(t.text()[-2500:])
        t.close()
        return
    t.pump(1)
    s = t.text()
    t.dump("confirm")
    # From the session: the biggest answer of the earlier agents (the Planner's), and the answer the Plan reviewer gave last
    # (the approval, after the newest briefing). What the bar shows must be the reviewer's figure.
    entries = t.entries()
    newest = max(i for i, e in enumerate(entries) if e.get("type") == "custom_message" and e.get("customType") == "dev-briefing")
    answers = lambda part: [e["message"]["usage"]["totalTokens"] for e in part if e.get("type") == "message" and e["message"]["role"] == "assistant"]
    planner, reviewer = answers(entries[:newest]), answers(entries[newest:])
    check("calibration: the Planner's context was big, the Plan reviewer answered once after its briefing", planner and reviewer and max(planner) > 4000, (planner, reviewer))
    rows = bar_rows(s)
    shown = ctx_tokens(rows[0]) if rows else None
    check("the bar shows the Plan reviewer's context: within ~300 tokens of its last answer", shown is not None and reviewer and abs(shown - reviewer[-1]) <= 300, (shown, reviewer, rows))
    check("…which is well below the Planner's (the Planner's context is not carried over)", shown is not None and planner and shown < max(planner) / 2, (shown, planner))
    t.send(DOWN); t.send(DOWN); t.send(DOWN)
    t.send(ENTER, 1.5)  # Stop workflow
    ok = t.wait("Workflow stopped", 10)
    t.pump(1)
    banner = t.text()
    banner = banner[banner.rfind("✗ Workflow stopped"):]
    check("Stop at the plan confirmation: the stopped banner shows `Cost: no price` and a `Tokens:` line", ok and "Cost: no price" in banner and re.search(r"Tokens: \S+ in\b", banner), banner)
    t.close()


SCENARIOS = {"full": full, "stop": stop, "limit": limit, "abort": abort, "resume": resume, "compaction": compaction, "manual-compact": manual_compact, "usage": usage}
OPT_IN = {"real": real}

if __name__ == "__main__":
    for name in sys.argv[1:] or list(SCENARIOS):
        {**SCENARIOS, **OPT_IN}[name]()
    print(f"\n{sum(results)}/{len(results)} checks passed")
    sys.exit(0 if all(results) else 1)
