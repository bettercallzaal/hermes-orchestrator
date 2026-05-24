import type { MemoryAdapter, MemoryHit, OrchestratorEvent } from './types.js'

// Wraps the MemoryAdapter with best-effort error handling.
// Bonfire failures, network errors, etc never throw to the orchestrator.
export class Learner {
  constructor(private readonly memory: MemoryAdapter) {}

  async record(event: OrchestratorEvent): Promise<void> {
    try {
      await this.memory.record(event)
    } catch (err) {
      console.warn(
        `[learner] record failed for ${event.kind}/${event.taskId}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async retrieve(pattern: string, taskClass: string, limit = 5): Promise<MemoryHit[]> {
    try {
      return await this.memory.retrieve(pattern, taskClass, limit)
    } catch (err) {
      console.warn(
        `[learner] retrieve failed for ${pattern}/${taskClass}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return []
    }
  }
}
