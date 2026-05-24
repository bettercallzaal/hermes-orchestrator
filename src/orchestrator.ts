import { classify } from './router.js'
import { gate, defaultPolicy } from './autonomy.js'
import { Learner } from './learner.js'
import { JobQueue } from './queue.js'
import { watch, type SupervisorVerdict } from './supervisor.js'
import type {
  OrchestrateOptions,
  Outcome,
  Task,
  Intervention,
  RunEvent,
  OrchestratorEvent,
} from './types.js'

function makeTaskId(): string {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function toTask(input: string | Task): Task {
  if (typeof input !== 'string') return input
  return {
    id: makeTaskId(),
    text: input,
    createdAt: new Date().toISOString(),
  }
}

// Module-level queue so the concurrency cap is shared across orchestrate() calls
// within a single process.
let sharedQueue: JobQueue | undefined
let sharedQueueLimit: number | undefined

function getQueue(concurrency: number): JobQueue {
  if (!sharedQueue || sharedQueueLimit !== concurrency) {
    sharedQueue = new JobQueue(concurrency)
    sharedQueueLimit = concurrency
  }
  return sharedQueue
}

/** Reset the shared queue. Test-only. */
export function _resetQueue(): void {
  sharedQueue = undefined
  sharedQueueLimit = undefined
}

const DEFAULT_STUCK_TIMEOUT_MS = 60_000
const DEFAULT_MAX_INTERVENTIONS = 3

export async function orchestrate(
  input: string | Task,
  opts: OrchestrateOptions,
): Promise<Outcome> {
  const task = toTask(input)
  const learner = new Learner(opts.memory)
  const queue = getQueue(opts.concurrency ?? 1)
  const release = await queue.acquire()
  const startedAt = Date.now()
  const interventions: Intervention[] = []
  const stuckTimeoutMs = opts.stuckTimeoutMs ?? DEFAULT_STUCK_TIMEOUT_MS
  const maxInterventions = opts.maxInterventions ?? DEFAULT_MAX_INTERVENTIONS

  const recordEvent = async (
    kind: OrchestratorEvent['kind'],
    payload: Record<string, unknown>,
  ): Promise<void> => {
    await learner.record({
      taskId: task.id,
      kind,
      payload,
      occurredAt: new Date().toISOString(),
    })
  }

  try {
    // 1. Classify
    const decision = await classify(task, {
      patterns: opts.patterns ?? [],
      classifier: opts.classifier ? (t) => opts.classifier!(t) : undefined,
    })
    await recordEvent('classified', {
      pattern: decision.pattern,
      runner: decision.runner,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      taskText: task.text,
    })
    await opts.channels?.status(
      `task ${task.id} classified as ${decision.pattern} (conf ${decision.confidence.toFixed(2)})`,
    )

    if (decision.pattern === 'unknown') {
      await recordEvent('failed', { reason: 'unknown-pattern', task: task.text })
      return {
        taskId: task.id,
        pattern: 'unknown',
        runner: decision.runner,
        status: 'awaiting-confirm',
        durationMs: Date.now() - startedAt,
        costUsd: 0,
        interventions,
        summary: `No pattern matched. Operator needs to classify: "${task.text.slice(0, 120)}".`,
      }
    }

    // 2. Find the registered PatternAdapter
    const pattern = (opts.patterns ?? []).find((p) => p.name === decision.pattern)
    if (!pattern) {
      throw new Error(`Pattern '${decision.pattern}' not registered with orchestrator`)
    }

    // 3. Gate the spawn through the autonomy policy
    const policy = opts.autonomy ?? defaultPolicy
    const spawnDecision = gate(
      {
        kind: 'llm:invoke',
        target: opts.runner.name,
        description: `spawn ${decision.pattern}`,
      },
      policy,
    )
    await recordEvent('gated', {
      action: 'spawn',
      tier: spawnDecision.tier,
      reason: spawnDecision.reason,
    })

    if (spawnDecision.tier === 'REFUSE') {
      await recordEvent('failed', { reason: 'gate-refused', detail: spawnDecision.reason })
      return {
        taskId: task.id,
        pattern: decision.pattern,
        runner: opts.runner.name,
        status: 'aborted',
        durationMs: Date.now() - startedAt,
        costUsd: 0,
        interventions,
        summary: `Autonomy gate REFUSED spawn: ${spawnDecision.reason}`,
      }
    }
    if (spawnDecision.tier === 'CONFIRM') {
      return {
        taskId: task.id,
        pattern: decision.pattern,
        runner: opts.runner.name,
        status: 'awaiting-confirm',
        durationMs: Date.now() - startedAt,
        costUsd: 0,
        interventions,
        summary: `Autonomy gate requires operator CONFIRM: ${spawnDecision.reason}`,
      }
    }

    // 4. Retrieve past memory (no-op until Bonfire labeling unlocks)
    const past = await learner.retrieve(decision.pattern, decision.pattern, 5)

    // 5. Prepare + spawn
    const runnerInput = pattern.prepare(task, past)
    runnerInput.maxCostUsd = runnerInput.maxCostUsd ?? opts.costCap ?? pattern.costCap
    const handle = await opts.runner.spawn(runnerInput)
    await recordEvent('spawned', {
      runner: opts.runner.name,
      runId: handle.id,
      pattern: decision.pattern,
      costCap: runnerInput.maxCostUsd,
    })
    await opts.channels?.status(`task ${task.id} spawned via ${opts.runner.name}`)

    // 6. Drain the supervised stream with stuck-timeout race + real intervention.
    // PR3 changes vs PR2:
    //   - iterator races against a stuck-timeout (Promise.race)
    //   - intervene verdicts call runner.intervene() for real (acted=true)
    //   - maxInterventions cap escalates the (N+1)th intervene-or-stuck to a kill
    let costUsd = 0
    let summary = ''
    let killed = false
    let killReason: string | undefined
    const events: RunEvent[] = []
    const supervised = watch(opts.runner.stream(handle), {
      costCapUsd: runnerInput.maxCostUsd,
      allowedTools: runnerInput.allowedTools,
    })
    const iter = supervised[Symbol.asyncIterator]()

    const recordIntervention = async (
      reason: string,
      message: string,
      acted: boolean,
    ): Promise<number> => {
      const step = interventions.length + 1
      interventions.push({
        step,
        reason,
        message,
        occurredAt: new Date().toISOString(),
      })
      await recordEvent('intervened', { step, reason, message, acted })
      await opts.channels?.status(
        `task ${task.id} intervention #${step}: ${reason}`,
      )
      return step
    }

    while (true) {
      type Step =
        | { kind: 'event'; value: { event: RunEvent; verdict: SupervisorVerdict } }
        | { kind: 'done' }
        | { kind: 'stuck' }

      const next: Step = await (async (): Promise<Step> => {
        if (stuckTimeoutMs <= 0) {
          const r = await iter.next()
          return r.done ? { kind: 'done' } : { kind: 'event', value: r.value }
        }
        return new Promise<Step>((resolve) => {
          let settled = false
          const timer = setTimeout(() => {
            if (!settled) {
              settled = true
              resolve({ kind: 'stuck' })
            }
          }, stuckTimeoutMs)
          iter.next().then(
            (r) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              resolve(r.done ? { kind: 'done' } : { kind: 'event', value: r.value })
            },
            (err: unknown) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              const msg = err instanceof Error ? err.message : String(err)
              resolve({
                kind: 'event',
                value: {
                  event: { type: 'error', message: msg },
                  verdict: { kind: 'continue' },
                },
              })
            },
          )
        })
      })()

      if (next.kind === 'done') break

      if (next.kind === 'stuck') {
        if (interventions.length >= maxInterventions) {
          killed = true
          killReason = `stuck timeout (${stuckTimeoutMs}ms) and max interventions (${maxInterventions}) reached`
          await recordIntervention(killReason, 'kill', true)
          await opts.runner.kill(handle).catch(() => {
            /* best-effort */
          })
          break
        }
        const stuckMsg = `Supervisor: no events for ${stuckTimeoutMs}ms. Are you stuck? Summarise the step you are on and what you have tried.`
        await recordIntervention('stuck-timeout', stuckMsg, true)
        await opts.runner.intervene(handle, stuckMsg).catch((err: unknown) => {
          console.warn(
            `[orchestrator] runner.intervene threw: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
        continue
      }

      const { event, verdict } = next.value
      events.push(event)
      await opts.channels?.firehose(event)
      if (event.type === 'cost') costUsd = Math.max(costUsd, event.usd)
      if (event.type === 'complete') {
        summary = event.summary
        if (event.costUsd) costUsd = Math.max(costUsd, event.costUsd)
      }
      if (event.type === 'error') summary = `error: ${event.message}`

      if (verdict.kind === 'intervene') {
        if (interventions.length >= maxInterventions) {
          // Escalate to kill - we've already nudged enough.
          killed = true
          killReason = `max interventions (${maxInterventions}) reached after: ${verdict.reason}`
          await recordIntervention(killReason, 'kill', true)
          await opts.runner.kill(handle).catch(() => {
            /* best-effort */
          })
          break
        }
        await recordIntervention(verdict.reason, verdict.suggestedMessage, true)
        await opts.runner.intervene(handle, verdict.suggestedMessage).catch((err: unknown) => {
          console.warn(
            `[orchestrator] runner.intervene threw: ${err instanceof Error ? err.message : String(err)}`,
          )
        })
      } else if (verdict.kind === 'kill') {
        killed = true
        killReason = verdict.reason
        await recordIntervention(verdict.reason, 'kill', true)
        await opts.runner.kill(handle).catch(() => {
          /* best-effort */
        })
        break
      }
    }

    // 7. Record completion
    const status: Outcome['status'] = killed
      ? 'aborted'
      : summary.startsWith('error:')
        ? 'failed'
        : 'completed'
    const outcome: Outcome = {
      taskId: task.id,
      pattern: decision.pattern,
      runner: opts.runner.name,
      status,
      durationMs: Date.now() - startedAt,
      costUsd,
      interventions,
      summary: killed ? `killed by supervisor: ${killReason}` : summary || 'no summary',
      events,
    }

    await recordEvent(status === 'completed' ? 'completed' : 'failed', {
      runner: opts.runner.name,
      pattern: decision.pattern,
      durationMs: outcome.durationMs,
      costUsd: outcome.costUsd,
      summary: outcome.summary,
      interventions: interventions.length,
    })
    await opts.channels?.status(
      `task ${task.id} ${status} via ${decision.pattern}, ${outcome.durationMs}ms, $${costUsd.toFixed(3)}, interventions=${interventions.length}`,
    )

    return outcome
  } finally {
    release()
  }
}

export type { SupervisorVerdict }
