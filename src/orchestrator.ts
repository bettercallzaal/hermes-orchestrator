import { classify } from './router.js'
import { gate, defaultPolicy } from './autonomy.js'
import { Learner } from './learner.js'
import { JobQueue } from './queue.js'
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
// within a single process. Operators wanting per-context queues can re-import a
// fresh module or wrap orchestrate() in their own queue.
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
        interventions: [],
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
        interventions: [],
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
        interventions: [],
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

    // 6. Drain the stream. PR1 is monitor-only (no real supervisor yet, no intervention).
    let costUsd = 0
    let summary = ''
    const events: RunEvent[] = []
    for await (const event of opts.runner.stream(handle)) {
      events.push(event)
      await opts.channels?.firehose(event)
      if (event.type === 'cost') costUsd = Math.max(costUsd, event.usd)
      if (event.type === 'complete') {
        summary = event.summary
        if (event.costUsd) costUsd = Math.max(costUsd, event.costUsd)
      }
      if (event.type === 'error') {
        summary = `error: ${event.message}`
      }
    }

    // 7. Record completion
    const status: Outcome['status'] = summary.startsWith('error:') ? 'failed' : 'completed'
    const interventions: Intervention[] = [] // PR1: no real interventions yet (PR3 adds them)
    const outcome: Outcome = {
      taskId: task.id,
      pattern: decision.pattern,
      runner: opts.runner.name,
      status,
      durationMs: Date.now() - startedAt,
      costUsd,
      interventions,
      summary: summary || 'no summary',
      events,
    }

    await recordEvent(status === 'completed' ? 'completed' : 'failed', {
      runner: opts.runner.name,
      pattern: decision.pattern,
      durationMs: outcome.durationMs,
      costUsd: outcome.costUsd,
      summary: outcome.summary,
    })
    await opts.channels?.status(
      `task ${task.id} ${status} via ${decision.pattern}, ${outcome.durationMs}ms, $${costUsd.toFixed(3)}`,
    )

    return outcome
  } finally {
    release()
  }
}
