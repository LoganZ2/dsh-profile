/**
 * Translation between the harness vocabulary and pi-ai's context/event
 * vocabulary. Request direction builds a pi `Context` from harness messages;
 * response direction folds pi `AssistantMessageEvent`s into harness stream
 * chunks for the loop's assembler.
 */

import type {
  AssistantMessage as PiAssistantMessage,
  AssistantMessageEvent,
  Context as PiContext,
  ImageContent,
  Message as PiMessage,
  TextContent,
  Usage as PiUsage,
} from '@earendil-works/pi-ai'
import type {
  AttachmentReader,
  ContentBlock,
  GenerateOptions,
  LlmFailure,
  StreamChunk,
  TokenUsage,
} from './vocab.ts'

/** Flatten nested blocks to text for providers that take strings. */
function blocksText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map(block => block.type === 'text' || block.type === 'reasoning'
      ? block.text
      : block.type === 'tool-result' ? blocksText(block.content) : '')
    .join('')
}

async function userContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentReader | undefined,
): Promise<(TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        if (attachments === undefined) {
          throw new Error('llm-pi: image content requires the attachment service')
        }
        const stored = await attachments.readImage(block.attachment)
        content.push({
          type: 'image',
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        })
        break
      }
      case 'tool-result':
        content.push(...await userContent(block.content, attachments))
        break
      default:
        break
    }
  }
  return content
}

/** Whether an assistant message's stored replay state is a usable pi message. */
function usableReplay(state: unknown): state is PiAssistantMessage {
  const candidate = state as PiAssistantMessage | undefined
  return typeof candidate === 'object'
    && candidate !== null
    && candidate.role === 'assistant'
    && Array.isArray(candidate.content)
    && typeof candidate.api === 'string'
    && typeof candidate.provider === 'string'
}

const ZERO_USAGE: PiUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

/**
 * Rebuild a pi assistant message from harness blocks. Used only for history
 * whose replay state is missing or foreign; a replayed pi message (with
 * thinking signatures and provider identity intact) is always preferred.
 */
function reconstructedAssistant(
  options: GenerateOptions,
  blocks: readonly ContentBlock[],
): PiAssistantMessage {
  const content: PiAssistantMessage['content'] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'reasoning':
        content.push({ type: 'thinking', thinking: block.text })
        break
      case 'tool-call': {
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(block.arguments) as Record<string, unknown>
        } catch {
          parsed = {}
        }
        content.push({ type: 'toolCall', id: block.id, name: block.name, arguments: parsed })
        break
      }
      default:
        break
    }
  }
  return {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: options.provider,
    model: options.model,
    usage: structuredClone(ZERO_USAGE),
    stopReason: content.some(item => item.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  }
}

/**
 * Build the pi request context from one fully assembled harness request.
 * @param options - the harness request.
 * @param attachments - byte resolver for image references, when mounted.
 * @returns the pi context: system prompt, messages, tools.
 */
export async function toPiContext(
  options: GenerateOptions,
  attachments: AttachmentReader | undefined,
): Promise<PiContext> {
  const messages: PiMessage[] = []
  // Tool names by call id: harness tool-result blocks carry only the call id,
  // while pi's toolResult messages want the tool's name back.
  const toolNames = new Map<string, string>()
  const systemExtras: string[] = []
  for (const message of options.messages) {
    const source = message.source
    if (message.role === 'assistant' && source.kind === 'model') {
      const replay = usableReplay(source.replayState) ? source.replayState : undefined
      const assistant = replay ?? reconstructedAssistant(options, message.content)
      for (const item of assistant.content) {
        if (item.type === 'toolCall') toolNames.set(item.id, item.name)
      }
      messages.push(assistant)
      continue
    }
    if (message.role === 'user' && source.kind === 'tool') {
      const result = message.content.find(block => block.type === 'tool-result')
      if (result === undefined) continue
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: await userContent(result.content, attachments),
        isError: result.isError ?? false,
        timestamp: Date.now(),
      })
      continue
    }
    if (message.role === 'system') {
      const text = blocksText(message.content)
      if (text.length > 0) systemExtras.push(text)
      continue
    }
    messages.push({
      role: 'user',
      content: await userContent(message.content, attachments),
      timestamp: Date.now(),
    })
  }
  const system = [options.system, ...systemExtras].filter(part => part !== undefined && part.length > 0)
  return {
    ...system.length > 0 ? { systemPrompt: system.join('\n\n') } : {},
    messages,
    ...options.tools === undefined || options.tools.length === 0
      ? {}
      : {
          // Harness tool parameters are plain JSON Schema objects, which is
          // what pi-ai's typebox TSchema is at runtime.
          tools: options.tools.map(tool => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })) as unknown as PiContext['tools'],
        },
  }
}

