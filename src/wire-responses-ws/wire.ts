/**
 * The wire itself: Responses over a WebSocket, keyed by an API key.
 *
 * Both conversions are pi-ai's — `convertResponsesMessages` builds the input
 * items, `processResponsesStream` folds the events into the assistant message —
 * so this module owns only the socket and the one frame that opens a response.
 *
 * @module dsh-bundle-loganz2/wire-responses-ws/wire
 */

import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context as PiContext,
  Model,
  ProviderStreams,
  SimpleStreamOptions,
  StreamOptions,
} from '@earendil-works/pi-ai'
import {
  convertResponsesMessages,
  convertResponsesTools,
  processResponsesStream,
} from '@earendil-works/pi-ai/api/openai-responses-shared'

/** The `api` value a route names to use this wire. */
export const PROTOCOL_ID = 'openai-responses-ws'

/** How long to wait for the socket to open before giving up. */
const CONNECT_TIMEOUT_MS = 30_000

/** Tool calls this wire will replay back to the model, by provider id. */
const TOOL_CALL_PROVIDERS: ReadonlySet<string> = new Set<string>()

/**
 * The socket URL for a route's endpoint: the same path, over ws.
 * @param baseUrl - the route's configured endpoint.
 * @returns the `ws:`/`wss:` URL to dial.
 */
export function webSocketUrl(baseUrl: string): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/responses`)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol === 'http:') url.protocol = 'ws:'
  return url.toString()
}

/** Node's error event carries the real cause on `error`, and an empty `message`. */
function socketErrorText(event: { message?: string, error?: { message?: string } }): string | undefined {
  const text = event.error?.message ?? ''
  if (text.length > 0) return text
  const fallback = event.message ?? ''
  return fallback.length > 0 ? fallback : undefined
}

interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: never) => void): void
  removeEventListener(type: string, listener: (event: never) => void): void
}

type SocketFactory = new (url: string, options: { headers: Record<string, string> }) => SocketLike

/**
 * The runtime's own WebSocket. Node's sends the custom headers this wire needs
 * for `Authorization`, so no package dependency is involved.
 * @returns a WebSocket constructor.
 */
function socketConstructor(): SocketFactory {
  const globalCtor = (globalThis as { WebSocket?: unknown }).WebSocket
  if (typeof globalCtor !== 'function') {
    throw new Error('llm-pi: this runtime has no WebSocket; the openai-responses-ws wire needs one')
  }
  return globalCtor as unknown as SocketFactory
}

async function connect(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<SocketLike> {
  const Ctor = socketConstructor()
  const socket = new Ctor(url, { headers })
  return new Promise<SocketLike>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => fail(new Error(`websocket connect timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS)
    const cleanup = (): void => {
      clearTimeout(timer)
      socket.removeEventListener('open', onOpen as never)
      socket.removeEventListener('error', onError as never)
      socket.removeEventListener('close', onClose as never)
    }
    function fail(error: Error): void {
      if (settled) return
      settled = true
      cleanup()
      try {
        socket.close(1000, 'connect_failed')
      } catch {
        // Already closed.
      }
      reject(error)
    }
    const onOpen = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(socket)
    }
    // A refused upgrade is the common failure — wrong path, no socket support,
    // a rejected key — so say which URL was dialed and what came back.
    const onError = (event: { message?: string, error?: { message?: string } }): void =>
      fail(new Error(`could not open a websocket to ${url}: ${socketErrorText(event) ?? 'the connection was refused or the upgrade rejected'}`))
    const onClose = (event: { code?: number, reason?: string }): void =>
      fail(new Error(
        `could not open a websocket to ${url}: closed before opening`
        + ` (code ${event.code ?? 0}${event.reason === undefined || event.reason === '' ? '' : `, ${event.reason}`})`,
      ))
    socket.addEventListener('open', onOpen as never)
    socket.addEventListener('error', onError as never)
    socket.addEventListener('close', onClose as never)
    signal?.addEventListener('abort', () => fail(new Error('Request was aborted')), { once: true })
  })
}

/**
 * The socket's frames as Responses events. Ends when the response completes,
 * the peer closes, or the caller aborts.
 * @param socket - an open socket.
 * @param signal - the caller's abort signal.
 * @returns the event stream to hand to pi-ai's fold.
 */
