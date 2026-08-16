/**
 * permission — consent gating, opencode-style (ported from sst/opencode, MIT).
 *
 * One rule shape: `{ permission, pattern, action: allow | ask | deny }`.
 * Rules come from row config; evaluation is "last matching rule wins", default
 * `ask`. Tools call `ctx.permission.ask()` before acting; `deny` throws an
 * error carrying the matching rules (so the model learns the policy), `ask`
 * goes to an interactive responder when one is registered (a future desktop
 * bridge) and otherwise falls back to the configured `askFallback`.
 *
 * No OS sandbox lives behind this: the gate is the wall, which is the
 * opencode trade. Plan-mode enforcement happens here too — when the stock
 * `ctx.planMode` service is mounted and active for the asking agent, a
 * deny-edits overlay joins the ruleset. dsh's plan-mode is deliberately
 * state-without-enforcement, so this is the one place enforcement lives.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

export type PermissionAction = 'allow' | 'ask' | 'deny'

export interface PermissionRule {
  permission: string
  pattern: string
  action: PermissionAction
}

/** Wildcard match: `*` any run, `?` one char; `"cmd *"` also matches bare `cmd`. */
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll('\\', '/')
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`
  return new RegExp(`^${escaped}$`, 's').test(normalized)
}

/** Last matching rule wins; no match defaults to `ask`. */
export function evaluateRule(
  permission: string,
  pattern: string,
  ...rulesets: readonly (readonly PermissionRule[])[]
): PermissionRule {
  return rulesets
    .flat()
    .findLast(rule => wildcardMatch(permission, rule.permission) && wildcardMatch(pattern, rule.pattern))
    ?? { action: 'ask', permission, pattern: '*' }
}

/** Config rule sugar: `edit: "ask"` or `bash: { "git *": "allow" }`. */
export type ConfigRules = Record<string, PermissionAction | Record<string, PermissionAction>>

function rulesFromConfig(config: ConfigRules | undefined): PermissionRule[] {
  const ruleset: PermissionRule[] = []
  for (const [permission, value] of Object.entries(config ?? {})) {
    if (typeof value === 'string') {
      ruleset.push({ permission, pattern: '*', action: value })
      continue
    }
    for (const [pattern, action] of Object.entries(value)) {
      ruleset.push({ permission, pattern, action })
    }
  }
  return ruleset
}

export interface PermissionAskInput {
  /** Permission key: `edit`, `read`, `bash`, `external_directory`, ... */
  permission: string
  /** Concrete patterns this action touches (relative paths, command text). */
  patterns: string[]
  /** Globs an interactive "always" approval would store. */
  always?: string[]
  /** Display facts for an approval surface (diff, command, filepath). */
  metadata?: Record<string, unknown>
  /** The asking agent, for plan-mode overlay resolution. */
  agent?: unknown
}

/** One parked ask, when an interactive responder is registered. */
export interface PermissionRequest {
  readonly permission: string
  readonly patterns: readonly string[]
  readonly always: readonly string[]
  readonly metadata: Readonly<Record<string, unknown>>
}

export type PermissionReply = 'once' | 'always' | 'reject'

export class PermissionDeniedError extends Error {
  readonly code = 'PERMISSION_DENIED'
  constructor(message: string, readonly ruleset: readonly PermissionRule[]) {
    super(message)
  }
}

export interface Config {
  /** The policy: `{ edit: "ask", bash: { "git *": "allow", "rm *": "deny" } }`. */
  rules?: ConfigRules
  /**
   * What an unanswered `ask` resolves to when no interactive responder is
   * registered (one-shot headless runs). `deny` is the safe default: the
   * model receives the refusal and can route around it.
   */
  askFallback?: 'allow' | 'deny'
  /** Overlay applied while plan mode is active for the asking agent. */
  planRules?: ConfigRules
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    permission: PermissionService
  }
}

export class PermissionService extends Service {
  private readonly rules: PermissionRule[]
  private readonly planOverlay: PermissionRule[]
  private readonly askFallback: 'allow' | 'deny'
  /** Session-scoped "always" approvals accumulated from interactive replies. */
  private readonly approved: PermissionRule[] = []
  private responder: ((request: PermissionRequest) => Promise<PermissionReply>) | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx, 'permission')
    this.rules = rulesFromConfig(config.rules)
    this.planOverlay = rulesFromConfig(config.planRules ?? { edit: 'deny' })
    this.askFallback = config.askFallback ?? 'deny'
  }

  /** Register the interactive approval surface. Returns its disposer. */
  respond(responder: (request: PermissionRequest) => Promise<PermissionReply>): () => void {
    this.responder = responder
    return () => {
      if (this.responder === responder) this.responder = undefined
    }
  }

  /** Whether plan mode is active for this agent, when the service is mounted. */
  private planActive(agent: unknown): boolean {
    const planMode = this.ctx.get('planMode') as
      | { get(agent: unknown): { active: boolean } }
      | undefined
    if (planMode === undefined || agent === undefined) return false
    try {
      return planMode.get(agent).active
    } catch {
      return false
    }
  }

  /**
   * Gate one action. Resolves when permitted; throws {@link PermissionDeniedError}
   * when policy or the user refuses.
   */
  async ask(input: PermissionAskInput): Promise<void> {
    const overlay = this.planActive(input.agent) ? this.planOverlay : []
    let needsAsk = false
    for (const pattern of input.patterns) {
      const rule = evaluateRule(input.permission, pattern, this.rules, overlay, this.approved)
      if (rule.action === 'deny') {
        const planNote = overlay.length > 0 ? ' (plan mode is active: present the plan instead of acting)' : ''
        throw new PermissionDeniedError(
          `permission "${input.permission}" denied for "${pattern}"${planNote}`,
          [...this.rules, ...overlay].filter(r => wildcardMatch(input.permission, r.permission)),
        )
      }
      if (rule.action === 'allow') continue
      needsAsk = true
    }
    if (!needsAsk) return

    const request: PermissionRequest = {
      permission: input.permission,
      patterns: [...input.patterns],
      always: [...input.always ?? []],
      metadata: { ...input.metadata },
    }
    if (this.responder === undefined) {
      if (this.askFallback === 'allow') return
      throw new PermissionDeniedError(
        `permission "${input.permission}" requires approval for ${input.patterns.join(', ')},`
        + ' and this run has no interactive approver; allow it via the permission rules config',
        this.rules.filter(r => wildcardMatch(input.permission, r.permission)),
      )
    }
    const reply = await this.responder(request)
    if (reply === 'reject') {
      throw new PermissionDeniedError(`the user rejected "${input.permission}" for ${input.patterns.join(', ')}`, [])
    }
    if (reply === 'always') {
      for (const pattern of request.always) {
        this.approved.push({ permission: request.permission, pattern, action: 'allow' })
      }
    }
  }
}

export const name = 'permission'
export const inject: string[] = []

/**
 * Mount `ctx.permission`.
 * @param ctx - plugin context.
 * @param config - policy rules and fallbacks from the profile row.
 */
export function apply(ctx: Context, config: Config = {}): void {
  new PermissionService(ctx, config)
}
