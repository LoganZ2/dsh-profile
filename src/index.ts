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

/**
 * Claim `ctx.llm` with the pi-ai-native service.
 * @param ctx - the context this plugin was mounted into.
 * @param config - provider routes from the profile's YAML row.
 */
export function apply(ctx: Context, config: Config = {}): void {
  new PiLlm(ctx, config)
}