async function* frames(socket: SocketLike, signal?: AbortSignal): AsyncGenerator<unknown> {
  const queue: unknown[] = []
  let done = false
  let failure: Error | undefined
  let wake: (() => void) | undefined
  const bump = (): void => {
    wake?.()
    wake = undefined
  }

  const onMessage = (event: { data: unknown }): void => {
    const raw = typeof event.data === 'string' ? event.data : String(event.data)
    try {
      queue.push(JSON.parse(raw))
    } catch {
      failure = new Error('websocket sent a frame that is not JSON')
      done = true
    }
    bump()
  }
  const onClose = (): void => { done = true; bump() }
  const onError = (event: { message?: string, error?: { message?: string } }): void => {
    failure = new Error(`websocket failed mid-response: ${socketErrorText(event) ?? 'the connection dropped'}`)
    done = true
    bump()
  }
  const onAbort = (): void => { done = true; bump() }

  socket.addEventListener('message', onMessage as never)
  socket.addEventListener('close', onClose as never)
  socket.addEventListener('error', onError as never)
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      while (queue.length > 0) {
        const event = queue.shift()
        yield event
        // The fold has everything it needs once the response terminates.
        const type = (event as { type?: string }).type
        if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') return
      }
      if (failure !== undefined) throw failure
      if (done) return
      await new Promise<void>((resolve) => { wake = resolve })
    }
  } finally {
    socket.removeEventListener('message', onMessage as never)
    socket.removeEventListener('close', onClose as never)
    socket.removeEventListener('error', onError as never)
    signal?.removeEventListener('abort', onAbort as never)
  }
}

function emptyUsage(): AssistantMessage['usage'] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function run(
  model: Model<Api>,
  context: PiContext,
  options: StreamOptions | SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  void (async () => {
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: 'stop',
      timestamp: Date.now(),
    }
    let socket: SocketLike | undefined
    try {
      const apiKey = (options as { apiKey?: string } | undefined)?.apiKey
      if (apiKey === undefined || apiKey.length === 0) {
        throw new Error(`No API key for provider: ${model.provider}`)
      }
      const baseUrl = model.baseUrl
      if (baseUrl === undefined || baseUrl.length === 0) {
        throw new Error(`route "${model.provider}" needs a baseURL to open a websocket`)
      }
      const body = {
        model: model.id,
        input: convertResponsesMessages(model, context, TOOL_CALL_PROVIDERS),
        ...context.tools === undefined || context.tools.length === 0
          ? {}
          : { tools: convertResponsesTools(context.tools) },
        stream: true,
        ...model.maxTokens === undefined ? {} : { max_output_tokens: (options as { maxTokens?: number } | undefined)?.maxTokens ?? model.maxTokens },
      }
      const signal = (options as { signal?: AbortSignal } | undefined)?.signal
      socket = await connect(webSocketUrl(baseUrl), {
        Authorization: `Bearer ${apiKey}`,
        ...(options as { headers?: Record<string, string> } | undefined)?.headers ?? {},
      }, signal)
      socket.send(JSON.stringify({ type: 'response.create', ...body }))
      stream.push({ type: 'start', partial: output })
      await processResponsesStream(frames(socket, signal) as never, output, stream, model)
      if (signal?.aborted === true) throw new Error('Request was aborted')
      if (output.stopReason === 'aborted' || output.stopReason === 'error') {
        throw new Error(output.errorMessage ?? 'the provider stream failed')
      }
      stream.push({ type: 'done', reason: output.stopReason, message: output })
      stream.end()
    } catch (error: unknown) {
      output.stopReason = (options as { signal?: AbortSignal } | undefined)?.signal?.aborted === true ? 'aborted' : 'error'
      output.errorMessage = error instanceof Error ? error.message : String(error)
      stream.push({ type: 'error', reason: output.stopReason, error: output })
      stream.end()
    } finally {
      try {
        socket?.close(1000, 'done')
      } catch {
        // Already closed.
      }
    }
  })()
  return stream
}

/**
 * The wire as pi-ai's provider contract. Both entry points behave the same:
 * this protocol has no separate simple mode.
 * @returns the provider streams implementation.
 */
export function openAIResponsesWebSocketApi(): ProviderStreams {
  return {
    stream: (model, context, options) => run(model, context, options),
    streamSimple: (model, context, options) => run(model, context, options),
  }
}
