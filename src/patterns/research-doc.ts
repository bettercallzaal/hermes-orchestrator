import type { PatternAdapter, Task, MemoryHit, RunnerInput } from '../types.js'

const KEYWORDS = [
  'research',
  'investigate',
  'audit',
  'look into',
  'find out about',
  'survey',
  'compare',
  'evaluate',
]

const SYSTEM_PROMPT = `You are a research agent. Your job is to produce one durable research doc, not a chat answer.

Workflow:
1. Search the existing research library first (grep over README.md files) to avoid duplicating work and to find related docs.
2. Fetch the actual source - climb the ladder WebFetch -> exa web_fetch -> Playwright -> Wayback. Do not write off a search snippet.
3. Classify every source FULL / PARTIAL / FAILED. Escalate PARTIAL/FAILED through the full ladder before writing.
4. Write the doc with required frontmatter: topic, type, status, last-validated, related-docs, original-query, tier.
5. End with a Next Actions table linking to concrete todos / PRs / calendar items.

Rules:
- Be specific. Include at least 3 numbers (versions, prices, dates, counts).
- No vague language: never use "consider", "it might be worth", "you could explore". State the decision.
- Recommendations FIRST in a Key Decisions table at the top.
- Cite every source URL. Mark each FULL/PARTIAL/FAILED.`

export const researchDoc: PatternAdapter = {
  name: 'research-doc',
  defaultRunner: 'hermes',
  costCap: 5.0,

  matches(task: Task): boolean {
    const t = task.text.toLowerCase()
    return KEYWORDS.some((k) => t.includes(k))
  },

  prepare(task: Task, memory: MemoryHit[]): RunnerInput {
    const fewshot =
      memory.length > 0
        ? `\n\nPast research outputs for similar topics (most relevant first):\n${memory
            .map((m, i) => `${i + 1}. ${m.body}`)
            .join('\n')}`
        : ''
    return {
      prompt: task.text,
      systemPrompt: SYSTEM_PROMPT + fewshot,
      allowedTools: ['WebFetch', 'WebSearch', 'Read', 'Write', 'Edit', 'Grep', 'Glob', 'Bash'],
      maxCostUsd: 5.0,
      metadata: { pattern: 'research-doc' },
    }
  },
}
