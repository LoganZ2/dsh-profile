/**
 * anchored — two-phase tool-catalog bootstrap, ported from
 * xiaobright/dsh-anchored-standard's tool-bootstrap.mjs (MIT) onto this
 * bundle's own catalog.
 *
 * Phase 1 (bootstrap): the first model request of a session sees only
 * `bootstrapTools` and, optionally, a capped output budget; auto-injected
 * pre-step context (workspace digests, skill catalogs) is stripped. Wide
 * first-request catalogs measurably degrade planning on DeepSeek V4-family
 * models — that finding is schema-sensitive, so treat the defaults here as a
 * starting point, not as carrying the upstream evidence.
 *
 * Phase 2 (promoted): after the session's first durable promotion signal —
 * a `tool/call` or `assistant/message` event, per `promoteOn` — the catalog
 * widens to `residentTools` (empty = the full catalog) and the budget cap
 * lifts.
 *
 * Compaction epochs: a `compaction/end` event resets promotion — the first
 * post-compaction request is a "second first request" seeing the bootstrap
 * set plus `compactionTools`, until a new signal lands past the boundary.
 * Phase is folded from durable session events, so resume restores it.
 */

import type { Context } from '@deepseek-ai/cordis'

interface SessionLike {
  readonly events?: readonly { readonly type: string }[]
}

interface AgentLike {
  readonly session?: SessionLike
}

// No Events augmentation: the stock packages' own declarations for
// `system-prompt/assemble` and `agent/pre-step` are already in the program
// (via transitive type deps); handlers below are cast at the registration
// site and work structurally against these local shapes.

interface AssembledLike {
  tools: { name: string }[]
  [key: string]: unknown
}

interface PreStepLike {
  kind: string
  messages?: { source?: { kind?: string } }[]
  [key: string]: unknown
}

export interface Config {
  /** First-request catalog. */
  bootstrapTools?: string[]
  /** Promoted catalog; empty or absent = the full catalog. */
  residentTools?: string[]
  /** Extra work set exposed after a compaction, before re-promotion. */
  compactionTools?: string[]
  /** Which durable event promotes: default `either`. */
  promoteOn?: 'tool-call' | 'assistant-message' | 'either'
  /** Optional first-request output cap; stripped after promotion. */
  bootstrapMaxTokens?: number
  /** Pre-step message source kinds stripped during bootstrap. */
  suppressedContextSources?: string[]
}

const PROMOTE_EVENTS: Record<NonNullable<Config['promoteOn']>, readonly string[]> = {
  'tool-call': ['tool/call'],
  'assistant-message': ['assistant/message'],
  either: ['tool/call', 'assistant/message'],
}

/**
 * Epoch-aware promotion fold: promoted iff a signal event exists after the
 * last `compaction/end`. Folded on demand from the session's durable events —
 * small sessions, no memo needed.
 */
function promotionStatus(
  session: SessionLike | undefined,
  signals: readonly string[],
): { promoted: boolean; pastCompaction: boolean } {
  let promoted = false
  let pastCompaction = false
  for (const event of session?.events ?? []) {
    if (event.type === 'compaction/end') {
      promoted = false
      pastCompaction = true
      continue
    }
    if (signals.includes(event.type)) promoted = true
  }
  return { promoted, pastCompaction }
}

export const name = 'anchored'

/** Listener-only plugin: services are touched at event time, never at mount. */
export const inject: string[] = []

/**
 * Register the phase filters.
 * @param ctx - plugin context.
 * @param config - phase catalogs and promotion policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const bootstrapTools = config.bootstrapTools ?? ['bash', 'edit']
  const residentTools = config.residentTools ?? []
  const compactionTools = config.compactionTools ?? []
  const signals = PROMOTE_EVENTS[config.promoteOn ?? 'either']
  const suppressed = new Set(config.suppressedContextSources ?? ['agent-instructions', 'skill-catalog'])
  const bootstrapMaxTokens = config.bootstrapMaxTokens

  let warned = false
  const warnOnce = (message: string): void => {
    if (warned) return
    warned = true
    ctx.logger.warn(message)
  }

  /** Narrow a catalog to a keep-set; missing bootstrap names degrade open. */
  const keep = (assembled: AssembledLike, names: ReadonlySet<string>, degradeOpen: boolean): AssembledLike => {
    const available = new Set(assembled.tools.map(tool => tool.name))
    const missing = [...names].filter(toolName => !available.has(toolName))
    if (missing.length > 0) {
      warnOnce(`anchored: phase tools missing from the catalog: ${missing.join(', ')}`)
      if (degradeOpen) return assembled
    }
    return { ...assembled, tools: assembled.tools.filter(tool => names.has(tool.name)) }
  }

  ctx.on('system-prompt/assemble', (async (
    _assembly: unknown,
    context: { agent?: AgentLike },
    next: () => Promise<AssembledLike>,
  ) => {
    const assembled = await next()
    try {
      const status = promotionStatus(context.agent?.session, signals)
      if (status.promoted) {
        if (residentTools.length === 0) return assembled
        return keep(assembled, new Set(residentTools), false)
      }
      const phase = new Set(bootstrapTools)
      if (status.pastCompaction) for (const toolName of compactionTools) phase.add(toolName)
      return keep(assembled, phase, true)
    } catch (error: unknown) {
      warnOnce(`anchored: filter failed, exposing the full catalog: ${String(error)}`)
      return assembled
    }
  }) as never, { prepend: true })

  if (bootstrapMaxTokens !== undefined) {
    ctx.on('agent/request', (async (
      payload: { agent?: AgentLike },
      next: () => Promise<Record<string, unknown>>,
    ) => {
      const resolved = await next()
      if (promotionStatus(payload.agent?.session, signals).promoted) {
        // The next proposal carries the previous header's maxTokens forward,
        // so the injected cap must be stripped explicitly after promotion.
        if (resolved['maxTokens'] === bootstrapMaxTokens) {
          const { maxTokens: _cap, ...rest } = resolved
          return rest
        }
        return resolved
      }
      return { ...resolved, maxTokens: bootstrapMaxTokens }
    }) as never, { prepend: true })
  }

  ctx.on('agent/pre-step', (async (
    { agent }: { agent?: AgentLike },
    next: () => Promise<PreStepLike>,
  ) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      if (promotionStatus(agent?.session, signals).promoted || suppressed.size === 0) return decision
      if (!Array.isArray(decision.messages)) return decision
      return {
        ...decision,
        messages: decision.messages.filter((message) => {
          const kind = message.source?.kind
          return typeof kind !== 'string' || !suppressed.has(kind)
        }),
      }
    } catch (error: unknown) {
      warnOnce(`anchored: pre-step filter failed, keeping every message: ${String(error)}`)
      return decision
    }
  }) as never, { prepend: true })
}
