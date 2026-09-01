import { describe, it, expect, vi, beforeEach } from 'vitest'
import { orchestrate, _resetQueue } from '../src/orchestrator.js'
import { hermesBugFix } from '../src/patterns/hermes-bug-fix.js'
import type {
  RunnerAdapter,
  MemoryAdapter,
  RunHandle,
  RunnerInput,
  RunEvent,
  MemoryHit,
  OrchestratorEvent,
  ChannelAdapter,
} from '../src/types.js'

function fakeRunner(
  events: RunEvent[],
  hooks?: {
    intervene?: (handle: RunHandle, message: string) => Promise<void>
    kill?: (handle: RunHandle) => Promise<void>
  },
): RunnerAdapter {
  return {
    name: 'fake',
    async spawn(_input: RunnerInput): Promise<RunHandle> {
      const id = `fake-${Math.random().toString(36).slice(2, 8)}`
      return {
        id,
        runner: 'fake',
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
    async intervene(handle: RunHandle, message: string) {
      if (hooks?.intervene) await hooks.intervene(handle, message)
    },
    async kill(handle: RunHandle) {
      if (hooks?.kill) await hooks.kill(handle)
    },
  }
}

function fakeMemory(): MemoryAdapter & { recorded: OrchestratorEvent[] } {
  const recorded: OrchestratorEvent[] = []
  return {
    recorded,
    async record(event: OrchestratorEvent) {
      recorded.push(event)
    },
    async retrieve(_p: string, _t: string, _l: number): Promise<MemoryHit[]> {
      return []
    },
  }
}

function fakeChannels(): ChannelAdapter & {
  status: ReturnType<typeof vi.fn>
  firehose: ReturnType<typeof vi.fn>
} {
  const status = vi.fn(async (_l: string) => {})
  const firehose = vi.fn(async () => {})
  return { status, firehose } as ChannelAdapter & {
    status: ReturnType<typeof vi.fn>
    firehose: ReturnType<typeof vi.fn>
  }
}

describe('orchestrate (end to end with fake adapters)', () => {
  beforeEach(() => {
    _resetQueue()
  })

  it('classifies, gates, spawns, drains the stream, records 4 events on success', async () => {
    const runner = fakeRunner([
      { type: 'message', role: 'assistant', content: 'looking at the code...' },
      { type: 'tool_use', name: 'Read', input: { path: 'src/foo.ts' } },
      { type: 'complete', summary: 'fixed the type error', costUsd: 0.12 },
    ])
    const memory = fakeMemory()
    const channels = fakeChannels()

    const outcome = await orchestrate('fix the type error in src/foo.ts', {
      runner,
      memory,
      channels,
      patterns: [hermesBugFix],
    })

    expect(outcome.status).toBe('completed')
    expect(outcome.pattern).toBe('hermes-bug-fix')
    expect(outcome.runner).toBe('fake')
    expect(outcome.costUsd).toBeCloseTo(0.12)
    expect(outcome.summary).toContain('fixed the type error')

    const kinds = memory.recorded.map((e) => e.kind)
    expect(kinds).toContain('classified')
    expect(kinds).toContain('gated')
    expect(kinds).toContain('spawned')
    expect(kinds).toContain('completed')

    expect(channels.status).toHaveBeenCalled()
    expect(channels.firehose).toHaveBeenCalled()
  })

  it('returns awaiting-confirm with no spawn when pattern is unknown', async () => {
    const runner = fakeRunner([])
    const memory = fakeMemory()

    const outcome = await orchestrate('write a haiku about ducks', {
      runner,
      memory,
      patterns: [hermesBugFix],
    })

    expect(outcome.status).toBe('awaiting-confirm')
    expect(outcome.pattern).toBe('unknown')
    expect(outcome.summary).toContain('No pattern matched')

    const kinds = memory.recorded.map((e) => e.kind)
    expect(kinds).toContain('classified')
    expect(kinds).toContain('failed')
    expect(kinds).not.toContain('spawned')
  })

  it('records failed event when stream emits an error', async () => {
    const runner = fakeRunner([
      { type: 'message', role: 'assistant', content: 'trying...' },
      { type: 'error', message: 'subprocess crashed' },
    ])
    const memory = fakeMemory()

    const outcome = await orchestrate('fix the broken test', {
      runner,
      memory,
      patterns: [hermesBugFix],
    })

    expect(outcome.status).toBe('failed')
    expect(outcome.summary).toContain('subprocess crashed')

    const kinds = memory.recorded.map((e) => e.kind)
    expect(kinds).toContain('failed')
  })

  it('honours a custom autonomy policy that REFUSES the spawn', async () => {
    const runner = fakeRunner([])
    const memory = fakeMemory()

    const outcome = await orchestrate('fix the type error', {
      runner,
      memory,
      patterns: [hermesBugFix],
      autonomy: {
        classify: () => ({ tier: 'REFUSE', reason: 'test policy refuses everything' }),
      },
    })

    expect(outcome.status).toBe('aborted')
    expect(outcome.summary).toContain('REFUSED')

    const kinds = memory.recorded.map((e) => e.kind)
    expect(kinds).toContain('gated')
    expect(kinds).not.toContain('spawned')
  })

  it('honours a custom autonomy policy that CONFIRMs the spawn (awaits without spawning)', async () => {
    const runner = fakeRunner([])
    const memory = fakeMemory()

    const outcome = await orchestrate('fix the type error', {
      runner,
      memory,
      patterns: [hermesBugFix],
      autonomy: {
        classify: () => ({ tier: 'CONFIRM', reason: 'test policy requires confirm' }),
      },
    })

    expect(outcome.status).toBe('awaiting-confirm')
    expect(outcome.summary).toContain('CONFIRM')

    const kinds = memory.recorded.map((e) => e.kind)
    expect(kinds).toContain('gated')
    expect(kinds).not.toContain('spawned')
  })

  it('PR3: calls runner.intervene on loop-detected verdict with acted=true', async () => {
    const msg = 'I am stuck on this'
    const interveneFn = vi.fn(async () => {})
    const runner = fakeRunner(
      [
        { type: 'message', role: 'assistant', content: msg },
        { type: 'message', role: 'assistant', content: msg },
        { type: 'message', role: 'assistant', content: msg },
        { type: 'complete', summary: 'eventually done', costUsd: 0.05 },
      ],
      { intervene: interveneFn },
    )
    const memory = fakeMemory()

    const outcome = await orchestrate('fix the bug in src/foo.ts', {
      runner,
      memory,
      patterns: [hermesBugFix],
      stuckTimeoutMs: 0, // disable stuck-timeout race for this test
    })

    expect(interveneFn).toHaveBeenCalledTimes(1)
    expect(interveneFn.mock.calls[0][1]).toMatch(/Supervisor:/)
    expect(outcome.interventions.length).toBe(1)
    expect(outcome.interventions[0].reason).toMatch(/loop detected/)

    const intervenedEvent = memory.recorded.find((e) => e.kind === 'intervened')
    expect(intervenedEvent).toBeDefined()
    expect(intervenedEvent?.payload.acted).toBe(true)
  })

  it('PR3: stuck-timeout fires when the stream goes quiet (orchestrator-level race)', async () => {
    const interveneFn = vi.fn(async () => {})
    // Runner that yields nothing and never finishes within the test window.
    const runner: RunnerAdapter = {
      name: 'silent',
      async spawn(_input: RunnerInput): Promise<RunHandle> {
        return {
          id: 'silent-1',
          runner: 'silent',
          startedAt: new Date().toISOString(),
          cancel: async () => {},
        }
      },
      async *stream(_handle: RunHandle) {
        // Block until killed - never yields. The stuck-timeout should fire.
        await new Promise<void>(() => {})
      },
      async intervene(h, m) {
        await interveneFn(h, m)
      },
      async kill() {},
    }
    const memory = fakeMemory()

    const outcome = await orchestrate('fix the bug in src/foo.ts', {
      runner,
      memory,
      patterns: [hermesBugFix],
      stuckTimeoutMs: 20,
      maxInterventions: 2,
    })

    // After 2 stuck-timeouts the next one escalates to kill.
    expect(interveneFn).toHaveBeenCalledTimes(2)
    expect(outcome.status).toBe('aborted')
    expect(outcome.summary).toMatch(/killed by supervisor/)
    expect(outcome.interventions.length).toBe(3)
    expect(outcome.interventions.at(-1)?.message).toBe('kill')
  })

  it('PR3: maxInterventions cap escalates a verdict-driven intervene to kill', async () => {
    const interveneFn = vi.fn(async () => {})
    const killFn = vi.fn(async () => {})
    // Three loops in a row, each crossing the threshold (buffer resets after each fire).
    const dup = 'same answer'
    const runner = fakeRunner(
      [
        { type: 'message', role: 'assistant', content: dup },
        { type: 'message', role: 'assistant', content: dup },
        { type: 'message', role: 'assistant', content: dup },
        { type: 'message', role: 'assistant', content: dup },
        { type: 'message', role: 'assistant', content: dup },
        { type: 'message', role: 'assistant', content: dup },
      ],
      { intervene: interveneFn, kill: killFn },
    )
    const memory = fakeMemory()

    const outcome = await orchestrate('fix the bug in src/foo.ts', {
      runner,
      memory,
      patterns: [hermesBugFix],
      stuckTimeoutMs: 0,
      maxInterventions: 1, // first verdict allowed, second escalates to kill
    })

    expect(interveneFn).toHaveBeenCalledTimes(1)
    expect(killFn).toHaveBeenCalled()
    expect(outcome.status).toBe('aborted')
    expect(outcome.interventions.at(-1)?.message).toBe('kill')
  })
})
