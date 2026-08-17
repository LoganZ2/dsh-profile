/**
 * Our own `ctx.llm`: pi-ai native, no harness LLM packages behind it.
 *
 * pi-ai's `Models` collection is the provider registry, auth resolver, and
 * wire dispatcher; the injected file credential store gives it stored API keys
 * and OAuth credentials (refresh runs inside the store's serialized `modify`).
 * This service implements the method surface the stock loop and its sidecars
 * actually call — `prepareCall`, `stream`, `resolveModelInfo`,
 * `listProviders`, `listModels` — and dispatches the `llm/stream` waterfall
 * around the wire so stream middleware (session titles, checkpoints) keeps
 * working.
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { createModels, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type {
  Api,
  Model,
  ModelThinkingLevel,
  MutableModels,
  ThinkingLevel,
} from '@earendil-works/pi-ai'
import { buildProvider, catalogById, registerProtocol } from './providers.ts'
import type { Config, RouteConfig } from './providers.ts'
import { FileCredentialStore, fallbackAuthPath } from './store.ts'
import { eventChunks, failureChunk, toPiContext } from './translate.ts'
import type {
  AttachmentReader,
  GenerateOptions,
  LlmCallConfig,
  LlmCallConfigAdapterDefaults,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  PreparedLlmCall,
  ResolvedRetryPolicy,
  StreamChunk,
} from './vocab.ts'
import { callConfigEquals } from './vocab.ts'

// No module augmentation here: `@deepseek-ai/dsh-llm`'s type declarations
// (pulled transitively by dsh-tools) already declare `Context.llm` and the
// `'llm/stream'` waterfall for the same seam this service claims. At runtime
// ours is the only implementation mounted; at compile time we cast at the
// one waterfall call site instead of fighting the merged declarations.

/**
 * Retry is not this layer's business yet (the stock retry row is disabled in
 * our patch), but the loop forwards a policy object to its request-error
 * waterfall, so hand it a well-formed "no retries" value.
 */
const NO_RETRY: ResolvedRetryPolicy = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  jitterRatio: 0.1,
  retryableCodes: Object.freeze([]) as readonly string[],
})

function capitalized(level: string): string {
  return `${level.charAt(0).toUpperCase()}${level.slice(1)}`
}

