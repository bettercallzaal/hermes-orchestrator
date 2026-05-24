import { describe, it, expect } from 'vitest'
import { classify } from '../src/router.js'
import { hermesBugFix } from '../src/patterns/hermes-bug-fix.js'

describe('router.classify', () => {
  it('routes bug-fix tasks to hermes-bug-fix pattern via the default heuristic', async () => {
    const task = {
      id: 't1',
      text: 'fix the type error in src/foo.ts',
      createdAt: new Date().toISOString(),
    }
    const decision = await classify(task, { patterns: [hermesBugFix] })
    expect(decision.pattern).toBe('hermes-bug-fix')
    expect(decision.runner).toBe('hermes')
    expect(decision.confidence).toBeGreaterThan(0)
  })

  it('returns unknown for non-matching tasks', async () => {
    const task = {
      id: 't2',
      text: 'write a haiku about ducks',
      createdAt: new Date().toISOString(),
    }
    const decision = await classify(task, { patterns: [hermesBugFix] })
    expect(decision.pattern).toBe('unknown')
    expect(decision.confidence).toBe(0)
  })

  it('uses a custom classifier when provided', async () => {
    const task = {
      id: 't3',
      text: 'literally anything',
      createdAt: new Date().toISOString(),
    }
    const decision = await classify(task, {
      patterns: [hermesBugFix],
      classifier: async () => ({
        pattern: 'custom',
        runner: 'custom-runner',
        confidence: 0.95,
        reasoning: 'override',
      }),
    })
    expect(decision.pattern).toBe('custom')
    expect(decision.runner).toBe('custom-runner')
    expect(decision.confidence).toBe(0.95)
  })
})
