import { spawn as spawnProcess, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { RunnerAdapter, RunnerInput, RunHandle, RunEvent } from '../types.js'

export interface HermesRunnerOptions {
  /** Path to the claude CLI binary. Default: 'claude' (assumed on PATH). */
  claudeBin?: string
  /** Working directory for the spawned process. Default: process.cwd(). */
  workDir?: string
  /** Additional args appended after the standard ones. */
  extraArgs?: string[]
  /** Env vars to merge over process.env for the subprocess. */
  env?: NodeJS.ProcessEnv
}

interface ActiveRun {
  proc: ChildProcess
  startedAt: string
  output: string[]
  closed: boolean
}

/**
 * Default RunnerAdapter. Wraps the Anthropic `claude` CLI as a subprocess
 * with --output-format stream-json so the supervisor can read turn-by-turn.
 *
 * Auth via Claude Code Max plan OAuth (`claude /login` once) - no API key
 * needed in env, no per-call billing.
 */
export class HermesRunner implements RunnerAdapter {
  readonly name = 'hermes'
  private readonly runs = new Map<string, ActiveRun>()

  constructor(private readonly opts: HermesRunnerOptions = {}) {}

  async spawn(input: RunnerInput): Promise<RunHandle> {
    const id = `hermes-${randomUUID().slice(0, 8)}`
    const args: string[] = [
      '--print',
      '--output-format',
      'stream-json',
      '--verbose',
    ]
    if (input.systemPrompt) {
      args.push('--append-system-prompt', input.systemPrompt)
    }
    if (input.allowedTools && input.allowedTools.length > 0) {
      args.push('--allowedTools', input.allowedTools.join(','))
    }
    if (input.disallowedTools && input.disallowedTools.length > 0) {
      args.push('--disallowedTools', input.disallowedTools.join(','))
    }
    if (this.opts.extraArgs && this.opts.extraArgs.length > 0) {
      args.push(...this.opts.extraArgs)
    }
    args.push(input.prompt)

    const proc = spawnProcess(this.opts.claudeBin ?? 'claude', args, {
      cwd: input.workDir ?? this.opts.workDir ?? process.cwd(),
      env: { ...process.env, ...this.opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const startedAt = new Date().toISOString()
    const run: ActiveRun = { proc, startedAt, output: [], closed: false }
    this.runs.set(id, run)

    proc.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      run.output.push(chunk)
    })
    proc.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      run.output.push(chunk)
    })
    proc.on('close', () => {
      run.closed = true
    })
    proc.on('error', (err) => {
      run.output.push(JSON.stringify({ type: 'error', message: err.message }) + '\n')
      run.closed = true
    })

    return {
      id,
      runner: this.name,
      startedAt,
      cancel: async () => {
        if (!run.closed) {
          run.proc.kill('SIGTERM')
        }
      },
    }
  }

  async *stream(handle: RunHandle): AsyncIterable<RunEvent> {
    const run = this.runs.get(handle.id)
    if (!run) {
      yield { type: 'error', message: `Unknown run id: ${handle.id}` }
      return
    }

    let buffer = ''
    const drainBuffered = (): RunEvent[] => {
      const events: RunEvent[] = []
      while (run.output.length > 0) {
        const next = run.output.shift()
        if (next !== undefined) buffer += next
      }
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        const evt = parseClaudeStreamLine(line)
        if (evt) events.push(evt)
      }
      return events
    }

    while (!run.closed) {
      for (const evt of drainBuffered()) yield evt
      await new Promise<void>((r) => setTimeout(r, 100))
    }
    for (const evt of drainBuffered()) yield evt
    if (buffer.trim()) {
      const evt = parseClaudeStreamLine(buffer)
      if (evt) yield evt
    }
    if (run.proc.exitCode !== 0 && run.proc.exitCode !== null) {
      yield { type: 'error', message: `claude exited with code ${run.proc.exitCode}` }
    }
    yield { type: 'complete', summary: '' } // sentinel; orchestrator uses the prior complete summary
  }

  async intervene(_handle: RunHandle, message: string): Promise<void> {
    // PR1 limitation: claude --print does not accept mid-run stdin for interventions.
    // PR3 will add this when we switch to a session-based runner (claude --session).
    console.warn(
      `[hermes-runner] intervene() called but not supported in --print mode. PR3 adds session support. Message: ${message.slice(0, 80)}`,
    )
  }

  async kill(handle: RunHandle): Promise<void> {
    const run = this.runs.get(handle.id)
    if (!run || run.closed) return
    run.proc.kill('SIGTERM')
    setTimeout(() => {
      if (!run.closed) run.proc.kill('SIGKILL')
    }, 5000)
  }
}

/**
 * Parses one line of claude --output-format stream-json into an orchestrator RunEvent.
 * Returns null for lines we don't surface (e.g. the init system line).
 */
function parseClaudeStreamLine(line: string): RunEvent | null {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
  const type = obj.type as string | undefined

  if (type === 'system') return null

  if (type === 'assistant' && obj.message) {
    const message = obj.message as {
      content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }>
    }
    const contents = message.content ?? []
    const toolUses = contents.filter((c) => c.type === 'tool_use')
    if (toolUses.length > 0) {
      const tu = toolUses[0]
      return { type: 'tool_use', name: tu.name ?? 'unknown', input: tu.input ?? {} }
    }
    const text = contents
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    if (text) return { type: 'message', role: 'assistant', content: text }
    return null
  }

  if (type === 'user' && obj.message) {
    const message = obj.message as {
      content?: Array<{ type?: string; content?: string; is_error?: boolean }>
    }
    const toolResults = (message.content ?? []).filter((c) => c.type === 'tool_result')
    if (toolResults.length > 0) {
      const tr = toolResults[0]
      return {
        type: 'tool_result',
        content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content ?? ''),
        isError: tr.is_error ?? false,
      }
    }
    return null
  }

  if (type === 'result') {
    const usage = obj.usage as
      | { total_cost_usd?: number; input_tokens?: number; output_tokens?: number }
      | undefined
    const text = (obj.result as string | undefined) ?? ''
    return {
      type: 'complete',
      summary: text,
      tokensUsed: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
      costUsd: usage?.total_cost_usd ?? 0,
    }
  }

  if (type === 'error') {
    return { type: 'error', message: String(obj.message ?? 'unknown error') }
  }

  return null
}
