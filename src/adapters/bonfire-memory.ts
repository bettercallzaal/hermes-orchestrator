import type { MemoryAdapter, MemoryHit, OrchestratorEvent } from '../types.js'

export interface BonfireMemoryOptions {
  /** Bonfire UUID (the bonfire_id on writes, bonfire_ref on reads). */
  bonfireId: string
  /** Single bearer token per Bonfire. NEVER hard-code; read from env on the host that has the key. */
  apiKey: string
  /** API base URL. Default: https://tnt-v2.api.bonfires.ai */
  apiBase?: string
  /** Short label identifying this orchestrator in the graph. Default: 'hermes-orchestrator'. */
  sourceDescription?: string
}

// Mirror of recall.ts containsSecret() - the 9 HIGH-severity patterns.
// Any body matching one of these is SKIPPED, never POSTed.
// eslint-disable-next-line no-useless-escape
const SECRET_RE =
  /sk-ant-[A-Za-z0-9_-]{20,}|sk-(proj-|cp-)?[A-Za-z0-9_-]{30,}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}|-----BEGIN ([A-Z]+ )?PRIVATE KEY-----|0x[0-9a-fA-F]{64}|[0-9]{9,12}:[A-Za-z0-9_-]{30,}|xox[bpaors]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}/

// PII patterns - emails, phones (skip on match, best-effort like secrets).
// Per .claude/rules/pii-hygiene.md, allowlists applied.
// eslint-disable-next-line no-useless-escape
const PII_EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/
const PII_PHONE_US_RE = /\+?1?\s*\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/
const PII_PHONE_INTL_RE = /\+\d{1,3}[\s.-]*\d[\d\s.-]{5,}/

// Allowlisted emails (public ZAO addresses) - may appear in episodes
const ALLOWLISTED_EMAILS = new Set([
  'zaal@thezao.com',
  'zaalp99@gmail.com',
  'zaal@bettercallzaal.com',
  'zoe-zao@agentmail.to',
  'hello@thezao.com',
  'support@thezao.com',
])

// Allowlisted Telegram handles (public ZAO bots) - may appear in episodes
const ALLOWLISTED_TG_HANDLES = new Set([
  '@zaoclaw_bot',
  '@zoe_hermes_bot',
  '@zaodevz_bot',
  '@zabal_bonfire',
  '@ZAOstockTeamBot',
  '@ZAOcoworkingBot',
])

function containsSecret(text: string): boolean {
  return SECRET_RE.test(text)
}

function containsPII(text: string): boolean {
  // Check emails: pass if all matches are allowlisted
  const emailMatches = text.match(PII_EMAIL_RE)
  if (emailMatches) {
    for (const email of emailMatches) {
      if (!ALLOWLISTED_EMAILS.has(email)) {
        return true
      }
    }
  }

  // Check US phone numbers
  if (PII_PHONE_US_RE.test(text)) {
    return true
  }

  // Check international phone numbers
  if (PII_PHONE_INTL_RE.test(text)) {
    return true
  }

  // Check Telegram handles: pass if all matches are allowlisted.
  // Use matchAll to get captures and extract just the handle part (group 1).
  const tgRegex = /(?:^|\s)(@\w+)(?!\.[A-Za-z])/gm
  let tgMatch: RegExpExecArray | null
  while ((tgMatch = tgRegex.exec(text)) !== null) {
    const handle = tgMatch[1]
    if (!ALLOWLISTED_TG_HANDLES.has(handle)) {
      return true
    }
  }

  return false
}

