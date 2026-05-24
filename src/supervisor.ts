import type { RunEvent } from './types.js'

export type SupervisorVerdict =
  | { kind: 'continue' }
  | { kind: 'intervene'; reason: string; suggestedMessage: string }
  | { kind: 'kill'; reason: string }

export interface SupervisorOptions {
  /** USD cost cap. When the running cost exceeds this, supervisor recommends kill. */
  costCapUsd?: number
  /**
   * Allowed tools. A tool_use event whose tool name is NOT in this list
   * triggers an "off-track" intervene verdict. Empty / undefined = allow all.
   */
  allowedTools?: string[]
  /**
   * How many consecutive identical assistant messages count as a loop.
   * Default: 3.
   */
  loopThreshold?: number
}

interface State {
  recentAssistantMessages: string[]
  costSoFar: number
}

/**
 * Wraps a stream of RunEvents with per-event supervisor verdicts.
 *
 * The orchestrator decides what to DO with the verdict:
 *   - PR2 (this PR): log it to memory as an 'intervened' event (acted=false), continue
 *   - PR3 (next):    call guide.intervene() to actually send a follow-up to the runner
 *
 * Detection rules in this PR:
 *   - loop:       N consecutive identical assistant messages
 *   - off-track:  tool_use for a tool not on the pattern's allowedTools list
 *   - cost-cap:   accumulated cost > costCapUsd  (recommends kill, not intervene)
 *
 * NOT yet (lifted in PR3):
 *   - stuck:      no events for >= stuckTimeoutMs  (needs Promise.race with a timer;
 *                 trivial to add to the orchestrator's drain loop instead of here)
 */
export async function* watch(
  stream: AsyncIterable<RunEvent>,
  opts: SupervisorOptions = {},
): AsyncIterable<{ event: RunEvent; verdict: SupervisorVerdict }> {
  const loopThreshold = opts.loopThreshold ?? 3
  const allowedTools =
    opts.allowedTools && opts.allowedTools.length > 0 ? new Set(opts.allowedTools) : null
  const state: State = { recentAssistantMessages: [], costSoFar: 0 }

  for await (const event of stream) {
    if (event.type === 'cost') {
      state.costSoFar = Math.max(state.costSoFar, event.usd)
    } else if (event.type === 'complete' && typeof event.costUsd === 'number') {
      state.costSoFar = Math.max(state.costSoFar, event.costUsd)
    }

    yield { event, verdict: decide(event, state, { loopThreshold, allowedTools, costCap: opts.costCapUsd }) }
  }
}

interface DecideContext {
  loopThreshold: number
  allowedTools: Set<string> | null
  costCap?: number
}

function decide(event: RunEvent, state: State, ctx: DecideContext): SupervisorVerdict {
  if (ctx.costCap !== undefined && state.costSoFar > ctx.costCap) {
    return {
      kind: 'kill',
      reason: `cost cap exceeded ($${state.costSoFar.toFixed(3)} > $${ctx.costCap.toFixed(2)})`,
    }
  }

  if (event.type === 'tool_use' && ctx.allowedTools && !ctx.allowedTools.has(event.name)) {
    const allowed = [...ctx.allowedTools].join(', ')
    return {
      kind: 'intervene',
      reason: `off-track: tool '${event.name}' not in allowedTools (${allowed})`,
      suggestedMessage: `Supervisor: '${event.name}' is not on this task's allowed-tools list. Use one of: ${allowed}, or explain why this tool is required.`,
    }
  }

  if (event.type === 'message' && event.role === 'assistant') {
    state.recentAssistantMessages.push(event.content)
    if (state.recentAssistantMessages.length > ctx.loopThreshold) {
      state.recentAssistantMessages.shift()
    }
    if (
      state.recentAssistantMessages.length === ctx.loopThreshold &&
      state.recentAssistantMessages.every((m) => m === state.recentAssistantMessages[0])
    ) {
      // Reset the window so the next identical message does not double-fire.
      // The orchestrator will have intervened by then; the resumed session may
      // still loop, in which case the next 3 identicals legitimately re-trigger.
      state.recentAssistantMessages = []
      return {
        kind: 'intervene',
        reason: `loop detected: same assistant message repeated ${ctx.loopThreshold}x`,
        suggestedMessage: `Supervisor: I see the same response ${ctx.loopThreshold} times in a row. Reconsider - the approach may be wrong. State what you have tried and why it failed.`,
      }
    }
  }

  return { kind: 'continue' }
}
