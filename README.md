# pi-dev-workflow

A plan → build workflow for [pi](https://github.com/earendil-works/pi), started with `/dev`. Four agents hand work to each
other in your current pi session: a **Planner** and a **Plan reviewer** (planning), then a **Developer** and a **Code
reviewer** (development). A reviewer can send work back to the author; you talk to whichever agent is active and confirm the
plan before development starts. The design is in `plans/01-BUSINESS-PLAN.md` and `plans/01-TECHNICAL-PLAN.md`.

## Install

```sh
pi install /Users/krystofrezac/.pi/extensions/dev-workflow
```

or add the path to `packages` in pi's `settings.json`:

```json
{ "packages": ["/Users/krystofrezac/.pi/extensions/dev-workflow"] }
```

The package loads `index.ts` as it is: there is no build step.

## Development

Needs Node 24 or newer and `python3` (for the e2e).

```sh
npm install
npm run check
```

`npm run check` runs every gate in order and stops at the first one that fails:

| Script              | What it does                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck` | `tsc --noEmit`, strict                                                                                            |
| `npm run lint`      | Biome: lint, formatting and import order; any finding, warnings included, fails                                   |
| `npm run test`      | the unit tests (`*.test.ts`) with Node's test runner                                                              |
| `npm run e2e`       | the end-to-end scenarios in `e2e/`: the real extension in pi, in a pseudo-terminal, against a scripted fake model |

To fix what Biome reports, run `npx biome check --write .`: it applies the formatting and the import order. The other
findings are fixed by hand.

### e2e

`npm run e2e` creates the Python venv (`.venv`, with `pyte`) on first use and runs the `pi` pinned in `package.json`
(from `node_modules`). Every scenario runs with its own empty agent directory, so your pi config does not matter. Pass
scenario names to run only some: `npm run e2e -- stop usage`. The scenarios are `full`, `stop`, `limit`, `abort`, `resume`,
`compaction`, `manual-compact` and `usage`; `e2e/drive-tui.py` describes each one.

`real` is not part of `npm run check`: it runs the same flow with a real model, so it costs money, and it needs the
credentials in your own pi agent directory. Run it with `npm run e2e -- real` (the model is `E2E_REAL_MODEL`, default
`github-copilot/claude-haiku-5.5`).

Each scenario keeps its screen dumps, the fake model's request log and the session in `/tmp/dev-e2e/<scenario>/`.
