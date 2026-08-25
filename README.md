# dsh-synomega

English | [中文](README.zh.md)

[![dsh-plugin](https://img.shields.io/badge/dsh--plugin-DeepSeek%20Harness-4a6cf7)](https://github.com/topics/dsh-plugin)
[![CI](https://github.com/zbc0315/dsh-synomega/actions/workflows/ci.yml/badge.svg)](https://github.com/zbc0315/dsh-synomega/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.19-339933?logo=node.js&logoColor=white)](package.json)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![SynOmega](https://img.shields.io/badge/SynOmega-0.8.0-5b21b6)](https://github.com/zbc0315/synomega)
[![Runs locally](https://img.shields.io/badge/inference-100%25%20local-2e9e5b)](#how-it-works)

**Topics:** `dsh-plugin` · `deepseek-harness` · `retrosynthesis` · `cheminformatics` · `reaction-prediction`

Organic reaction prediction for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness),
backed by [SynOmega](https://github.com/zbc0315/synomega). Five model-facing tools —
retrosynthesis, forward prediction, route planning, synthesizability scoring, and
multi-component evolution — with molecules, reactions, and route trees drawn in the
conversation.

Everything runs locally. There is no API key and no remote inference: the models are
downloaded once and evaluated on your machine.

## Install

```sh
dsh plugin --profile web add github:zbc0315/dsh-synomega
```

`web` is the profile to install into — a profile is one named composition of
plugins under `$DSH_HOME/profiles/`, and `dsh web` boots the one literally named
`web`. Use whichever profile you actually start; naming one that does not exist
creates it.

The built entry points are committed, so a git install needs no build step and no
`allowBuilds` approval. (Once this is on npm, `dsh plugin --profile web add
dsh-synomega` will work the same way.)

Start the harness once afterwards. On first activation the plugin provisions its own
Python environment in the background — a Python 3.12 virtualenv under
`$DSH_HOME/plugins/synomega`, `pip install synomega[gnn]`, then the retrosynthesis
model, the building-block stock, and the forward model (about 450 MB in total, once).
Nothing blocks the harness from booting; a tool called while setup is still running
reports the phase and asks the model to retry rather than failing.

Provisioning takes a cross-process lock, so a harness starting while you are running
the setup script by hand waits for it instead of downloading the same files twice.

**Python 3.10 or newer is required, and a machine's system `python3` is frequently
older.** Install [uv](https://docs.astral.sh/uv/) and the plugin will fetch a suitable
interpreter itself; otherwise point the `python` config at an existing 3.10+ one.

To provision ahead of time instead of on first activation:

```sh
node node_modules/dsh-synomega/scripts/setup.mjs            # with the neural backend
node node_modules/dsh-synomega/scripts/setup.mjs --no-extras --no-assets   # template backend only
```

## Tools

| Tool | Question it answers |
|---|---|
| `synomega_retro` | *What reacts to give X?* — ranked one-step disconnections of a product |
| `synomega_forward` | *What do these reactants give?* — ranked products of a reaction |
| `synomega_plan` | *How do I make X?* — a route down to purchasable building blocks |
| `synomega_score` | *Can X be made, and how hard?* — SynScore, a continuous 0–1 number for ranking |
| `synomega_evolve` | *What can this mixture form?* — a forward network from a reactant pool |

Each returns a structured canonical value (usable directly from Code Mode) plus a
compact text rendering for the model. A prompt section teaches the model which tool
answers which question, that every molecule argument must be a SMILES string, and that
the first call after installation is slow because it downloads models.

**SynScore** is `1/(U+1)^U`, where `U` is the number of starting materials in the best
route that cannot be bought: 1.0 when solved, 0.5 with one missing, 0.11 with two, 0
when no route is found. Use `score` to rank candidates and the separate `solved`
boolean to compare against published solve rates — they answer different questions.

## Visualisation

The browser half registers a view for each tool on the harness's keyed
`tool.call.toolview` slot, so results render as cards inside the conversation:

- **retro / forward** — each candidate drawn as `reactants → product` with its score
- **plan** — the route as a tree, molecules at the nodes and reaction scores on the
  edges, purchasable and unpurchasable starting materials distinguished, selectable
  when several routes were found
- **score** — the SynScore with the route it came from
- **evolve** — molecules laid out by depth, each with its cumulative score

Depictions come from [smiles-drawer](https://github.com/reymond-group/smilesDrawer);
tree layout from [d3-hierarchy](https://github.com/d3/d3-hierarchy). Both are bundled,
so the page fetches nothing. A SMILES that will not parse falls back to its text rather
than an empty box, and a truncated tree says so — a clipped route must never read as a
complete one.

Cards are drawn purely from metadata persisted on the tool result, so reopening an old
conversation reproduces the same picture. Deployments without the browser UI (headless,
CLI) get the text rendering; no information is lost, only the drawing.

## Configuration

All values are set in `cordis.yml`. The ones worth knowing:

| Key | Default | Meaning |
|---|---|---|
| `autoSetup` | `true` | Provision Python on activation |
| `python` | — | Explicit interpreter path; set it and no virtualenv is created |
| `extras` | `['gnn']` | PyPI extras. `[]` installs the template-only backend: no torch, much faster, no neural prediction |
| `mirror` | `'auto'` | Asset mirror (`ustc` / `github`) |
| `algorithm` | `'retrostar'` | Search algorithm (`retrostar` / `mcts` / `bfs`) |
| `plausibility` | `false` | Screen candidates with the plausibility model. Off by default: it does not improve top-k recall and adds latency |
| `search` | width 50, 60 s, 500 expansions | Search budget. Deployment policy, not a model-facing argument |
| `timeouts` | 2 min / 10 min | Per-operation deadlines (single-step / search) |
| `visualize` | `true` | Emit card metadata |
| `maxTreeNodes` | `120` | Node cap for a drawn route tree |

## How it works

```
browser   card renderers on tool.call.toolview  (smiles-drawer, d3-hierarchy)
   ^        drawn from the tool result's persisted metadata
host      one Cordis plugin: five tools + prompt section + provisioning
   ^        ndjson over stdin/stdout
python    one resident worker holding the loaded models
```

The Python worker is resident because loading SynOmega's models takes seconds; paying
that per call would make route planning unusable. Requests are handled one at a time —
inference is not thread-safe, and concurrency would only make each caller slower.

## Known limitations

- **A running prediction cannot be interrupted.** Python inference offers no safe
  cancellation point, so a cancelled call settles immediately and its eventual result is
  discarded. If an abandoned call has not returned within `hardKillMs`, the worker is
  killed and restarted.
- **Predictions are ranked candidates, not guarantees.** Forward top-1 accuracy is about
  0.64 on the benchmark; routes are proposals, not validated procedures.
- **The first call downloads a few hundred megabytes.** In air-gapped, metered, or
  reproducibility-critical environments, pre-fetch with `scripts/setup.mjs` and treat the
  download as an explicit opt-in.
- **Retrosynthesis is dual-use.** The prompt section defers judgment about hazardous,
  controlled, or weaponizable targets to the deployment's own safety policy; this plugin
  does not itself decide what is permissible.

## Licence

MIT.
