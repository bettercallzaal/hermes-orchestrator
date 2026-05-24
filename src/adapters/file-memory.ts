import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import type { MemoryAdapter, OrchestratorEvent, MemoryHit } from '../types.js'

export interface FileMemoryOptions {
  /**
   * Path to the JSONL file storing all OrchestratorEvents.
   * Default: `$HOME/.hermes-orchestrator/memory.jsonl`.
   */
  path?: string
}

/**
 * Local file-backed MemoryAdapter. One JSONL line per OrchestratorEvent.
 *
 * Retrieval joins `classified` + `completed` events by taskId, filters to the
 * requested pattern, and returns recency-sorted MemoryHits. No embeddings, no
 * network - just append + read. Perfect for self-hosted setups and for testing
 * the learning loop end-to-end without depending on Bonfire admin labeling.
 *
 * The MemoryAdapter interface is the contract; FileMemory is the obvious
 * default. BonfireMemory remains available for the knowledge-graph case.
 */
export class FileMemory implements MemoryAdapter {
  constructor(private readonly opts: FileMemoryOptions = {}) {}

  private get path(): string {
    return this.opts.path ?? `${homedir()}/.hermes-orchestrator/memory.jsonl`
  }

  async record(event: OrchestratorEvent): Promise<void> {
    await fs.mkdir(dirname(this.path), { recursive: true })
    await fs.appendFile(this.path, JSON.stringify(event) + '\n', 'utf8')
  }

  async retrieve(pattern: string, _taskClass: string, limit: number): Promise<MemoryHit[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.path, 'utf8')
    } catch (err: unknown) {
      // File does not exist yet (first run) - that's not an error, just no hits.
      if (isMissingFileError(err)) return []
      throw err
    }

    const events: OrchestratorEvent[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line) as OrchestratorEvent)
      } catch {
        // Skip malformed lines rather than abort the whole retrieve.
      }
    }

    const byTask = new Map<string, OrchestratorEvent[]>()
    for (const e of events) {
      const list = byTask.get(e.taskId)
      if (list) list.push(e)
      else byTask.set(e.taskId, [e])
    }

    interface TaskOutcome {
      taskId: string
      taskText: string
      summary: string
      costUsd: number
      completedAt: string
      interventions: number
    }

    const completed: TaskOutcome[] = []
    for (const [taskId, evts] of byTask) {
      const classified = evts.find((e) => e.kind === 'classified')
      const finished = evts.find((e) => e.kind === 'completed')
      if (!classified || !finished) continue
      if (classified.payload.pattern !== pattern) continue
      completed.push({
        taskId,
        taskText: String(classified.payload.taskText ?? ''),
        summary: String(finished.payload.summary ?? ''),
        costUsd: Number(finished.payload.costUsd ?? 0),
        completedAt: finished.occurredAt,
        interventions: Number(finished.payload.interventions ?? 0),
      })
    }

    // Recency-first.
    completed.sort((a, b) => b.completedAt.localeCompare(a.completedAt))

    return completed.slice(0, limit).map((t) => ({
      name: `${pattern}:${t.taskId}`,
      body: `Past task: "${t.taskText}"\nOutcome: ${t.summary}\nCost: $${t.costUsd.toFixed(3)}  Interventions: ${t.interventions}`,
      sourceTag: `hermes:${pattern}:completed`,
      referenceTime: t.completedAt,
      score: 1,
    }))
  }
}

function isMissingFileError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return code === 'ENOENT'
}
