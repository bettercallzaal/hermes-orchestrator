// Public exports for hermes-orchestrator
export { orchestrate, _resetQueue, type SupervisorVerdict } from './orchestrator.js'
export { classify } from './router.js'
export { gate, defaultPolicy } from './autonomy.js'
export { Learner } from './learner.js'
export { JobQueue } from './queue.js'
export { watch, type SupervisorOptions } from './supervisor.js'

// Default adapters - import directly from the adapter path for clarity:
//   import { HermesRunner } from 'hermes-orchestrator/adapters/hermes-runner'
//   import { BonfireMemory } from 'hermes-orchestrator/adapters/bonfire-memory'
//
// Re-exported here for convenience.
export { HermesRunner, type HermesRunnerOptions } from './adapters/hermes-runner.js'
export { BonfireMemory, type BonfireMemoryOptions } from './adapters/bonfire-memory.js'
export { FileMemory, type FileMemoryOptions } from './adapters/file-memory.js'
export { hermesBugFix } from './patterns/hermes-bug-fix.js'

export type {
  Task,
  RouterDecision,
  AutonomyTier,
  AutonomyDecision,
  AutonomyPolicy,
  Action,
  RunnerInput,
  RunHandle,
  RunEvent,
  RunnerAdapter,
  MemoryHit,
  MemoryAdapter,
  OrchestratorEvent,
  PatternAdapter,
  ChannelAdapter,
  OrchestrateOptions,
  Intervention,
  Outcome,
} from './types.js'