function usageChunk(usage: PiUsage): StreamChunk {
  return {
    type: 'usage',
    usage: {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      ...usage.reasoning === undefined ? {} : { reasoningTokens: usage.reasoning },
    } satisfies TokenUsage,
  }
}

/** Normalize one thrown error into terminal-finish failure facts. */
export function normalizeFailure(error: unknown, signal?: AbortSignal): LlmFailure {
  const message = error instanceof Error ? error.message : String(error)
  return {
    message,
    code: signal?.aborted ? 'ABORTED' : 'PROVIDER_ERROR',
  }
}

/** The terminal chunk for one thrown error. */
export function failureChunk(error: unknown, signal?: AbortSignal): StreamChunk {
  const failure = normalizeFailure(error, signal)
  return {
    type: 'finish',
    reason: failure.code === 'ABORTED'
      ? { kind: 'aborted', failure }
      : { kind: 'error', failure },
  }
}

/**
 * Fold one pi event into harness chunks. Text and thinking stream as deltas;
 * tool calls surface at their authoritative `toolcall_end` (pi accumulates
 * argument deltas itself, and the assembler treats `block-end` as final).
 * @param event - the next pi event, in stream order.
 * @returns the harness chunks this event produces, possibly none.
 */
export function eventChunks(event: AssistantMessageEvent): StreamChunk[] {
  switch (event.type) {
    case 'start':
      return []
    case 'text_start':
      return [{ type: 'block-start', index: event.contentIndex, blockType: 'text' }]
    case 'text_delta':
      return [{ type: 'text-delta', index: event.contentIndex, text: event.delta }]
    case 'text_end':
      return [{
        type: 'block-end',
        index: event.contentIndex,
        block: { type: 'text', text: event.content },
      }]
    case 'thinking_start':
      return [{ type: 'block-start', index: event.contentIndex, blockType: 'reasoning' }]
    case 'thinking_delta':
      return [{ type: 'reasoning-delta', index: event.contentIndex, text: event.delta }]
    case 'thinking_end':
      return [{
        type: 'block-end',
        index: event.contentIndex,
        block: { type: 'reasoning', text: event.content },
      }]
    case 'toolcall_start':
      return [{ type: 'block-start', index: event.contentIndex, blockType: 'tool-call' }]
    case 'toolcall_delta':
      return []
    case 'toolcall_end':
      return [{
        type: 'block-end',
        index: event.contentIndex,
        block: {
          type: 'tool-call',
          id: event.toolCall.id,
          name: event.toolCall.name,
          arguments: JSON.stringify(event.toolCall.arguments),
        },
      }]
    case 'done': {
      const reason = event.reason === 'toolUse'
        ? { kind: 'tool-calls' as const }
        : event.reason === 'length'
          ? { kind: 'max-tokens' as const }
          : { kind: 'stop' as const }
      return [
        usageChunk(event.message.usage),
        // The full pi message is the replay state: it preserves thinking
        // signatures and provider identity for faithful history replay.
        { type: 'finish', reason, replayState: structuredClone(event.message) },
      ]
    }
    case 'error': {
      const failure: LlmFailure = {
        message: event.error.errorMessage ?? 'provider stream failed',
        code: event.reason === 'aborted' ? 'ABORTED' : 'PROVIDER_ERROR',
      }
      return [
        ...event.error.usage.totalTokens > 0 ? [usageChunk(event.error.usage)] : [],
        {
          type: 'finish',
          reason: event.reason === 'aborted'
            ? { kind: 'aborted', failure }
            : { kind: 'error', failure },
        },
      ]
    }
    default:
      return []
  }
}
