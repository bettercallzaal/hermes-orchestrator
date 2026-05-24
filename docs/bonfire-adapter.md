# Bonfire MemoryAdapter

The default `MemoryAdapter` writes orchestrator events to [Bonfires](https://bonfires.ai) - a knowledge graph built on Neo4j + Graphiti + Weaviate. Each event becomes an atomic graph node; the auto-extraction layer links recurring entities (tasks, patterns, agents, outcomes) into edges.

This doc explains the wire format. The implementation in `src/adapters/bonfire-memory.ts` is ~80 lines.

## Configuration

```ts
import { BonfireMemory } from 'hermes-orchestrator/adapters/bonfire-memory'

const memory = new BonfireMemory({
  bonfireId: process.env.BONFIRE_ID!,     // your Bonfire UUID
  apiKey: process.env.BONFIRE_API_KEY!,   // single bearer token per Bonfire
  apiBase: 'https://tnt-v2.api.bonfires.ai',     // default
  sourceDescription: 'hermes-orchestrator',      // identifies you in the graph
})
```

## What gets recorded

The adapter writes one episode per orchestrator event. Names are deterministic so re-runs update rather than duplicate:

| Event | name pattern | body shape |
|-------|--------------|------------|
| classified | `orch:classify:<task-id>` | "On `<date>`, orchestrator classified task `<task-text-trim>` as pattern `<X>` with confidence `<C>`. Reasoning: `<one-line>`." |
| gated | `orch:gate:<task-id>:<action-id>` | "On `<date>`, autonomy gate classified action `<action>` as `<TIER>`. Reason: `<Y>`. Result: `<ran / confirmed / refused>`." |
| spawned | `orch:spawn:<task-id>:<runner>` | "On `<date>`, orchestrator spawned a `<runner>` agent for task `<task-id>` under pattern `<X>`. Cost cap: $`<N>`. Max interventions: 3." |
| intervention | `orch:intervene:<task-id>:<n>` | "On `<date>`, orchestrator intervened in agent for task `<task-id>` at step `<step>`: `<reason>`. Sent: `<follow-up-text-trim>`." |
| completed | `orch:done:<task-id>` | "On `<date>`, orchestrator marked task `<task-id>` complete via `<pattern>`. Duration: `<X>s`. Cost: $`<N>`. Outcome: `<one-line summary>`." |
| failed | `orch:fail:<task-id>` | "On `<date>`, orchestrator marked task `<task-id>` FAILED via `<pattern>` after `<N>` interventions. Reason: `<error>`. Recovery: `<none\|retry\|escalate>`." |

Each body is self-contained prose - names the date, the task, the pattern, the runner. Auto-extraction handles the rest.

## Security guard

Every body is scanned locally before POST for these patterns; matches block the write:

```
sk-ant-[A-Za-z0-9_-]{20,}                          (Anthropic)
sk-(proj-|cp-)?[A-Za-z0-9_-]{30,}                  (OpenAI)
ghp_[A-Za-z0-9]{36}                                (GitHub PAT)
github_pat_[A-Za-z0-9_]{60,}                       (GitHub fine-grained PAT)
-----BEGIN ([A-Z]+ )?PRIVATE KEY-----              (PEM)
0x[0-9a-fA-F]{64}                                  (Ethereum private key)
[0-9]{9,12}:[A-Za-z0-9_-]{30,}                     (Telegram bot token)
xox[bpaors]-[A-Za-z0-9-]{10,}                      (Slack)
AKIA[0-9A-Z]{16}                                   (AWS access key)
```

Matches are LOGGED locally and SKIPPED (never POSTed). Operator gets a one-line warning. The orchestrator continues; the capture is preserved locally for manual review.

## Best-effort writes

Bonfire writes never abort a larger workflow. Failure modes:

| Symptom | Behaviour |
|---------|-----------|
| `BONFIRE_API_KEY` / `bonfireId` unset | Skip silently. One-line warning. Continue. |
| Network / 5xx | Log FAIL per episode. Continue with the next. |
| Body matched secret regex | SKIP, log, do not POST. Preserve locally. |
| Duplicate `name` | Second POST UPDATES the first. Idempotent re-runs are a feature. |

## Read path (retrieval)

```ts
const hits = await memory.retrieve(
  /* pattern */ 'hermes-bug-fix',
  /* taskClass */ 'typescript-error',
  /* limit */ 5,
)
```

Calls `POST /vector_store/search` with the query. Hits get injected as few-shot context into the next spawn.

**Caveat**: Bonfires returns `[]` until an admin runs labeling on the index. Until that fires, retrieval is a no-op and the orchestrator falls back to base prompt. No code change needed when labeling unlocks - the `hits.length > 0` branch starts firing automatically.

## Plug in a different KG

The `MemoryAdapter` interface is small (`record` + `retrieve`). Implementations exist or are easy to write for:

- **Letta** - memory blocks as the persistence layer
- **ChromaDB** - local vector DB
- **Mem0** - hosted memory-as-a-service
- **Local file** - JSONL append, for single-user dev

The `BonfireMemory` adapter is one of many. Pick the one that fits your knowledge-graph philosophy.

## Why Bonfires as the default

- **Multi-agent shared graph** - several agents (this orchestrator, a Telegram concierge, a meeting capture bot) can all write to ONE Bonfire and read each other's facts. Useful when the agents share an operator or a team.
- **Self-extracting** - bodies are natural-language prose; Bonfires turns them into entities + edges without a schema you have to maintain.
- **Genesis-tier pricing** - not metered per call, so the cost story is predictable for high-throughput agents.

See the [Bonfires technical overview](https://publish.obsidian.md/bonfires/files/Technical/Bonfires) for the deeper stack.