function eventToEpisode(
  event: OrchestratorEvent,
): { name: string; body: string } | null {
  const date = event.occurredAt.slice(0, 10)
  const { taskId, kind, payload } = event
  let body: string
  switch (kind) {
    case 'classified':
      body = `On ${date}, orchestrator classified task ${taskId} ("${String(payload.taskText ?? '').slice(0, 100)}") as pattern '${payload.pattern}' with confidence ${payload.confidence}. Reasoning: ${payload.reasoning}.`
      break
    case 'gated':
      body = `On ${date}, autonomy gate classified action '${payload.action}' for task ${taskId} as ${payload.tier}. Reason: ${payload.reason}.`
      break
    case 'spawned':
      body = `On ${date}, orchestrator spawned a '${payload.runner}' agent for task ${taskId} under pattern '${payload.pattern}' (run id ${payload.runId}). Cost cap: $${payload.costCap}.`
      break
    case 'intervened':
      body = `On ${date}, orchestrator intervened in task ${taskId} at step ${payload.step}: ${payload.reason}. Sent: ${String(payload.message ?? '').slice(0, 200)}.`
      break
    case 'completed':
      body = `On ${date}, orchestrator marked task ${taskId} complete via '${payload.runner}' / pattern '${payload.pattern}'. Duration: ${payload.durationMs}ms. Cost: $${Number(payload.costUsd ?? 0).toFixed(3)}. Outcome: ${String(payload.summary ?? 'no summary').slice(0, 300)}.`
      break
    case 'failed':
      body = `On ${date}, orchestrator marked task ${taskId} FAILED via '${payload.runner ?? 'unknown'}' / pattern '${payload.pattern ?? 'unknown'}'. Reason: ${payload.reason ?? payload.detail ?? 'unspecified'}.`
      break
    default:
      return null
  }
  return { name: `orch:${kind}:${taskId}`, body }
}

/**
 * Default MemoryAdapter. Writes orchestrator events as episodes to a Bonfire KG.
 * Best-effort: never throws. Bodies are secret-scanned and PII-scanned locally before any POST.
 * Episodes matching secret or PII patterns are skipped (never POSTed).
 *
 * Caveat: vector_store/search returns [] until an admin runs labeling on the
 * Bonfire. Until then, retrieve() returns []. The code path is live - no change
 * needed when labeling unlocks.
 */
export class BonfireMemory implements MemoryAdapter {
  private readonly apiBase: string
  private readonly sourceDescription: string

  constructor(private readonly opts: BonfireMemoryOptions) {
    this.apiBase = opts.apiBase ?? 'https://tnt-v2.api.bonfires.ai'
    this.sourceDescription = opts.sourceDescription ?? 'hermes-orchestrator'
  }

  async record(event: OrchestratorEvent): Promise<void> {
    const episode = eventToEpisode(event)
    if (!episode) return
    if (containsSecret(episode.body)) {
      console.warn(
        `[bonfire-memory] SKIP episode ${episode.name} - body matched secret pattern (never POSTed)`,
      )
      return
    }
    if (containsPII(episode.body)) {
      console.warn(
        `[bonfire-memory] SKIP episode ${episode.name} - body matched PII pattern (never POSTed)`,
      )
      return
    }
    try {
      const res = await fetch(`${this.apiBase}/knowledge_graph/episode/create`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bonfire_id: this.opts.bonfireId,
          name: episode.name,
          episode_body: episode.body,
          source: 'text',
          source_description: this.sourceDescription,
          reference_time: event.occurredAt,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) {
        console.warn(`[bonfire-memory] FAIL ${episode.name} - HTTP ${res.status}`)
      }
    } catch (err) {
      console.warn(
        `[bonfire-memory] FAIL ${episode.name} - ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async retrieve(pattern: string, taskClass: string, limit: number): Promise<MemoryHit[]> {
    try {
      const res = await fetch(`${this.apiBase}/vector_store/search`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          bonfire_ref: this.opts.bonfireId,
          search_string: `pattern:${pattern} task-class:${taskClass}`,
          limit,
        }),
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) return []
      const data = (await res.json()) as {
        results?: Array<Record<string, unknown>>
      }
      return (data.results ?? []).map((r) => ({
        name: String(r.name ?? ''),
        body: String(r.body ?? r.episode_body ?? ''),
        sourceTag: String(r.source_description ?? ''),
        score: typeof r.score === 'number' ? r.score : undefined,
      }))
    } catch {
      return []
    }
  }
}
