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

    // 4. Retrieve past memory (no-op until Bonfire labeling unlocks, but interface is live)
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

    // 6. Drain the supervised stream.
    // PR2: supervisor verdicts are LOGGED (intervened with acted=false) but not acted on.
    // PR3: will call opts.runner.intervene() with the suggestedMessage when verdict.kind === 'intervene'.
    let costUsd = 0
    let summary = ''
    let killed = false
    let killReason: string | undefined
    const events: RunEvent[] = []
    const supervised = watch(opts.runner.stream(handle), {
      costCapUsd: runnerInput.maxCostUsd,
      allowedTools: runnerInput.allowedTools,
    })

    for await (const { event, verdict } of supervised) {
      events.push(event)
      await opts.channels?.firehose(event)
      if (event.type === 'cost') costUsd = Math.max(costUsd, event.usd)
      if (event.type === 'complete') {
        summary = event.summary
        if (event.costUsd) costUsd = Math.max(costUsd, event.costUsd)
      }
      if (event.type === 'error') summary = `error: ${event.message}`

      if (verdict.kind === 'intervene') {
        const step = interventions.length + 1
        const intervention: Intervention = {
          step,
          reason: verdict.reason,
          message: verdict.suggestedMessage,
          occurredAt: new Date().toISOString(),
        }
        interventions.push(intervention)
        await recordEvent('intervened', {
          step,
          reason: verdict.reason,
          message: verdict.suggestedMessage,
          acted: false, // PR2 limit: log only. PR3 will set true and actually intervene.
        })
        await opts.channels?.status(
          `task ${task.id} supervisor verdict #${step}: ${verdict.reason}`,
        )
      } else if (verdict.kind === 'kill') {
        killed = true
        killReason = verdict.reason
        const step = interventions.length + 1
        interventions.push({
          step,
          reason: verdict.reason,
          message: 'kill',
          occurredAt: new Date().toISOString(),
        })
        await recordEvent('intervened', {
          step,
          reason: verdict.reason,
          message: 'kill',
          acted: true,
        })
        await opts.runner.kill(handle).catch(() => {
          /* best-effort */
        })
        await opts.channels?.status(`task ${task.id} KILLED by supervisor: ${verdict.reason}`)
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
