import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FileMemory } from '../src/adapters/file-memory.js'
import type { OrchestratorEvent } from '../src/types.js'

async function makeTmpFile(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-mem-'))
  const path = join(dir, 'memory.jsonl')
  return {
    path,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

function event(over: Partial<OrchestratorEvent>): OrchestratorEvent {
  return {
    taskId: 't-1',
    kind: 'classified',
    payload: {},
    occurredAt: new Date().toISOString(),
    ...over,
  }
}

describe('FileMemory', () => {
  let path: string
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const tmp = await makeTmpFile()
    path = tmp.path
    cleanup = tmp.cleanup
  })

  it('returns [] when the file does not exist', async () => {
    const mem = new FileMemory({ path: `${path}.nonexistent` })
    const hits = await mem.retrieve('hermes-bug-fix', 'hermes-bug-fix', 5)
    expect(hits).toEqual([])
    await cleanup()
  })

  it('records events as JSONL lines', async () => {
    const mem = new FileMemory({ path })
    await mem.record(event({ taskId: 't-a', kind: 'classified' }))
    await mem.record(event({ taskId: 't-a', kind: 'completed' }))

    const lines = (await readFile(path, 'utf8')).split('\n').filter(Boolean)
    expect(lines.length).toBe(2)
    expect(JSON.parse(lines[0]).kind).toBe('classified')
    expect(JSON.parse(lines[1]).kind).toBe('completed')
    await cleanup()
  })

  it('retrieves recency-sorted hits for completed tasks of the given pattern', async () => {
    const mem = new FileMemory({ path })
    // Task 1 - hermes-bug-fix, completed
    await mem.record(
      event({
        taskId: 't-1',
        kind: 'classified',
        occurredAt: '2026-05-01T10:00:00.000Z',
        payload: { pattern: 'hermes-bug-fix', taskText: 'fix the type error in foo.ts' },
      }),
    )
    await mem.record(
      event({
        taskId: 't-1',
        kind: 'completed',
        occurredAt: '2026-05-01T10:05:00.000Z',
        payload: {
          pattern: 'hermes-bug-fix',
          summary: 'changed foo.ts:42 from string to number',
          costUsd: 0.12,
          interventions: 0,
        },
      }),
    )
    // Task 2 - hermes-bug-fix, completed (newer)
    await mem.record(
      event({
        taskId: 't-2',
        kind: 'classified',
        occurredAt: '2026-05-02T10:00:00.000Z',
        payload: { pattern: 'hermes-bug-fix', taskText: 'fix the broken test in bar.test.ts' },
      }),
    )
    await mem.record(
      event({
        taskId: 't-2',
        kind: 'completed',
        occurredAt: '2026-05-02T10:08:00.000Z',
        payload: {
          pattern: 'hermes-bug-fix',
          summary: 'added missing await on async call',
          costUsd: 0.18,
          interventions: 1,
        },
      }),
    )
    // Task 3 - different pattern, completed
    await mem.record(
      event({
        taskId: 't-3',
        kind: 'classified',
        payload: { pattern: 'research-doc', taskText: 'research vector dbs' },
      }),
    )
    await mem.record(
      event({ taskId: 't-3', kind: 'completed', payload: { pattern: 'research-doc', summary: 'wrote doc 200' } }),
    )
    // Task 4 - hermes-bug-fix, never completed (still running or aborted)
    await mem.record(
      event({
        taskId: 't-4',
        kind: 'classified',
        payload: { pattern: 'hermes-bug-fix', taskText: 'fix the segfault' },
      }),
    )

    const hits = await mem.retrieve('hermes-bug-fix', 'hermes-bug-fix', 5)
    expect(hits.length).toBe(2)
    // Newest first
    expect(hits[0].name).toBe('hermes-bug-fix:t-2')
    expect(hits[0].body).toContain('fix the broken test')
    expect(hits[0].body).toContain('added missing await')
    expect(hits[1].name).toBe('hermes-bug-fix:t-1')
    expect(hits[1].body).toContain('fix the type error')
    // Wrong-pattern task excluded
    expect(hits.find((h) => h.name.startsWith('research-doc'))).toBeUndefined()
    // Incomplete task excluded
    expect(hits.find((h) => h.name === 'hermes-bug-fix:t-4')).toBeUndefined()
    await cleanup()
  })

  it('respects the limit parameter', async () => {
    const mem = new FileMemory({ path })
    for (let i = 0; i < 5; i++) {
      await mem.record(
        event({
          taskId: `t-${i}`,
          kind: 'classified',
          occurredAt: `2026-05-0${i + 1}T10:00:00.000Z`,
          payload: { pattern: 'hermes-bug-fix', taskText: `task ${i}` },
        }),
      )
      await mem.record(
        event({
          taskId: `t-${i}`,
          kind: 'completed',
          occurredAt: `2026-05-0${i + 1}T10:05:00.000Z`,
          payload: { pattern: 'hermes-bug-fix', summary: `outcome ${i}` },
        }),
      )
    }
    const hits = await mem.retrieve('hermes-bug-fix', 'hermes-bug-fix', 2)
    expect(hits.length).toBe(2)
    await cleanup()
  })

  it('skips malformed JSONL lines rather than throwing', async () => {
    const mem = new FileMemory({ path })
    await mem.record(
      event({
        taskId: 't-good',
        kind: 'classified',
        payload: { pattern: 'hermes-bug-fix', taskText: 'good' },
      }),
    )
    // Append a malformed line directly
    const { appendFile } = await import('node:fs/promises')
    await appendFile(path, 'not valid json\n', 'utf8')
    await mem.record(
      event({
        taskId: 't-good',
        kind: 'completed',
        payload: { pattern: 'hermes-bug-fix', summary: 'fine' },
      }),
    )
    const hits = await mem.retrieve('hermes-bug-fix', 'hermes-bug-fix', 5)
    expect(hits.length).toBe(1)
    expect(hits[0].body).toContain('fine')
    await cleanup()
  })
})
