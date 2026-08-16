/**
 * The harness message/stream vocabulary, declared by us.
 *
 * We deliberately do not depend on `@deepseek-ai/dsh-llm`: this bundle
 * replaces that layer. But the stock agent loop, compaction, and session
 * titles still speak this vocabulary at runtime — method names, chunk shapes,
 * finish kinds — so we declare the same shapes here, structurally. JavaScript
 * is structural at runtime; these types keep us honest at compile time.
 */

/** Provider or transport failure facts carried by terminal finish chunks. */
export interface LlmFailure {
  readonly message: string
  readonly code: string
  readonly status?: number
  readonly providerRetryAfterMs?: number
  readonly requestId?: string
}

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ReasoningBlock {
  type: 'reasoning'
  text: string
}

/** Durable raster image reference owned by the attachment service. */
export interface ImageBlock {
  type: 'image'
  attachment: ImageAttachmentRef
}

export interface ToolCallBlock {
  type: 'tool-call'
  id: string
  name: string
  /** Raw JSON string as produced by the model. */
  arguments: string
}

export interface ToolResultBlock {
  type: 'tool-result'
  toolCallId: string
  content: ContentBlock[]
  isError?: boolean
}

export type ContentBlock = TextBlock | ReasoningBlock | ImageBlock | ToolCallBlock | ToolResultBlock

export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool-calls' }
  | { kind: 'max-tokens' }
  | { kind: 'aborted'; failure: LlmFailure }
  | { kind: 'error'; failure: LlmFailure }

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** Raw streaming protocol the loop's assembler consumes. */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: unknown }

/** Attachment reference shape we read; bytes come from the attachment service. */
export interface ImageAttachmentRef {
  readonly mediaType: string
  readonly [key: string]: unknown
}

/** The slice of the attachment service we consume, duck-typed. */
export interface AttachmentReader {
  readImage(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<{
    readonly data: Uint8Array
    readonly ref: { readonly mediaType: string }
  }>
}

export interface ModelMessageSource {
  kind: 'model'
  provider: string
  model: string
  replayState?: unknown
}

export interface ToolMessageSource {
  kind: 'tool'
  callId: string
}

export type MessageSource =
  | { kind: 'user' }
  | ({ kind: 'plugin'; plugin: string } & Record<string, unknown>)
  | ModelMessageSource
  | ToolMessageSource

export interface Message {
  readonly id: string
  readonly role: 'system' | 'user' | 'assistant'
  readonly content: ContentBlock[]
  readonly source: MessageSource
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** A single model request, fully assembled by the loop or a one-shot caller. */
export interface GenerateOptions {
  provider: string
  model: string
  reasoningEffort?: string
  messages: Message[]
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: string[]
  signal?: AbortSignal
  sessionId?: string
  purpose?: 'compaction' | 'session-title'
}

/** Request-header call config the loop proposes and logs. */
export interface LlmCallConfig {
  provider: string
  model: string
  reasoningEffort?: string
  temperature?: number
  maxTokens?: number
  stop?: string[]
}

export interface LlmCallConfigAdapterDefaults {
  reasoningEffort?: true
  maxTokens?: true
}

/** Retry policy shape the loop forwards to `agent/request-error` listeners. */
export interface ResolvedRetryPolicy {
  readonly mode: 'normal'
  readonly maxRetries: number
  readonly initialDelayMs: number
  readonly maxDelayMs: number
  readonly jitterRatio: number
  readonly retryableCodes: readonly string[]
}

/** One model call whose config and route were resolved together. */
export interface PreparedLlmCall {
  readonly config: LlmCallConfig
  readonly retryPolicy: ResolvedRetryPolicy
  readonly context?: { contextWindow: number }
  readonly adapterDefaults: LlmCallConfigAdapterDefaults
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}

export interface LlmProviderInfo {
  id: string
  name: string
}

export interface LlmModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: readonly ('text' | 'image')[]
}

export interface LlmResolvedModelInfo extends LlmModelInfo {
  context?: { contextWindow: number }
  defaultMaxTokens?: number
  reasoning?: {
    efforts: readonly { id: string; name: string; description?: string }[]
    defaultEffort?: string
  }
}

/** Field-wise call-config equality, matching the loop's own comparison. */
export function callConfigEquals(a: LlmCallConfig, b: LlmCallConfig): boolean {
  if (
    a.provider !== b.provider
    || a.model !== b.model
    || a.reasoningEffort !== b.reasoningEffort
    || a.temperature !== b.temperature
    || a.maxTokens !== b.maxTokens
  ) return false
  if (a.stop === undefined || b.stop === undefined) return a.stop === b.stop
  return a.stop.length === b.stop.length && a.stop.every((s, i) => s === b.stop?.[i])
}
