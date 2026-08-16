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
import { buildProvider, catalogById } from './providers.ts'
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

declare module '@deepseek-ai/cordis' {
  interface Context {
    llm: PiLlm
  }
  interface Events {
    'llm/stream'(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
  }
}

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
  private readonly routes: ReadonlyMap<string, RouteConfig>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'llm')
    const homePath = ctx.get('dshHomePath') as ((...segments: string[]) => string) | undefined
    const authPath = homePath === undefined ? fallbackAuthPath() : homePath('pi-ai', 'auth.json')
    this.models = createModels({ credentials: new FileCredentialStore(authPath) })
    const catalog = catalogById()
    const routes = new Map<string, RouteConfig>()
    for (const [routeId, route] of Object.entries(config.providers ?? {})) {
      this.models.setProvider(buildProvider(routeId, route, catalog))
      routes.set(routeId, route)
    }
    this.routes = routes
    if (routes.size === 0) {
      ctx.logger.warn('llm-pi: no providers configured; every request will fail until config.providers names at least one route')
    }
  }

  private attachments(): AttachmentReader | undefined {
    return this.ctx.get('attachments') as AttachmentReader | undefined
  }

  /**
   * pi-native seam for sibling plugins (the agent loop): resolve one
   * configured route/model pair to its pi model descriptor.
   */
  piModel(provider: string, model: string): Model<Api> {
    return this.model(provider, model)
  }

  /**
   * pi-native stream function for sibling plugins. Route facts this layer
   * owns — the transport toggle today — are folded in here, so a consumer
   * handing this to pi-agent-core inherits them without knowing routes exist.
   */
  streamFn(): (
    model: Model<Api>,
    context: Parameters<MutableModels['streamSimple']>[1],
    options?: Parameters<MutableModels['streamSimple']>[2],
  ) => ReturnType<MutableModels['streamSimple']> {
    return (model, context, options) => {
      const transport = this.routes.get(model.provider)?.transport
      return this.models.streamSimple(model, context, {
        ...options,
        ...transport === undefined || options?.transport !== undefined ? {} : { transport },
      })
    }
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
      throw new Error(
        `llm-pi: provider "${config.provider}" model "${config.model}" does not support reasoning effort "${config.reasoningEffort}"`,
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
    return this.ctx.waterfall('llm/stream', options, () => this.wireStream(options))
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
