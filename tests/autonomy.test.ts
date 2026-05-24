import { describe, it, expect } from 'vitest'
import { gate, defaultPolicy } from '../src/autonomy.js'

describe('autonomy.gate / defaultPolicy', () => {
  it('AUTO for git:commit + git:branch + memory:record', () => {
    expect(gate({ kind: 'git:commit' }).tier).toBe('AUTO')
    expect(gate({ kind: 'git:branch:create' }).tier).toBe('AUTO')
    expect(gate({ kind: 'memory:record' }).tier).toBe('AUTO')
    expect(gate({ kind: 'llm:invoke' }).tier).toBe('AUTO')
  })

  it('REFUSE for forbidden prefixes', () => {
    expect(gate({ kind: 'social:post' }).tier).toBe('REFUSE')
    expect(gate({ kind: 'farcaster:cast' }).tier).toBe('REFUSE')
    expect(gate({ kind: 'onchain:tx:send' }).tier).toBe('REFUSE')
    expect(gate({ kind: 'force_push' }).tier).toBe('REFUSE')
    expect(gate({ kind: 'email:send' }).tier).toBe('REFUSE')
  })

  it('CONFIRM for confirm prefixes', () => {
    expect(gate({ kind: 'git:merge' }).tier).toBe('CONFIRM')
    expect(gate({ kind: 'git:push:main' }).tier).toBe('CONFIRM')
    expect(gate({ kind: 'config:edit' }).tier).toBe('CONFIRM')
    expect(gate({ kind: 'systemd:restart' }).tier).toBe('CONFIRM')
  })

  it('CONFIRM bump when description contains escalation keywords', () => {
    expect(
      gate({ kind: 'fs:write:src', description: 'delete the user table' }).tier,
    ).toBe('CONFIRM')
    expect(gate({ kind: 'fs:write:src', description: 'publish to main' }).tier).toBe(
      'CONFIRM',
    )
  })

  it('CONFIRM fallback for unknown action kinds (fail-safe upward)', () => {
    expect(gate({ kind: 'something:novel' }).tier).toBe('CONFIRM')
  })

  it('respects a custom policy override', () => {
    const policy = {
      classify: () => ({ tier: 'AUTO' as const, reason: 'allow all (testing)' }),
    }
    expect(gate({ kind: 'force_push' }, policy).tier).toBe('AUTO')
  })

  it('exports defaultPolicy', () => {
    expect(defaultPolicy.classify).toBeDefined()
  })
})
