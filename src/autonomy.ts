import type { Action, AutonomyDecision, AutonomyPolicy } from './types.js'

// Actions that should NEVER auto-fire. Hard stop, ask the operator.
const REFUSE_TOOL_PREFIXES = [
  'social:post',
  'email:send',
  'telegram:dm_as_user',
  'farcaster:cast',
  'onchain:tx',
  'force_push',
]

// Actions that require operator confirmation.
const CONFIRM_TOOL_PREFIXES = [
  'git:merge',
  'git:push:main',
  'persona:edit',
  'config:edit',
  'systemd:restart',
]

// Words in a description that suggest higher blast-radius.
const ESCALATION_KEYWORDS = ['lock', 'delete', 'publish', 'merge', 'deploy', 'launch']

// Actions that are explicitly safe to AUTO. Everything not in this list falls through to CONFIRM.
const AUTO_PREFIXES = [
  'git:branch',
  'git:commit',
  'git:push:ws',
  'git:push:feature',
  'git:push:fix',
  'fs:write:tmp',
  'memory:record',
  'memory:retrieve',
  'llm:invoke',
  'subprocess:read-only',
]

export const defaultPolicy: AutonomyPolicy = {
  classify(action: Action): AutonomyDecision {
    const kind = action.kind.toLowerCase()

    for (const prefix of REFUSE_TOOL_PREFIXES) {
      if (kind.startsWith(prefix)) {
        return {
          tier: 'REFUSE',
          reason: `Action kind '${kind}' matches REFUSE prefix '${prefix}'.`,
        }
      }
    }

    for (const prefix of CONFIRM_TOOL_PREFIXES) {
      if (kind.startsWith(prefix)) {
        return {
          tier: 'CONFIRM',
          reason: `Action kind '${kind}' matches CONFIRM prefix '${prefix}'.`,
        }
      }
    }

    const description = (action.description ?? '').toLowerCase()
    for (const kw of ESCALATION_KEYWORDS) {
      if (description.includes(kw)) {
        return {
          tier: 'CONFIRM',
          reason: `Action description contains escalation keyword '${kw}'.`,
        }
      }
    }

    for (const prefix of AUTO_PREFIXES) {
      if (kind.startsWith(prefix)) {
        return {
          tier: 'AUTO',
          reason: `Action kind '${kind}' is on the AUTO allowlist.`,
        }
      }
    }

    return {
      tier: 'CONFIRM',
      reason: `Unknown action kind '${kind}'. Default = CONFIRM (fail-safe upward).`,
    }
  },
}

export function gate(action: Action, policy: AutonomyPolicy = defaultPolicy): AutonomyDecision {
  return policy.classify(action)
}
