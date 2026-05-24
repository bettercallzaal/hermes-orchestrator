import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { orchestrate, _resetQueue } from '../src/orchestrator.js'
import { FileMemory } from '../src/adapters/file-memory.js'
import { hermesBugFix } from '../src/patterns/hermes-bug-fix.js'
import type {
  RunnerAdapter,
  RunHandle,
  RunnerInput,
  RunEvent,
} from '../src/types.js'

/**
 * Capturing runner: records the RunnerInput it was spawned with so the test
 * can assert the second invocation saw few-shot text from the first.
 */
function capturingRunner(events: RunEvent[]): RunnerAdapter & {
  capturedInputs: RunnerInput[]
} {
  const capturedInputs: RunnerInput[] = []
  return {
    name: 'capturing',
    capturedInputs,
    async spawn(input: RunnerInput): Promise<RunHandle> {
      capturedInputs.push(input)
      return {
        id: `cap-${Math.random().toString(36).slice(2, 8)}`,
        runner: 'capturing',
        startedAt: new Date().toISOString(),
        cancel: async () => {},
      }
    },
    async *stream(_handle: RunHandle) {
      for (const e of events) {
        await new Promise<void>((r) => setTimeout(r, 1))
        yield e
      }
    },
    async intervene() {},
    async kill() {},
  } as RunnerAdapter & { capturedInputs: RunnerInput[] }
}

describe('learning loop (FileMemory + hermes-bug-fix few-shot)', () => {
  let path: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    _resetQueue()
    const dir = await mkdtemp(join(tmpdir(), 'hermes-loop-'))
    path = join(dir, 'memory.jsonl')
    cleanup = () => rm(dir, { recursive: true, force: true })
  })

  it('second run sees a few-shot block built from the first run', async () => {
    const memory = new FileMemory({ path })

    // Run 1 - completes cleanly, will become a memory hit for run 2.
    const runner1 = capturingRunner([
      { type: 'message', role: 'assistant', content: 'looking at foo.ts' },
      { type: 'tool_use', name: 'Read', input: { path: 'src/foo.ts' } },
      {
        type: 'complete',
        summary: 'changed foo.ts:42 from string to number, ran the type check, clean',
        costUsd: 0.12,
      },
    ])
    const outcome1 = await orchestrate('fix the type error in src/foo.ts', {
      runner: runner1,
      memory,
      patterns: [hermesBugFix],
      stuckTimeoutMs: 0,
    })
    expect(outcome1.status).toBe('completed')
    // First run cannot see anything past - systemPrompt has no few-shot block.
    expect(runner1.capturedInputs[0].systemPrompt).not.toContain('Past similar tasks')

    // Run 2 - different task, same pattern. Should few-shot inject run 1's outcome.
    const runner2 = capturingRunner([
      { type: 'complete', summary: 'fixed', costUsd: 0.05 },
    ])
    const outcome2 = await orchestrate('fix the type error in src/bar.ts', {
      runner: runner2,
      memory,
      patterns: [hermesBugFix],
      stuckTimeoutMs: 0,
    })
    expect(outcome2.status).toBe('completed')

    const sys = runner2.capturedInputs[0].systemPrompt ?? ''
    expect(sys).toContain('Past similar tasks')
    expect(sys).toContain('fix the type error in src/foo.ts')
    expect(sys).toContain('changed foo.ts:42')

    await cleanup()
  })

  it('memory file accumulates across runs and is queryable directly', async () => {
    const memory = new FileMemory({ path })
    const runner = capturingRunner([{ type: 'complete', summary: 'done', costUsd: 0.01 }])

    await orchestrate('fix the bug in src/a.ts', {
      runner,
      memory,
      patterns: [hermesBugFix],
      stuckTimeoutMs: 0,
    })
    await orchestrate('fix the bug in src/b.ts', {
      runner,
      memory,
      patterns: [hermesBugFix],
      stuckTimeoutMs: 0,
    })

    const hits = await memory.retrieve('hermes-bug-fix', 'hermes-bug-fix', 5)
    expect(hits.length).toBe(2)
    // Most recent first
    expect(hits[0].body).toContain('src/b.ts')
    expect(hits[1].body).toContain('src/a.ts')

    await cleanup()
  })
})
