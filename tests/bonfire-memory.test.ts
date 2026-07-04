import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BonfireMemory } from '../src/adapters/bonfire-memory.js'
import type { OrchestratorEvent } from '../src/types.js'

describe('BonfireMemory PII & Secret Scanning', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn(async () => ({ ok: true } as Response))
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('should skip episodes containing API keys (secret scan)', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const memory = new BonfireMemory({
      bonfireId: 'test-bonfire',
      apiKey: 'test-key',
    })

    const event: OrchestratorEvent = {
      taskId: 'test-task',
      kind: 'completed',
      payload: {
        pattern: 'test',
        runner: 'hermes',
        durationMs: 1000,
        costUsd: 0.01,
        summary: 'Task completed with secret sk-ant-abc123defghijklmnopqrs exposed',
      },
      occurredAt: new Date().toISOString(),
    }

    await memory.record(event)

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('SKIP episode'),
    )
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('secret pattern'),
    )
    expect(fetchMock).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it('should skip episodes containing non-allowlisted emails (PII scan)', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const memory = new BonfireMemory({
      bonfireId: 'test-bonfire',
      apiKey: 'test-key',
    })

    const event: OrchestratorEvent = {
      taskId: 'test-task',
      kind: 'completed',
      payload: {
        pattern: 'test',
        runner: 'hermes',
        durationMs: 1000,
        costUsd: 0.01,
        summary: 'Contact john.doe@example.com for more info',
      },
      occurredAt: new Date().toISOString(),
    }

    await memory.record(event)

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('SKIP episode'),
    )
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('PII pattern'),
    )
    expect(fetchMock).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it('should allow episodes with allowlisted emails', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const memory = new BonfireMemory({
      bonfireId: 'test-bonfire',
      apiKey: 'test-key',
    })

    const event: OrchestratorEvent = {
      taskId: 'test-task',
      kind: 'completed',
      payload: {
        pattern: 'test',
        runner: 'hermes',
        durationMs: 1000,
        costUsd: 0.01,
        summary: 'Contacted zaal@thezao.com about the update',
      },
      occurredAt: new Date().toISOString(),
    }

    await memory.record(event)

    expect(fetchMock).toHaveBeenCalled()
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('PII pattern'),
    )

    consoleSpy.mockRestore()
  })

  it('should skip episodes containing US phone numbers (PII scan)', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const memory = new BonfireMemory({
      bonfireId: 'test-bonfire',
      apiKey: 'test-key',
    })

    const event: OrchestratorEvent = {
      taskId: 'test-task',
      kind: 'completed',
      payload: {
        pattern: 'test',
        runner: 'hermes',
        durationMs: 1000,
        costUsd: 0.01,
        summary: 'Call me at (555) 123-4567 for details',
      },
      occurredAt: new Date().toISOString(),
    }

    await memory.record(event)

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('SKIP episode'),
    )
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('PII pattern'),
    )
    expect(fetchMock).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it('should skip episodes containing international phone numbers (PII scan)', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const memory = new BonfireMemory({
      bonfireId: 'test-bonfire',
      apiKey: 'test-key',
    })

    const event: OrchestratorEvent = {
      taskId: 'test-task',
      kind: 'completed',
      payload: {
        pattern: 'test',
        runner: 'hermes',
        durationMs: 1000,
        costUsd: 0.01,
        summary: 'Reach out at +44 20 1234 5678',
      },
      occurredAt: new Date().toISOString(),
    }

    await memory.record(event)

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('SKIP episode'),
    )
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('PII pattern'),
    )
    expect(fetchMock).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it('should skip episodes containing non-allowlisted Telegram handles (PII scan)', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const memory = new BonfireMemory({
      bonfireId: 'test-bonfire',
      apiKey: 'test-key',
    })

    const event: OrchestratorEvent = {
      taskId: 'test-task',
      kind: 'completed',
      payload: {
        pattern: 'test',
        runner: 'hermes',
        durationMs: 1000,
        costUsd: 0.01,
        summary: 'Message @john_personal for more information',
      },
      occurredAt: new Date().toISOString(),
    }

    await memory.record(event)

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('SKIP episode'),
    )
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('PII pattern'),
    )
    expect(fetchMock).not.toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it('should allow episodes with allowlisted Telegram handles', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const memory = new BonfireMemory({
      bonfireId: 'test-bonfire',
      apiKey: 'test-key',
    })

    const event: OrchestratorEvent = {
      taskId: 'test-task',
      kind: 'completed',
      payload: {
        pattern: 'test',
        runner: 'hermes',
        durationMs: 1000,
        costUsd: 0.01,
        summary: 'Update sent to @zaoclaw_bot for processing',
      },
      occurredAt: new Date().toISOString(),
    }

    await memory.record(event)

    expect(fetchMock).toHaveBeenCalled()
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('PII pattern'),
    )

    consoleSpy.mockRestore()
  })

  it('should allow clean episodes without secrets or PII', async () => {
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const memory = new BonfireMemory({
      bonfireId: 'test-bonfire',
      apiKey: 'test-key',
    })

    const event: OrchestratorEvent = {
      taskId: 'test-task',
      kind: 'completed',
      payload: {
        pattern: 'test',
        runner: 'hermes',
        durationMs: 1000,
        costUsd: 0.01,
        summary: 'Task completed successfully',
      },
      occurredAt: new Date().toISOString(),
    }

    await memory.record(event)

    expect(fetchMock).toHaveBeenCalled()
    expect(consoleSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('SKIP episode'),
    )

    consoleSpy.mockRestore()
  })
})
