// Public types for hermes-orchestrator.
// Adapters implement these interfaces; the framework wires them together.

export interface Task {
  id: string
  text: string
  context?: Record<string, unknown>
  createdAt: string
}

export interface RouterDecision {
  pattern: string
  runner: string
  confidence: number
  reasoning: string
}

export type AutonomyTier = 'AUTO' | 'CONFIRM' | 'REFUSE'

export interface Action {
  kind: string
  target?: string
  description?: string
}

export interface AutonomyDecision {
  tier: AutonomyTier
  reason: string
}

export interface AutonomyPolicy {
  classify(action: Action, context?: Record<string, unknown>): AutonomyDecision
}

export interface RunnerInput {
  prompt: string
  systemPrompt?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  workDir?: string
  maxCostUsd?: number
  metadata?: Record<string, unknown>
}

export interface RunHandle {
  id: string
  runner: string
  startedAt: string
  cancel(): Promise<void>
}

export type RunEvent =
  | { type: 'message'; role: 'assistant' | 'tool'; content: string; tokens?: number }
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'tool_result'; content: string; isError?: boolean }
  | { type: 'cost'; usd: number }
  | { type: 'progress'; description: string }
  | { type: 'complete'; summary: string; tokensUsed?: number; costUsd?: number }
  | { type: 'error'; message: string }

export interface RunnerAdapter {
  name: string
  spawn(input: RunnerInput): Promise<RunHandle>
  stream(handle: RunHandle): AsyncIterable<RunEvent>
  intervene(handle: RunHandle, message: string): Promise<void>
  kill(handle: RunHandle): Promise<void>
}

export interface MemoryHit {
  name: string
  body: string
  sourceTag: string
  referenceTime?: string
  score?: number
}

export interface OrchestratorEvent {
  taskId: string
  kind: 'classified' | 'gated' | 'spawned' | 'intervened' | 'completed' | 'failed'
  payload: Record<string, unknown>
  occurredAt: string
}

export interface MemoryAdapter {
  record(event: OrchestratorEvent): Promise<void>
  retrieve(pattern: string, taskClass: string, limit: number): Promise<MemoryHit[]>
}

export interface PatternAdapter {
  name: string
  matches(task: Task, routerHint?: RouterDecision): boolean
  prepare(task: Task, memory: MemoryHit[]): RunnerInput
  costCap: number
  defaultRunner?: string
}

export interface ChannelAdapter {
  status(line: string): Promise<void>
  firehose(event: RunEvent | OrchestratorEvent): Promise<void>
}

export interface OrchestrateOptions {
  runner: RunnerAdapter
  memory: MemoryAdapter
  channels?: ChannelAdapter
  patterns?: PatternAdapter[]
  autonomy?: AutonomyPolicy
  costCap?: number
  concurrency?: number
  classifier?: (task: Task) => Promise<RouterDecision>
  /**
   * If the runner emits no event for this many ms, the orchestrator treats it
   * as a stuck signal and asks the runner to intervene with a nudge.
   * Default: 60_000. Set to 0 to disable.
   */
  stuckTimeoutMs?: number
  /**
   * Hard cap on supervisor interventions per task. After this many, the next
   * verdict that would intervene escalates to kill instead.
   * Default: 3.
   */
  maxInterventions?: number
}

export interface Intervention {
  step: number
  reason: string
  message: string
  occurredAt: string
}

export interface Outcome {
  taskId: string
  pattern: string
  runner: string
  status: 'completed' | 'failed' | 'aborted' | 'awaiting-confirm'
  durationMs: number
  costUsd: number
  interventions: Intervention[]
  summary: string
  events?: RunEvent[]
}
