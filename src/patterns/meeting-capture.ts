import type { PatternAdapter, Task, MemoryHit, RunnerInput } from '../types.js'

const KEYWORDS = [
  'meeting',
  'transcribe',
  'transcript',
  'recap',
  'process this call',
  'process the call',
  'extract todos',
  'extract action items',
  'voice memo',
  'recording',
  'standup',
]

const FILE_EXTENSIONS = ['.mp4', '.m4a', '.mov', '.mp3', '.wav', '.opus', '.flac']

const SYSTEM_PROMPT = `You are a meeting-capture agent. Turn one recording or transcript into one durable recap.

Workflow:
1. Acquire the transcript: if a media file, transcribe it (local mlx-whisper preferred). If a paste, use it directly.
2. Run multi-pass extraction (NOT a single monolithic prompt):
   A. Metadata: date, duration, title, attendees, platform.
   B. Decisions: explicit + verbatim-anchored. Carry a confidence (high/medium/low).
   C. Actions: concrete follow-ups with one owner each. Confidence + due if stated.
   D. Quotes: 3-8 load-bearing verbatim quotes.
   E. Research seeds + memory updates. Cross-check existing entities BEFORE adding.
3. Produce: a recap doc with the schema below, plus a separate transcript file.

Rules:
- Verbatim where possible. No paraphrasing of decisions.
- Every decision + action carries a confidence field.
- Ambiguous owner = "Both" + confidence: low, surface it for the operator.
- Never invent dates. Relative ("by Thursday") -> absolute, anchored to the meeting date.
- If an entity is already documented, LINK it. Do not re-introduce.

Doc structure:
- Frontmatter (date, attendees, project, doc-type: meeting-recap)
- TL;DR (3-5 bullets)
- Decisions (table with id, text, owner, confidence)
- Actions (table with title, owner, due, category, confidence)
- Key quotes (3-8)
- Transcript link (separate file)
- Next Actions (link to trackers + PRs)`

export const meetingCapture: PatternAdapter = {
  name: 'meeting-capture',
  defaultRunner: 'hermes',
  costCap: 3.0,

  matches(task: Task): boolean {
    const t = task.text.toLowerCase()
    if (KEYWORDS.some((k) => t.includes(k))) return true
    if (FILE_EXTENSIONS.some((ext) => t.includes(ext))) return true
    return false
  },

  prepare(task: Task, memory: MemoryHit[]): RunnerInput {
    const fewshot =
      memory.length > 0
        ? `\n\nPast meeting recaps for similar contexts (most relevant first):\n${memory
            .map((m, i) => `${i + 1}. ${m.body}`)
            .join('\n')}`
        : ''
    return {
      prompt: task.text,
      systemPrompt: SYSTEM_PROMPT + fewshot,
      allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'],
      maxCostUsd: 3.0,
      metadata: { pattern: 'meeting-capture' },
    }
  },
}
