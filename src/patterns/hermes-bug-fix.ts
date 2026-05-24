import type { PatternAdapter, Task, MemoryHit, RunnerInput } from '../types.js'

const KEYWORDS = [
  'fix',
  'bug',
  'error',
  'broken',
  'type error',
  'failing',
  'crash',
  'typo',
  'lint',
  'compile',
  'doesn\'t work',
]

export const hermesBugFix: PatternAdapter = {
  name: 'hermes-bug-fix',
  defaultRunner: 'hermes',
  costCap: 2.0,

  matches(task: Task): boolean {
    const t = task.text.toLowerCase()
    return KEYWORDS.some((k) => t.includes(k))
  },

  prepare(task: Task, memory: MemoryHit[]): RunnerInput {
    const fewshot =
      memory.length > 0
        ? `\n\nPast similar tasks (most relevant first):\n${memory
            .map((m, i) => `${i + 1}. ${m.body}`)
            .join('\n')}`
        : ''
    return {
      prompt: task.text,
      systemPrompt: `You are a bug-fix agent.

Identify the failure, propose the minimal patch, apply it, and verify (run the obvious test command if there is one). Be terse. Do not introduce unrelated changes. If the failure is unclear, ask one question and stop - do not guess.${fewshot}`,
      allowedTools: ['Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob'],
      maxCostUsd: 2.0,
      metadata: { pattern: 'hermes-bug-fix' },
    }
  },
}
