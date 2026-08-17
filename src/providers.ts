/**
 * Route configuration and pi-ai `Provider` construction.
 *
 * A route key naming a pi-ai catalog provider mounts that provider whole —
 * endpoint, protocol, model list, and auth flows (API key AND OAuth) come from
 * the catalog. Any other key is a hand-declared route built over the protocol
 * table below; unlike the stock harness plugin, the table includes
 * `openai-codex-responses`, the one wire implementation that honors the
 * WebSocket transport toggle — so a gateway speaking responses-format over WS
 * is reachable with a plain API key.
 */

import { createProvider } from '@earendil-works/pi-ai'
import type { Api, ApiKeyAuth, Model, Provider, ProviderStreams, Transport } from '@earendil-works/pi-ai'
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy'
import { openAICodexResponsesApi } from '@earendil-works/pi-ai/api/openai-codex-responses.lazy'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'

/** One model a hand-declared route advertises. */
export interface DeclaredModel {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  reasoning?: boolean
}

/** Per-route configuration. */
export interface RouteConfig {
  /**
   * Streaming transport preference: `sse`, `websocket`, `websocket-cached`,
   * or `auto`. Passed per request; honored wherever the wire protocol
   * supports it (`openai-codex-responses` today), ignored elsewhere.
   */
  transport?: Transport
  /** Hand-declared routes only: the endpoint to talk to. */
  baseURL?: string
  /**
   * Hand-declared routes only: which wire protocol to speak. The four pi-ai
   * ships, plus any a mounted wire plugin registered.
   */
  api?: string
  /** Hand-declared routes only: env var holding the API key. */
  apiKeyEnv?: string
  /** Hand-declared routes only: the models this route serves. */
  models?: DeclaredModel[]
  /** Display name for selectors; defaults to the route key. */
  displayName?: string
}

/** Plugin configuration: which provider routes exist, keyed by route id. */
export interface Config {
  providers?: Record<string, RouteConfig>
}

/**
 * The wire protocols a route may name. The four pi-ai ships are always here;
 * a plugin adds its own through {@link registerProtocol}, so a wire lives in
 * its own row rather than in this table.
 */
interface ProtocolEntry {
  factory: () => ProviderStreams
  /** Whether this wire can stream over a WebSocket at all. */
  websocket: boolean
}

const PROTOCOLS = new Map<string, ProtocolEntry>([
  ['openai-completions', { factory: openAICompletionsApi, websocket: false }],
  ['openai-responses', { factory: openAIResponsesApi, websocket: false }],
  ['anthropic-messages', { factory: anthropicMessagesApi, websocket: false }],
  ['openai-codex-responses', { factory: openAICodexResponsesApi, websocket: true }],
])

/**
 * Add a wire for as long as the caller holds the returned disposer.
 * @param id - the `api` value a route names to select it.
 * @param factory - builds the provider streams implementation.
 * @returns a disposer that removes it again.
 * @throws if the id is already taken.
 */
export function registerProtocol(
  id: string,
  factory: () => ProviderStreams,
  options: { websocket?: boolean } = {},
): () => void {
  if (PROTOCOLS.has(id)) throw new Error(`llm-pi: wire protocol "${id}" is already registered`)
  const entry: ProtocolEntry = { factory, websocket: options.websocket ?? false }
  PROTOCOLS.set(id, entry)
  return () => {
    if (PROTOCOLS.get(id) === entry) PROTOCOLS.delete(id)
  }
}

/** The wires that can stream over a socket, whoever registered them. */
export function webSocketProtocolIds(): string[] {
  return [...PROTOCOLS.entries()].filter(([, entry]) => entry.websocket).map(([id]) => id)
}

/** Every protocol a route may name right now. */
export function protocolIds(): string[] {
  return [...PROTOCOLS.keys()]
}

function declaredModels(routeId: string, route: RouteConfig): Model<Api>[] {
  const api = route.api as Api
  return (route.models ?? []).map(model => ({
    id: model.id,
    name: model.name ?? model.id,
    api,
    provider: routeId,
    baseUrl: route.baseURL as string,
    reasoning: model.reasoning ?? false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? 128000,
    maxTokens: model.maxTokens ?? 8192,
  }))
}

/**
 * Api-key auth for a hand-declared route: the stored credential (written by
 * the login CLI's api_key flow) wins, then the configured env var.
 */
function declaredAuth(routeId: string, route: RouteConfig): ApiKeyAuth {
  return {
    name: `${route.displayName ?? routeId} API key`,
    resolve: async ({ ctx, credential }) => {
      const key = credential?.key
        ?? (route.apiKeyEnv === undefined ? undefined : await ctx.env(route.apiKeyEnv))
      if (key === undefined || key.length === 0) return undefined
      return {
        auth: { apiKey: key },
        source: credential?.key !== undefined ? 'stored key' : route.apiKeyEnv,
      }
    },
  }
}

/**
 * Build the pi-ai provider for one configured route.
 * @param routeId - the route key from configuration.
 * @param route - that route's configuration.
 * @param catalog - the pi-ai builtin providers, indexed by id.
 * @returns the provider to register into the models collection.
 */
export function buildProvider(
  routeId: string,
  route: RouteConfig,
  catalog: ReadonlyMap<string, Provider>,
): Provider {
  const builtin = catalog.get(routeId)
  if (builtin !== undefined) {
    if (route.baseURL !== undefined || route.api !== undefined) {
      throw new Error(
        `llm-pi: route "${routeId}" names a pi-ai catalog provider; it already carries its endpoint`
        + ' and protocol, so baseURL/api overrides are not supported — pick a different route key'
        + ' to hand-declare a separate endpoint',
      )
    }
    return builtin
  }
  if (route.baseURL === undefined || route.api === undefined) {
    throw new Error(
      `llm-pi: route "${routeId}" is not a pi-ai catalog provider, so it must declare baseURL and api`
      + ` (one of: ${protocolIds().join(', ')})`,
    )
  }
  const entry = PROTOCOLS.get(route.api)
  if (entry === undefined) {
    throw new Error(
      `llm-pi: route "${routeId}" names unsupported api "${route.api as string}"`
      + ` — available: ${protocolIds().join(', ')}`,
    )
  }
  if ((route.models ?? []).length === 0) {
    throw new Error(`llm-pi: hand-declared route "${routeId}" must declare at least one model`)
  }
  return createProvider({
    id: routeId,
    name: route.displayName ?? routeId,
    baseUrl: route.baseURL,
    auth: { apiKey: declaredAuth(routeId, route) },
    models: declaredModels(routeId, route),
    api: entry.factory(),
  })
}

/** The pi-ai builtin catalog, indexed by provider id. */
export function catalogById(): Map<string, Provider> {
  return new Map(builtinProviders().map(provider => [provider.id, provider]))
}
