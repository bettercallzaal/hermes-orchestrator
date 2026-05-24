/**
 * Minimal end-to-end example.
 * Run: `npx tsx examples/basic.ts` after `npm install` (in your own project).
 *
 * Pre-reqs:
 *   - `claude` CLI on PATH (Claude Code Max plan: `claude /login` once)
 *   - BONFIRE_ID + BONFIRE_API_KEY in env (if you want graph writes)
 */
import { orchestrate, hermesBugFix } from 'hermes-orchestrator'
import { HermesRunner } from 'hermes-orchestrator/adapters/hermes-runner'
import { BonfireMemory } from 'hermes-orchestrator/adapters/bonfire-memory'

async function main(): Promise<void> {
  const memory = process.env.BONFIRE_API_KEY
    ? new BonfireMemory({
        bonfireId: process.env.BONFIRE_ID!,
        apiKey: process.env.BONFIRE_API_KEY!,
      })
    : // Fallback: in-memory no-op when no Bonfire creds (good for local dev)
      {
        async record() {},
        async retrieve() {
          return []
        },
      }

  const outcome = await orchestrate(
    'fix the type error in src/foo.ts (this is a demo - replace with a real task)',
    {
      runner: new HermesRunner({ workDir: process.cwd() }),
      memory,
      patterns: [hermesBugFix],
      costCap: 2.0,
    },
  )

  console.log(JSON.stringify(outcome, null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
