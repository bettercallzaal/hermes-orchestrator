# hermes-orchestrator

A supervisor framework for AI agents. Classify a task, spawn the right agent, watch the streaming output, intervene mid-run, persist outcomes to a knowledge graph, get better at agent-building over time.

> **Status: pre-alpha.** This commit is the design + license + intent. First working code (`v0.1.0`) lands in PR1. Watch the history.

## The problem

Spawning an AI agent per task is easy. The hard part:

- Knowing **which TYPE of agent** fits the task (a coder? a researcher? a writer?)
- **Watching** it without blocking on the whole reply
- **Stepping in** when it loops, stalls, or veers off-task
- **Capping its cost** before it burns money
- **Remembering** what worked last time, using that next time
- Doing all this **without becoming the single point of failure** for whatever system hosts it

That is what this framework is. Six small components, adapter-based so you plug in your own runner / memory / channels / patterns.

## The shape

```
task -> [router] -> [autonomy gate] -> [pattern] -> [runner] -> [supervisor watching] -> [guide intervenes] -> [outcome] -> [learner records]
                                                                                                                                  ^
                                                                                                                                  |
                                                                                                          next similar task pulls from here
```

**Components:**

| Component | Job |
|-----------|-----|
| `router` | classify the task, pick a pattern + a runner |
| `autonomy` | blast-radius gate (AUTO / CONFIRM / REFUSE) before any side effect |
| `supervisor` | watch streaming output, detect stuck / looped / off-track |
| `guide` | send mid-run follow-up to the running subprocess |
| `learner` | retrieve past outcomes at spawn time + record new ones at the end |
| `channels` | dual surface - lightweight status pings + detailed firehose |

**Adapters (pluggable):**

| Adapter | What it is |
|---------|-----------|
| `RunnerAdapter` | how to spawn / stream / intervene / kill an agent. Hermes (Claude CLI subprocess) ships as the default. |
| `MemoryAdapter` | how to record + retrieve outcomes. Bonfires KG ships as the default. |
| `PatternAdapter` | the recipe for a task class. Ships with `hermes-bug-fix`, `research-doc`, `meeting-capture`. |
| `ChannelAdapter` | where to surface status + firehose. Telegram dual-surface ships as an example. |

## Why "Hermes"?

Hermes was the messenger god. The framework spawns subprocess agents that go run a task and report back - the orchestrator is the conductor, the spawned subprocess is the messenger.

The default `RunnerAdapter` wraps Anthropic's `claude` CLI as a subprocess (the "Hermes pattern" originally built in ZAO's bot code). That is where the name comes from. Swap in any other runner via the adapter interface.

## Quick start (when v0.1.0 ships)

```ts
import { orchestrate } from 'hermes-orchestrator'
import { HermesRunner } from 'hermes-orchestrator/adapters/hermes-runner'
import { BonfireMemory } from 'hermes-orchestrator/adapters/bonfire-memory'

const outcome = await orchestrate('fix the type error in src/foo.ts', {
  runner: new HermesRunner({ workDir: process.cwd() }),
  memory: new BonfireMemory({
    bonfireId: process.env.BONFIRE_ID!,
    apiKey: process.env.BONFIRE_API_KEY!,
  }),
  patterns: ['hermes-bug-fix'],
  costCap: 2.0, // USD per task
})

console.log(outcome.summary)
```

## Roadmap (PR by PR)

Each PR is a teachable step. Full plan in [`docs/design.md`](./docs/design.md); the short version:

| PR | What ships | Why this step matters |
|----|-----------|----------------------|
| PR0 (this commit) | README + LICENSE + design docs | Plant the public flag; lock the intent |
| PR1 | Scaffold + adapter interfaces + `HermesRunner` + `BonfireMemory` + router + autonomy + first pattern + tests + CI | End-to-end "task in, outcome out" loop against real Hermes |
| PR2 | `supervisor.ts` + stream-json parsing + stuck/looped/off-track detection | The "watching" begins |
| PR3 | `guide.ts` - actually intervene mid-run | The "mid-run nudging" works |
| PR4 | `learner` retrieve - inject past outcomes as few-shot at spawn time | The "gets better" loop closes |
| PR5 | More patterns (`research-doc`, `meeting-capture`) | Generalises beyond bug-fix |
| PR6 | `channels` - Telegram dual-surface example | Operator surface |

## Reading

- [`docs/design.md`](./docs/design.md) - architecture, components, adapter contracts
- [`docs/autonomy.md`](./docs/autonomy.md) - the blast-radius gate explained
- [`docs/bonfire-adapter.md`](./docs/bonfire-adapter.md) - using Bonfires as the memory layer

## Built by

The ZAO ([thezao.com](https://thezao.com)) - a decentralised impact network. Originally extracted from internal ZAOOS code; cleaned up for general use.

Companion: [Bonfires](https://bonfires.ai) - the knowledge-graph layer this framework writes to by default. Bonfires-the-product is separate from this framework; the `BonfireMemory` adapter is one of many possible memory backends.

## License

MIT - see [LICENSE](./LICENSE).

## Build in public

Every commit here lands as a learning moment. Watching the repo, you will see:

- Why each design choice was made (PR descriptions)
- What was rejected and why
- Where the design pivoted (and the doc that captured the pivot)
- The actual code evolving toward something usable

If you are building an agent that builds agents, follow along.
