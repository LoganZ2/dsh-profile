/**
 * dsh-bundle-loganz2 — our own LLM layer for the DeepSeek Harness, built
 * directly on pi-ai.
 *
 * The bundle's patch disables the stock harness LLM rows (`llm`, `llm-pi-ai`,
 * `llm-deepseek`, `llm-retry`) and this plugin claims `ctx.llm` in their
 * place. What the stock layer never had, this one does:
 *
 *   - OAuth providers (openai-codex, github-copilot, anthropic, openrouter,
 *     kimi-coding, xai) through pi-ai's own login flows and an injected
 *     credential store — run the bundled login CLI once, then requests
 *     authenticate and refresh on their own.
 *   - A per-route `transport` variable (`sse` | `websocket` |
 *     `websocket-cached` | `auto`), honored wherever the wire protocol
 *     supports it — including hand-declared responses-format routes over
 *     `openai-codex-responses`, the WebSocket-capable wire.
 *
 * @module dsh-bundle-loganz2
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import z from '@deepseek-ai/schemastery'
import { PiLlm } from './service.ts'
import { buildProvider, catalogById, webSocketProtocolIds } from './providers.ts'
import type { Config } from './providers.ts'

export { PiLlm } from './service.ts'
export type { Config, DeclaredModel, RouteConfig } from './providers.ts'
export { FileCredentialStore, fallbackAuthPath } from './store.ts'
export type {
  ContentBlock,
  GenerateOptions,
  LlmCallConfig,
  LlmFailure,
  Message,
  PreparedLlmCall,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from './vocab.ts'

/** The plugin's name, shown in Cordis diagnostics. */
export const name = 'llm-pi'

/** Nothing to wait for: this layer only provides. */
export const inject: string[] = []

/** Settings namespace carrying the editable route table. */
const LLM_PI_NAMESPACE = settingsNamespace('llm-pi')

/**
 * The route table, as a settings section. A route's shape is open by design —
 * `deepseek: {}` names a route in pi-ai's own catalog and needs nothing else,
 * while a hand-declared route brings its endpoint, wire protocol, key
 * variable, and model list — so the section is a dictionary of routes rather
 * than a fixed set of fields.
 */
const CONFIG_SCHEMA = z.object({
  providers: z.dict(z.object({
    transport: z.union(['sse', 'websocket', 'websocket-cached', 'auto'])
      .description('A hint for wires that offer both, such as openai-codex-responses. A wire that is always a socket (openai-responses-ws) ignores it, and a wire that is always SSE rejects it.'),
    baseURL: z.string().description('Hand-declared routes only: the endpoint. A pi-ai catalog route carries its own.'),
    api: z.string()
      .description('Hand-declared routes only: which wire to speak. pi-ai ships openai-completions, openai-responses, anthropic-messages, and openai-codex-responses; a mounted wire plugin adds more, such as openai-responses-ws for Responses over a WebSocket with an API key. Note openai-codex-responses drives the ChatGPT backend and authenticates only with an OAuth credential from `llm-pi-login openai-codex`.'),
    apiKeyEnv: z.string()
      .description('The NAME of an environment variable holding the key — not the key. To give the key directly, use apiKey below.'),
    displayName: z.string().description('Label for selectors. The route id above is what a model selection names.'),
    models: z.array(z.object({
      id: z.string().required(),
      name: z.string(),
      contextWindow: z.number(),
      maxTokens: z.number(),
      reasoning: z.boolean(),
    })).description('Hand-declared routes only: the models this endpoint serves.'),
  })),
})

/**
 * Claim `ctx.llm` with the pi-ai-native service.
 *
 * The profile row stays the base layer: settings resolve on top of it, so an
 * edit that is cleared falls back to the pick-list rather than to nothing.
 * Route changes rebuild the catalog in place, which is why the section
 * reports as live — no restart, and no reload of this plugin.
 *
 * @param ctx - the context this plugin was mounted into.
 * @param config - provider routes from the profile's YAML row.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const llm = new PiLlm(ctx, config)
  // Optional by construction: installSettingsSection injects `settings`
  // itself, so this layer still mounts in a profile without that row.
  let read: () => Config = () => config
  // Registration resolves whatever is already stored through `validate`, and a
  // throw there takes the whole section down — leaving the user no surface on
  // which to see or repair the value. So the stored table is admitted on the
  // way in, and only the writes that follow are held to the rule.
  let strict = false
  installSettingsSection(ctx, LLM_PI_NAMESPACE, CONFIG_SCHEMA as never, config as never, {
    setSource: (current: () => Config) => { read = current },
    // A stored table this layer cannot build must not take the section down
    // with it: registration is what lets the user SEE and repair the value,
    // so the routes stay as they were and the reason is said out loud.
    onChange: () => {
      try {
        llm.configure(read())
      } catch (error: unknown) {
        ctx.logger.error(`llm-pi: keeping the previous routes — ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        strict = true
      }
    },
    // Refuse a bad table at the write that produces it, so the settings
    // surface reports it instead of storing something unusable.
    validate: (section: Config) => {
      if (!strict) return
      const catalog = catalogById()
      for (const [routeId, route] of Object.entries(section.providers ?? {})) {
        buildProvider(routeId, route, catalog)
        // A transport the wire cannot honor is worse than an error: it looks
        // set and changes nothing. Catalog routes carry their own api, so this
        // only judges the ones that declare it.
        const sockets = webSocketProtocolIds()
        if (
          route.api !== undefined
          && !sockets.includes(route.api)
          && (route.transport === 'websocket' || route.transport === 'websocket-cached')
        ) {
          throw new Error(
            `llm-pi: route "${routeId}" asks for transport "${route.transport}", but api "${route.api}" only`
            + ` streams over SSE. Wires that can use a socket: ${sockets.join(', ')}.`
            + ' Either drop the transport, or name one of those as the api.',
          )
        }
      }
    },
  } as never)

  // Keys are not settings: they never round-trip through a config file, so the
  // desktop asks for them on their own messages. Optional by injection, since
  // only the bridge row provides a client to ask.
  ctx.inject(['bridge'], (bctx: Context) => {
    const bridge = bctx.get('bridge') as {
      handle(type: string, handler: (message: Record<string, unknown>, send: (out: Record<string, unknown>) => void) => void | Promise<void>): () => void
    }
    const report = async (send: (out: Record<string, unknown>) => void): Promise<void> => {
      send({ type: 'provider_keys', stored: await llm.storedKeys() })
    }
    bctx.effect(() => bridge.handle('provider_keys', async (_message, send) => report(send)), 'llm-pi: report stored keys')
    bctx.effect(() => bridge.handle('provider_key_set', async (message, send) => {
      const routeId = message['route']
      if (typeof routeId !== 'string' || routeId.length === 0) {
        send({ type: 'error', message: 'provider_key_set needs a route' })
        return
      }
      const key = message['key']
      await llm.setApiKey(routeId, typeof key === 'string' && key.length > 0 ? key : undefined)
      await report(send)
    }), 'llm-pi: store a route key')
  })
}
