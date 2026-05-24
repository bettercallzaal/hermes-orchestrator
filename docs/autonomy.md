# Autonomy - the blast-radius gate

Every side-effect-bearing action the orchestrator (or any spawned agent) takes passes through `autonomy.ts` first. It classifies into one of three tiers and either runs, asks the operator, or refuses.

## Tiers

| Tier | Examples | Behaviour |
|------|----------|-----------|
| **AUTO** - low blast-radius | Run a Whisper transcription, create a `ws/` branch, open a PR, write a memory episode, run a sub-process on a sandboxed dir, write to a dev-only channel | Just runs. No prompt. |
| **CONFIRM** - touches users or permanence | Merge to a protected branch, edit a config file users see, change a systemd unit, edit a persona file, modify a hook, write a "decision-locked" memory | Prompts the operator with a one-screen summary + diff + single Y/n. Idle timeout = cancel (default 4 hours). |
| **REFUSE** - irreversible to others | Send a DM/email/cast as the operator, post to a public channel, transact on-chain, publish to a production URL, share a key, force-push to main, delete a repo | Hard stop. The agent asks the operator in the appropriate channel; never auto-fires. |

## Heuristics for classify

The default `autonomy.ts` ships these rules; override by passing your own `AutonomyPolicy`:

| Signal | Tier bump |
|--------|-----------|
| Tool call is `git push origin main` or `gh pr merge` | -> CONFIRM/REFUSE |
| Tool call hits a domain in the `productionUrls` allowlist | -> REFUSE |
| Tool call writes to a path in the `userFacingPaths` allowlist | -> CONFIRM |
| Branch in remote-state is marked protected | -> CONFIRM/REFUSE |
| Commit message / episode body contains "lock", "delete", "publish", "merge", "deploy" | -> bump one tier |
| Tool call sends external messages (email, social, IM as operator) | -> REFUSE |
| Default on unknown action | -> CONFIRM (fail-safe upward) |

## Composing your own policy

```ts
import { defaultPolicy, AutonomyPolicy, Action } from 'hermes-orchestrator'

const policy: AutonomyPolicy = {
  ...defaultPolicy,
  productionUrls: ['app.mybrand.com', 'api.mybrand.com'],
  userFacingPaths: ['config/community.json', 'public/'],
  customRules: [
    (action: Action) => {
      if (action.kind === 'commit' && action.message.includes('hotfix:')) return 'CONFIRM'
      return null
    },
  ],
}

await orchestrate(task, { ..., autonomy: policy })
```

## Why three tiers, not two

Two tiers (AUTO / CONFIRM) collapse all permanence into one bucket. The third tier (REFUSE) exists because some actions are irreversible to third parties: a DM lands in someone's inbox, an on-chain transaction is immutable, a public post is indexed. The cost of getting those wrong is higher than the cost of the operator typing the action themselves.

## Default deny on the unknown

If the classifier cannot reach a verdict (unknown tool call, unrecognised path, missing context), the gate returns `CONFIRM`, NOT `AUTO`. The orchestrator never silently expands its own permission. Operators add new actions to the `AUTO` allowlist explicitly.

## Audit trail

Every gate decision is recorded as a memory episode via the `MemoryAdapter`:

```
gate:<timestamp>:<task-id>:<action-id>
"On <date>, autonomy gate classified action <X> as <TIER>. Reason: <Y>. Result: <ran / confirmed / refused>."
```

This means the gate itself is grist for the learner - patterns of false-positives (legitimate actions that kept hitting CONFIRM) surface in retrieval and inform future rule changes.
