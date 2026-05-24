import { describe, it, expect } from 'vitest'
import { watch } from '../src/supervisor.js'
import type { RunEvent } from '../src/types.js'

async function collect(
  events: RunEvent[],
  opts: Parameters<typeof watch>[1],
): Promise<Array<{ event: RunEvent; verdict: Awaited<ReturnType<typeof firstVerdict>> }>> {
  const out: Array<{ event: RunEvent; verdict: Awaited<ReturnType<typeof firstVerdict>> }> = []
  for await (const item of watch((async function* () {
    for (const e of events) yield e
  })(), opts)) {
    out.push(item as { event: RunEvent; verdict: Awaited<ReturnType<typeof firstVerdict>> })
  }
  return out
}

async function firstVerdict(events: RunEvent[], opts: Parameters<typeof watch>[1]) {
  for await (const { verdict } of watch((async function* () {
    for (const e of events) yield e
  })(), opts)) {
    return verdict
  }
  return null
}

describe('supervisor.watch', () => {
  it('continues by default when no rules trip', async () => {
    const out = await collect(
      [
        { type: 'message', role: 'assistant', content: 'looking at the code' },
        { type: 'tool_use', name: 'Read', input: { path: 'foo' } },
        { type: 'complete', summary: 'done', costUsd: 0.1 },
      ],
      { allowedTools: ['Read', 'Bash'], costCapUsd: 2.0 },
    )
    expect(out.every((o) => o.verdict.kind === 'continue')).toBe(true)
  })

  it('flags off-track when tool_use is outside allowedTools', async () => {
    const out = await collect(
      [
        { type: 'message', role: 'assistant', content: 'I will reach for a banned tool' },
        { type: 'tool_use', name: 'WebFetch', input: { url: 'https://evil' } },
      ],
      { allowedTools: ['Read', 'Bash'] },
    )
    const verdict = out.find((o) => o.event.type === 'tool_use')?.verdict
    expect(verdict?.kind).toBe('intervene')
    if (verdict?.kind === 'intervene') {
      expect(verdict.reason).toMatch(/off-track/)
      expect(verdict.suggestedMessage).toMatch(/WebFetch/)
    }
  })

  it('does NOT flag off-track when allowedTools is empty (allow all)', async () => {
    const out = await collect(
      [{ type: 'tool_use', name: 'WebFetch', input: {} }],
      { allowedTools: [] },
    )
    expect(out[0].verdict.kind).toBe('continue')
  })

  it('detects a loop when N identical assistant messages arrive in a row', async () => {
    const msg = 'same thing'
    const out = await collect(
      [
        { type: 'message', role: 'assistant', content: msg },
        { type: 'message', role: 'assistant', content: msg },
        { type: 'message', role: 'assistant', content: msg },
      ],
      { loopThreshold: 3 },
    )
    expect(out[0].verdict.kind).toBe('continue')
    expect(out[1].verdict.kind).toBe('continue')
    expect(out[2].verdict.kind).toBe('intervene')
    if (out[2].verdict.kind === 'intervene') {
      expect(out[2].verdict.reason).toMatch(/loop detected/)
    }
  })

  it('does NOT flag a loop when messages differ', async () => {
    const out = await collect(
      [
        { type: 'message', role: 'assistant', content: 'one' },
        { type: 'message', role: 'assistant', content: 'two' },
        { type: 'message', role: 'assistant', content: 'three' },
      ],
      { loopThreshold: 3 },
    )
    expect(out.every((o) => o.verdict.kind === 'continue')).toBe(true)
  })

  it('returns kill when cost exceeds costCapUsd', async () => {
    const out = await collect(
      [
        { type: 'cost', usd: 0.5 },
        { type: 'cost', usd: 2.5 },
      ],
      { costCapUsd: 2.0 },
    )
    expect(out[0].verdict.kind).toBe('continue')
    expect(out[1].verdict.kind).toBe('kill')
    if (out[1].verdict.kind === 'kill') {
      expect(out[1].verdict.reason).toMatch(/cost cap/)
    }
  })

  it('cost-cap fires on complete event with costUsd too', async () => {
    const verdict = await firstVerdict(
      [{ type: 'complete', summary: 'done', costUsd: 3.0 }],
      { costCapUsd: 2.0 },
    )
    expect(verdict?.kind).toBe('kill')
  })

  it('supervisor is a no-op with no options', async () => {
    const out = await collect(
      [
        { type: 'tool_use', name: 'WebFetch', input: {} },
        { type: 'message', role: 'assistant', content: 'a' },
        { type: 'cost', usd: 100 },
      ],
      {},
    )
    expect(out.every((o) => o.verdict.kind === 'continue')).toBe(true)
  })
})
