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
    transport: z.union(['sse', 'websocket', 'websocket-cached', 'auto']),
    baseURL: z.string(),
    api: z.union(['openai-completions', 'openai-responses', 'anthropic-messages', 'openai-codex-responses']),
    apiKeyEnv: z.string(),
    displayName: z.string(),
    models: z.array(z.object({
      id: z.string().required(),
      name: z.string(),
      contextWindow: z.number(),
      maxTokens: z.number(),
      reasoning: z.boolean(),
    })),
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
  installSettingsSection(ctx, LLM_PI_NAMESPACE, CONFIG_SCHEMA as never, config as never, {
    setSource: (current: () => Config) => { read = current },
    onChange: () => { llm.configure(read()) },
  } as never)
}
