/**
 * wire-responses-ws — the OpenAI Responses format over a WebSocket, for an
 * endpoint that authenticates with an ordinary API key.
 *
 * pi-ai ships exactly one WebSocket wire, `openai-codex-responses`, and it is
 * bound to the ChatGPT backend: it reads its credential as a JWT and requires a
 * `chatgpt_account_id` claim before it will send anything, then forces that
 * same token into `Authorization`. A proxy that speaks the Responses protocol
 * over a socket and gates it with a plain key cannot be expressed that way — not
 * because the protocol differs, but because of how that wire authenticates.
 *
 * This is the same protocol without the ChatGPT identity: one `response.create`
 * frame up, Responses events back, `Authorization: Bearer <key>`. The request
 * and event conversions are pi-ai's own, so the wire tracks their format rather
 * than reimplementing it.
 *
 * Mount it and name it from a route:
 *
 *     - id: wire-responses-ws
 *       name: 'dsh-bundle-loganz2/wire-responses-ws'
 *
 *     providers:
 *       my-proxy:
 *         api: openai-responses-ws
 *         baseURL: https://proxy.example/v1
 *
 * @module dsh-bundle-loganz2/wire-responses-ws
 */

import type { Context } from '@deepseek-ai/cordis'
import { openAIResponsesWebSocketApi, PROTOCOL_ID } from './wire.ts'

export { openAIResponsesWebSocketApi, PROTOCOL_ID } from './wire.ts'

/** A protocol registry, as `llm-pi` exposes one. */
interface ProtocolHost {
  registerProtocol(id: string, factory: () => unknown, options?: { websocket?: boolean }): () => void
}

export const name = 'wire-responses-ws'
export const inject = ['llm']

/**
 * Register the wire on the LLM layer for as long as this row is mounted.
 * @param ctx - plugin context carrying `llm`.
 */
export function apply(ctx: Context): void {
  const llm = ctx.get('llm') as unknown as ProtocolHost
  ctx.effect(
    // This wire is nothing but a socket, so it declares that capability.
    () => llm.registerProtocol(PROTOCOL_ID, openAIResponsesWebSocketApi, { websocket: true }),
    `wire-responses-ws: register ${PROTOCOL_ID}`,
  )
}
