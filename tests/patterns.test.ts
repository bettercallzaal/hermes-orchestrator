import { describe, it, expect } from 'vitest'
import { researchDoc } from '../src/patterns/research-doc.js'
import { meetingCapture } from '../src/patterns/meeting-capture.js'
import { hermesBugFix } from '../src/patterns/hermes-bug-fix.js'
import { classify } from '../src/router.js'
import type { Task, MemoryHit } from '../src/types.js'

function task(text: string): Task {
  return { id: 't-1', text, createdAt: new Date().toISOString() }
}

describe('researchDoc pattern', () => {
  it('matches on "research", "investigate", "audit"', () => {
    expect(researchDoc.matches(task('research vector dbs for ZAO'))).toBe(true)
    expect(researchDoc.matches(task('Investigate the Bonfire API limits'))).toBe(true)
    expect(researchDoc.matches(task('audit the agent stack'))).toBe(true)
  })

  it('does NOT match on bug-fix or meeting language', () => {
    expect(researchDoc.matches(task('fix the type error in foo.ts'))).toBe(false)
    expect(researchDoc.matches(task('process this meeting recording'))).toBe(false)
  })

  it('prepare returns a research-shaped RunnerInput with WebFetch allowed', () => {
    const input = researchDoc.prepare(task('research vector dbs'), [])
    expect(input.allowedTools).toContain('WebFetch')
    expect(input.allowedTools).toContain('WebSearch')
    expect(input.systemPrompt).toContain('research agent')
    expect(input.systemPrompt).toContain('Next Actions')
    expect(input.maxCostUsd).toBe(5.0)
    expect(input.metadata?.pattern).toBe('research-doc')
  })

  it('few-shot injects past memory hits into the systemPrompt', () => {
    const past: MemoryHit[] = [
      {
        name: 'research-doc:t-prev',
        body: 'Past task: "research vector dbs", Outcome: doc 200 recommends pgvector',
        sourceTag: 'hermes:research-doc:completed',
      },
    ]
    const input = researchDoc.prepare(task('research vector dbs again'), past)
    expect(input.systemPrompt).toContain('Past research outputs')
    expect(input.systemPrompt).toContain('doc 200 recommends pgvector')
  })
})

describe('meetingCapture pattern', () => {
  it('matches on meeting / transcript / recap keywords', () => {
    expect(meetingCapture.matches(task('process this meeting recording'))).toBe(true)
    expect(meetingCapture.matches(task('Recap that call'))).toBe(true)
    expect(meetingCapture.matches(task('extract action items from the standup'))).toBe(true)
  })

  it('matches on media file extensions', () => {
    expect(meetingCapture.matches(task('/Users/me/Downloads/call.mp4'))).toBe(true)
    expect(meetingCapture.matches(task('process /tmp/voice-memo.m4a'))).toBe(true)
    expect(meetingCapture.matches(task('here is the recording.wav'))).toBe(true)
  })

  it('does NOT match on plain research or bug-fix', () => {
    expect(meetingCapture.matches(task('research vector dbs'))).toBe(false)
    expect(meetingCapture.matches(task('fix the type error in foo.ts'))).toBe(false)
  })

  it('prepare returns a capture-shaped RunnerInput', () => {
    const input = meetingCapture.prepare(task('process the call'), [])
    expect(input.allowedTools).toContain('Bash')
    expect(input.allowedTools).toContain('Write')
    expect(input.systemPrompt).toContain('meeting-capture agent')
    expect(input.systemPrompt).toContain('Decisions')
    expect(input.systemPrompt).toContain('Actions')
    expect(input.maxCostUsd).toBe(3.0)
    expect(input.metadata?.pattern).toBe('meeting-capture')
  })
})

describe('router picks the right pattern when multiple are registered', () => {
  const patterns = [hermesBugFix, researchDoc, meetingCapture]

  it('picks hermes-bug-fix for fix/bug language', async () => {
    const d = await classify(task('fix the type error in src/foo.ts'), { patterns })
    expect(d.pattern).toBe('hermes-bug-fix')
  })

  it('picks research-doc for research language', async () => {
    const d = await classify(task('research the best vector db for our agents'), {
      patterns,
    })
    expect(d.pattern).toBe('research-doc')
  })

  it('picks meeting-capture for media file paths', async () => {
    const d = await classify(task('process /tmp/Arthur-x-Zaal.mp4'), { patterns })
    expect(d.pattern).toBe('meeting-capture')
  })

  it('returns unknown when no pattern matches', async () => {
    const d = await classify(task('write a haiku about ducks'), { patterns })
    expect(d.pattern).toBe('unknown')
  })
})
