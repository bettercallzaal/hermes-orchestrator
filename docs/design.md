# Design

The orchestrator is six small components glued together. Every component is replaceable through an adapter or a function injection - the framework itself is the wiring.

## Why this exists

Most "agent" frameworks today either (a) hide the spawning behind opaque tooling or (b) ship a giant orchestration runtime you must adopt whole-hog. This framework picks a third path: a tiny supervisor loop with explicit seams.

The loop:

```
                                    +-> AUTO -> run
   task -> router (classify) -> autonomy -> CONFIRM -> ask -> run
                                    +-> REFUSE -> stop
                                                    |
                                                    v
                                                pattern (recipe)
                                                    |
                                                    v
                                                runner (spawn)
                                                    |
                                       +--- stream events ---+
                                       |                     |
                                       v                     v
                                 supervisor               channels
                                 (watch)                  (status + firehose)
                                       |
                                       v (on stuck / looped / off-track)
                                     guide (intervene)
                                       |
                                       v
                                  ...continues...
                                       |
                                       v
                                    outcome -> learner.record()
                                                  |
                                                  v
                                          MemoryAdapter (Bonfire by default)
```

## Components

### router

A classifier. Input: task text + context. Output: `{ pattern: string, runner: string, confidence: number, reasoning: string }`.

Default implementation: a single Hermes invocation with a 1-shot classifier prompt + the registered pattern enum. Anthropic Haiku-class model. Cost target: < $0.01 per task.

The router does not commit - it returns a `RouterDecision` that the orchestrator then sends through `autonomy` before any side effect.

### autonomy

The blast-radius gate. Input: a proposed action. Output: one of `AUTO`, `CONFIRM`, `REFUSE`. See [autonomy.md](./autonomy.md).

If the gate returns `CONFIRM`, the orchestrator asks the operator and waits (default 4-hour timeout). `REFUSE` is a hard stop.

### pattern

A recipe for a class of tasks. Implements `PatternAdapter`:

```ts
interface PatternAdapter {
  name: string                                                 // e.g. "hermes-bug-fix"
  matches(task: Task): boolean
  prepare(task: Task, memory: MemoryHit[]): RunnerInput        // composes the prompt + tool restrictions
  costCap: number                                              // USD per task
  interventionRules: InterventionRule[]                        // when supervisor should call guide
}
```

The framework ships three default patterns: `hermes-bug-fix`, `research-doc`, `meeting-capture`. Add your own by implementing `PatternAdapter`.

### runner

Implements `RunnerAdapter`:

```ts
interface RunnerAdapter {
  name: string
  spawn(input: RunnerInput): Promise<RunHandle>
  stream(handle: RunHandle): AsyncIterable<RunEvent>
  intervene(handle: RunHandle, message: string): Promise<void>
  kill(handle: RunHandle): Promise<void>
}
```

The default `HermesRunner` wraps the Anthropic `claude` CLI as a subprocess with `--output-format stream-json` so the supervisor can read turn-by-turn.

### supervisor

Watches the stream from the runner. Per event, evaluates:

- Is the agent making progress? (output length growing, tool calls happening)
- Stuck? (no new event in 60s, same tool call 3x in a row)
- Looped? (same output text 3+ times)
- Off-track? (tool calls do not match the classified pattern)
- Cost-cap fired? (running cost > pattern's `costCap`)

On any flag -> dispatch to `guide.maybe_intervene()`. Otherwise continue watching.

### guide

Sends a follow-up to the running subprocess via `RunnerAdapter.intervene()`. Templates per intervention type live in `src/guide-templates/`. Max 3 interventions per task before escalating to the operator.

### learner

Two operations:

- `retrieve(pattern, taskClass, limit)` - at spawn time, pulls past similar-task outcomes from the MemoryAdapter. Injects them as few-shot context into the runner prompt.
- `record(event)` - at every meaningful step (classified / spawned / intervened / completed / failed), writes a memory episode.

### channels

`ChannelAdapter` exposes two surfaces:

- `status(line)` - a one-line ping per significant event. Goes to the "low noise" surface (a team channel).
- `firehose(event)` - every event. Goes to the "high detail" surface (an operator DM, with snooze support).

The default `TelegramChannel` example wires status to a group chat and firehose to a DM.

## Public API (sketch)

```ts
// hermes-orchestrator/index.ts
export interface OrchestrateOptions {
  runner: RunnerAdapter
  memory: MemoryAdapter
  channels?: ChannelAdapter
  patterns?: PatternAdapter[]                                  // overrides defaults
  costCap?: number                                             // global default per task
  concurrency?: number                                         // max concurrent tasks (default 1)
}

export async function orchestrate(
  task: string | Task,
  options: OrchestrateOptions,
): Promise<Outcome>

export interface Outcome {
  taskId: string
  pattern: string
  status: 'completed' | 'failed' | 'aborted' | 'awaiting-confirm'
  durationMs: number
  costUsd: number
  interventions: Intervention[]
  summary: string
}
```

## What this is NOT

- **Not a runtime.** No daemon, no server. You call `orchestrate()` from your own process.
- **Not a UI.** Channels exist so you can surface progress; the framework does not own a UI.
- **Not opinionated about memory shape.** The MemoryAdapter is a strict interface; the default Bonfires implementation is one of N possibilities (Letta, ChromaDB, Mem0, your own).
- **Not coupled to Anthropic.** The default runner uses Claude CLI, but anything that can spawn / stream / intervene / kill can be a `RunnerAdapter`. OpenAI subprocess, local Ollama, even a remote HTTP service.

## See also

- [autonomy.md](./autonomy.md) - the blast-radius gate
- [bonfire-adapter.md](./bonfire-adapter.md) - how the default MemoryAdapter writes to Bonfires
