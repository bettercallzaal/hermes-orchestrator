import type { Task, RouterDecision, PatternAdapter } from './types.js'

export interface RouterOptions {
  patterns: PatternAdapter[]
  classifier?: (task: Task, patterns: PatternAdapter[]) => Promise<RouterDecision>
}

// Default classifier: heuristic-only. Walks each pattern's matches() until one returns true.
// Production setups should provide an LLM-backed classifier via options.classifier
// (e.g. a one-shot prompt to Claude Haiku that returns the chosen pattern name + confidence).
const defaultClassifier = async (
  task: Task,
  patterns: PatternAdapter[],
): Promise<RouterDecision> => {
  for (const pattern of patterns) {
    if (pattern.matches(task)) {
      return {
        pattern: pattern.name,
        runner: pattern.defaultRunner ?? 'hermes',
        confidence: 0.6,
        reasoning: `Heuristic match: pattern '${pattern.name}' returned true for task.`,
      }
    }
  }
  return {
    pattern: 'unknown',
    runner: 'hermes',
    confidence: 0,
    reasoning: 'No pattern matched. Escalate to operator.',
  }
}

export async function classify(task: Task, opts: RouterOptions): Promise<RouterDecision> {
  const cls = opts.classifier ?? defaultClassifier
  return cls(task, opts.patterns)
}