export class PiLlm extends Service {
  private readonly models: MutableModels
  private readonly credentials: FileCredentialStore
  private routes: ReadonlyMap<string, RouteConfig> = new Map()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'llm')
    const homePath = ctx.get('dshHomePath') as ((...segments: string[]) => string) | undefined
    const authPath = homePath === undefined ? fallbackAuthPath() : homePath('pi-ai', 'auth.json')
    this.credentials = new FileCredentialStore(authPath)
    this.models = createModels({ credentials: this.credentials })
    this.configure(config)
  }

  /**
   * Replace the whole route table. Safe to call after mounting: providers are
   * a registry the next request reads, and a stream already in flight holds
   * the provider it resolved, so it finishes under the routes it started on.
   * @param config - the routes this layer should serve from now on.
   */
  configure(config: Config): void {
    const catalog = catalogById()
    const routes = new Map<string, RouteConfig>()
    // Build every provider BEFORE touching the live registry: a bad route in
    // an edited table must leave the running one alone rather than clear the
    // catalog and abandon the swap half-done.
    const built = Object.entries(config.providers ?? {}).map(([routeId, route]) => {
      const provider = buildProvider(routeId, route, catalog)
      routes.set(routeId, route)
      return provider
    })
    this.models.clearProviders()
    for (const provider of built) this.models.setProvider(provider)
    this.routes = routes
    if (routes.size === 0) {
      this.ctx.logger.warn('llm-pi: no providers configured; every request will fail until config.providers names at least one route')
    }
  }

  /**
   * Add a wire protocol, then rebuild so a route already naming it starts
   * working without a restart.
   * @param id - the `api` value a route names to select it.
   * @param factory - builds the provider streams implementation.
   * @returns a disposer that removes the wire and rebuilds again.
   */
  registerProtocol(id: string, factory: () => never): () => void {
    const release = registerProtocol(id, factory as never)
    this.rebuild()
    return () => {
      release()
      this.rebuild()
    }
  }

  /** Re-apply the current table, tolerating a route the change invalidates. */
  private rebuild(): void {
    try {
      this.configure({ providers: Object.fromEntries(this.routes) })
    } catch (error: unknown) {
      this.ctx.logger.error(`llm-pi: keeping the previous routes — ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Store one route's API key in the credential file, never in settings: it
   * is written 0600 beside the OAuth tokens, and `declaredAuth` prefers it
   * over any environment variable the route names.
   * @param routeId - the route the key belongs to.
   * @param key - the key, or undefined to forget the stored one.
   */
  async setApiKey(routeId: string, key: string | undefined): Promise<void> {
    if (key === undefined || key.length === 0) {
      await this.credentials.delete(routeId)
      return
    }
    await this.credentials.modify(routeId, async () => ({ type: 'api_key', key }))
  }

  /**
   * Which routes hold a stored credential. Only ever whether, never what.
   * @returns the route ids with a credential on file.
   */
  async storedKeys(): Promise<string[]> {
    return (await this.credentials.list()).map(entry => entry.providerId)
  }

  private attachments(): AttachmentReader | undefined {
    return this.ctx.get('attachments') as AttachmentReader | undefined
  }

  private route(provider: string): RouteConfig {
    const route = this.routes.get(provider)
    if (route === undefined) throw new Error(`llm-pi: no configured provider route "${provider}"`)
    return route
  }

  private model(provider: string, model: string): Model<Api> {
    this.route(provider)
    const resolved = this.models.getModel(provider, model)
    if (resolved === undefined) {
      throw new Error(`llm-pi: provider "${provider}" has no model "${model}"`)
    }
    return resolved
  }

  listProviders(): LlmProviderInfo[] {
    return [...this.routes.keys()].map((id) => {
      const provider = this.models.getProvider(id)
      return { id, name: this.routes.get(id)?.displayName ?? provider?.name ?? id }
    })
  }

  async listModels(provider: string): Promise<LlmModelInfo[]> {
    this.route(provider)
    return this.models.getModels(provider).map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: [...model.input],
    }))
  }

  /**
   * Exact-route model metadata: context capacity, output default, and the
   * selectable thinking levels pi-ai derives for this model.
   */
  async resolveModelInfo(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const resolved = this.model(provider, model)
    const levels = resolved.reasoning ? getSupportedThinkingLevels(resolved) : []
    return {
      provider,
      id: resolved.id,
      name: resolved.name,
      inputModalities: [...resolved.input],
      context: { contextWindow: resolved.contextWindow },
      defaultMaxTokens: resolved.maxTokens,
      ...levels.length === 0
        ? {}
        : {
            reasoning: {
              efforts: levels.map(level => ({ id: level, name: capitalized(level) })),
            },
          },
    }
  }

  /** Materialize adapter defaults and validate the effort for one proposal. */
  private async resolveConfig(config: LlmCallConfig, signal?: AbortSignal): Promise<{
    config: LlmCallConfig
    context?: { contextWindow: number }
    adapterDefaults: LlmCallConfigAdapterDefaults
  }> {
    const info = await this.resolveModelInfo(config.provider, config.model, signal)
    const efforts = info.reasoning?.efforts ?? []
    if (config.reasoningEffort !== undefined && !efforts.some(effort => effort.id === config.reasoningEffort)) {
      // Name what would work: the caller cannot guess a model's levels.
      throw new Error(
        `llm-pi: provider "${config.provider}" model "${config.model}" does not support reasoning effort`
        + ` "${config.reasoningEffort}" — ${efforts.length === 0
          ? 'this model takes none, so leave it unset'
          : `supported: ${efforts.map(effort => effort.id).join(', ')}`}`,
      )
    }
    const maxTokens = config.maxTokens ?? info.defaultMaxTokens
    const resolved: LlmCallConfig = {
      ...config,
      ...maxTokens === undefined ? {} : { maxTokens },
    }
    return {
      config: resolved,
      ...info.context === undefined ? {} : { context: info.context },
      adapterDefaults: {
        ...config.maxTokens === undefined && resolved.maxTokens !== undefined ? { maxTokens: true } : {},
      },
    }
  }

  /**
   * Resolve one call and hand back its one-shot dispatch handle, the shape
   * the stock loop logs headers from and then streams through.
   */
  async prepareCall(config: LlmCallConfig, signal?: AbortSignal): Promise<PreparedLlmCall> {
    const resolved = await this.resolveConfig(config, signal)
    const frozenConfig = Object.freeze(structuredClone(resolved.config))
    let dispatched = false
    return Object.freeze({
      config: frozenConfig,
      retryPolicy: NO_RETRY,
      adapterDefaults: Object.freeze(resolved.adapterDefaults),
      ...resolved.context === undefined ? {} : { context: Object.freeze(resolved.context) },
      stream: (options: GenerateOptions): AsyncIterable<StreamChunk> => {
        if (dispatched) throw new Error('llm-pi: a prepared call can only be dispatched once')
        if (!callConfigEquals(options, frozenConfig)) {
          throw new Error('llm-pi: prepared call config changed before dispatch')
        }
        dispatched = true
        return this.stream(options)
      },
    })
  }

  /** Stream one model call as harness chunks, wrapped in the `llm/stream` waterfall. */
  stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    return this.ctx.waterfall(
      'llm/stream',
      options as never,
      (() => this.wireStream(options)) as never,
    ) as AsyncIterable<StreamChunk>
  }

  /**
   * The wire boundary. Setup, dispatch, and iteration failures become one
   * terminal failure chunk; failures thrown INTO the generator by consumers
   * resumed at a yield remain thrown, which is why iteration errors are
   * caught around `next()` alone rather than around the yields.
   */
  private async * wireStream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    let iterator: AsyncIterator<unknown>
    try {
      const route = this.route(options.provider)
      const model = this.model(options.provider, options.model)
      const context = await toPiContext(options, this.attachments())
      const effort = options.reasoningEffort as ModelThinkingLevel | undefined
      const events = this.models.streamSimple(model, context, {
        ...options.signal === undefined ? {} : { signal: options.signal },
        ...options.temperature === undefined ? {} : { temperature: options.temperature },
        ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
        // 'off' is expressed by omitting the option.
        ...effort === undefined || effort === 'off' ? {} : { reasoning: effort as ThinkingLevel },
        ...route.transport === undefined ? {} : { transport: route.transport },
        ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
      })
      iterator = events[Symbol.asyncIterator]()
    } catch (error: unknown) {
      yield failureChunk(error, options.signal)
      return
    }
    let completed = false
    try {
      while (true) {
        let item: IteratorResult<unknown>
        try {
          item = await iterator.next()
        } catch (error: unknown) {
          completed = true
          yield failureChunk(error, options.signal)
          return
        }
        if (item.done === true) {
          completed = true
          return
        }
        for (const chunk of eventChunks(item.value as Parameters<typeof eventChunks>[0])) {
          yield chunk
        }
      }
    } finally {
      if (!completed) await iterator.return?.()
    }
  }
}

export default PiLlm
