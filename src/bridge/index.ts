/**
 * bridge — the desktop driver: a Unix-socket NDJSON server over the running
 * tree. Any local client (Electron main, a node script, `nc -U`) connects to
 * `$DSH_HOME/bridge.sock` and speaks one JSON object per line.
 *
 * Client → server:
 *   {type:'prompt', text, sessionId?}     new conversation, or follow-up
 *   {type:'permission_reply', id, reply}  reply: 'once' | 'always' | 'reject'
 *   {type:'sessions'}                     list the persisted conversations
 *   {type:'resume', sessionId}            reopen a persisted conversation
 *
 * Server → client:
 *   {type:'welcome', v:1}
 *   {type:'session', sessionId}           this conversation is now current
 *   {type:'sessions', sessions}           the picker's rows, newest first
 *   {type:'history', sessionId, events}   a resumed conversation's whole log
 *   {type:'event', sessionId, event}      one durable session event, live
 *   {type:'idle', sessionId}              the turn settled
 *   {type:'permission_ask', id, request}  approval needed; reply by id
 *   {type:'error', message}
 *
 * A session id the client names is resumed from persistence when this process
 * has never held it, so the desktop survives a restart with its conversations.
 *
 * One client at a time. While connected, the client is the interactive
 * permission responder (`ctx.permission.respond`); on disconnect pending asks
 * reject and the configured askFallback rules again.
 */

import { createHash, randomUUID } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { PermissionReply, PermissionService } from '../permission/index.ts'

export interface Config {
  /** Socket path; default `$DSH_HOME/bridge.sock`. */
  socketPath?: string
}

interface AgentHandle {
  followup(message: unknown): void
  whenIdle(): Promise<void>
  session: { id: string; events: readonly unknown[] }
}

interface SessionHeader {
  id: string
  createdAt: number
  cwd?: string
  origin?: string
}

/** The `ctx.sessionQuery` reads a picker needs; search is not among them. */
interface SessionQuery {
  listSessions(): Promise<{ header: SessionHeader; live: boolean; persisted: boolean }[]>
  readTitleSnapshots(ids: readonly string[]): Promise<({
    sessionId: string
    status: 'fulfilled'
    value: { title?: { title: string } }
  } | { sessionId: string; status: 'rejected' })[]>
}

/** One row of the session picker. */
interface SessionRow {
  id: string
  title?: string
  cwd?: string
  createdAt: number
  live: boolean
}

/**
 * The socket for one harness home, OUTSIDE that home: the launcher watches
 * `$DSH_HOME` for patch changes, and `fs.watch` on a socket file crashes.
 * Keyed by the resolved home so two homes never collide on one socket.
 * @param home - the resolved harness home path.
 * @returns the per-home socket path under the OS temp directory.
 */
export function bridgeSocketPath(home: string): string {
  const key = createHash('sha256').update(resolve(home)).digest('hex').slice(0, 8)
  return join(tmpdir(), `dsh-bridge-${key}.sock`)
}

function defaultSocketPath(ctx: Context): string {
  const homePath = ctx.get('dshHomePath') as ((...segments: string[]) => string) | undefined
  if (homePath !== undefined) return bridgeSocketPath(homePath())
  const home = process.env['DSH_HOME']
  return bridgeSocketPath(home !== undefined && home.trim().length > 0 ? home : join(homedir(), '.dsh'))
}

export const name = 'bridge'
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'sessionQuery', 'permission']

/**
 * Mount the socket server and drive conversations for one connected client.
 * @param ctx - plugin context carrying agents, model selection, sessions, permission.
 * @param config - socket path override.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const socketPath = config.socketPath ?? defaultSocketPath(ctx)
  const permission: PermissionService = ctx.permission

  /** Live conversations, by session id. */
  const agents = new Map<string, AgentHandle>()
  let client: net.Socket | undefined
  let releaseResponder: (() => void) | undefined
  const pendingAsks = new Map<string, (reply: PermissionReply) => void>()

  const send = (message: Record<string, unknown>): void => {
    client?.write(`${JSON.stringify(message)}\n`)
  }

  // Forward every durable event of a bridge-owned session, as it lands.
  ctx.on('session/event', (session: { id?: string }, event: unknown) => {
    const sessionId = session.id
    if (sessionId === undefined || !agents.has(sessionId)) return
    send({ type: 'event', sessionId, event })
  })

  /**
   * The live agent for a conversation: the one this process already holds, the
   * persisted session resumed onto a fresh agent, or a brand new conversation.
   * @param requested - a session id the client named, if any.
   * @returns the agent and its session id, and whether this call opened it.
   */
  const openAgent = async (requested: string | undefined): Promise<{
    agent: AgentHandle
    sessionId: string
    opened: boolean
  }> => {
    const held = requested === undefined ? undefined : agents.get(requested)
    if (held !== undefined) return { agent: held, sessionId: requested as string, opened: false }

    await (ctx.get('loader') as { await(): Promise<void> } | undefined)?.await()
    const registry = ctx.get('agents') as {
      create(options: unknown): Promise<{ agent: AgentHandle }>
      resume(options: unknown): Promise<{ agent: AgentHandle }>
    }
    const defaultModel = ctx.get('agentDefaultModel') as {
      currentSelection(): { provider: string; model: string }
    }
    const selection = defaultModel.currentSelection()
    const setup = (agentCtx: Context): void => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    }
    const agentOptions = { provider: selection.provider, model: selection.model }

    // A named session this process never held is on disk, not gone.
    const sessionId = requested ?? `session-${randomUUID()}`
    const created = requested === undefined
      ? await registry.create({
        sessionId: SessionId(sessionId),
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      })
      : await registry.resume({ resumeSessionId: SessionId(sessionId), agentOptions, setup })

    agents.set(sessionId, created.agent)
    await created.agent.whenIdle()
    return { agent: created.agent, sessionId, opened: true }
  }

  const handlePrompt = async (text: string, requestedSession: string | undefined): Promise<void> => {
    const { agent, sessionId, opened } = await openAgent(requestedSession)
    if (opened) send({ type: 'session', sessionId })
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
    send({ type: 'idle', sessionId })
  }

  const handleResume = async (requestedSession: string): Promise<void> => {
    const { agent, sessionId } = await openAgent(requestedSession)
    send({ type: 'session', sessionId })
    send({ type: 'history', sessionId, events: [...agent.session.events] })
    send({ type: 'idle', sessionId })
  }

  /** Persisted root conversations, newest first; subagent children are not rows. */
  const handleSessions = async (): Promise<void> => {
    const query = ctx.get('sessionQuery') as SessionQuery
    const records = await query.listSessions()
    const rows = records.filter(record => record.persisted && record.header.origin === undefined)
    const observed = await query.readTitleSnapshots(rows.map(record => record.header.id))
    const titles = new Map<string, string>()
    for (const observation of observed) {
      if (observation.status !== 'fulfilled') continue
      const title = observation.value.title?.title
      if (title !== undefined) titles.set(observation.sessionId, title)
    }
    const sessions: SessionRow[] = rows
      .map(record => ({
        id: record.header.id,
        ...titles.has(record.header.id) ? { title: titles.get(record.header.id) as string } : {},
        ...record.header.cwd === undefined ? {} : { cwd: record.header.cwd },
        createdAt: record.header.createdAt,
        live: record.live,
      }))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 100)
    send({ type: 'sessions', sessions })
  }

  const handleLine = (line: string): void => {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      send({ type: 'error', message: 'invalid JSON line' })
      return
    }
    switch (message['type']) {
      case 'prompt': {
        const text = message['text']
        if (typeof text !== 'string' || text.length === 0) {
          send({ type: 'error', message: 'prompt needs non-empty text' })
          return
        }
        const requested = typeof message['sessionId'] === 'string' ? message['sessionId'] : undefined
        void handlePrompt(text, requested).catch((error: unknown) => {
          send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        })
        return
      }
      case 'sessions': {
        void handleSessions().catch((error: unknown) => {
          send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        })
        return
      }
      case 'resume': {
        const requested = message['sessionId']
        if (typeof requested !== 'string' || requested.length === 0) {
          send({ type: 'error', message: 'resume needs a sessionId' })
          return
        }
        void handleResume(requested).catch((error: unknown) => {
          send({ type: 'error', message: error instanceof Error ? error.message : String(error) })
        })
        return
      }
      case 'permission_reply': {
        const id = message['id']
        const reply = message['reply']
        if (typeof id !== 'string' || (reply !== 'once' && reply !== 'always' && reply !== 'reject')) {
          send({ type: 'error', message: 'permission_reply needs id and reply once|always|reject' })
          return
        }
        const resolver = pendingAsks.get(id)
        if (resolver === undefined) return
        pendingAsks.delete(id)
        resolver(reply)
        return
      }
      default:
        send({ type: 'error', message: `unknown message type ${String(message['type'])}` })
    }
  }

  const server = net.createServer((socket) => {
    if (client !== undefined) {
      socket.write(`${JSON.stringify({ type: 'error', message: 'another client is connected' })}\n`)
      socket.end()
      return
    }
    client = socket
    // While a client is connected, it answers permission asks interactively.
    releaseResponder = permission.respond((request) => {
      const id = randomUUID()
      return new Promise<PermissionReply>((resolvePromise) => {
        pendingAsks.set(id, resolvePromise)
        send({ type: 'permission_ask', id, request })
      })
    })
    send({ type: 'welcome', v: 1 })
    let buffered = ''
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString()
      let index = buffered.indexOf('\n')
      while (index !== -1) {
        const line = buffered.slice(0, index).trim()
        buffered = buffered.slice(index + 1)
        if (line.length > 0) handleLine(line)
        index = buffered.indexOf('\n')
      }
    })
    const drop = (): void => {
      if (client !== socket) return
      client = undefined
      releaseResponder?.()
      releaseResponder = undefined
      for (const resolver of pendingAsks.values()) resolver('reject')
      pendingAsks.clear()
    }
    socket.on('close', drop)
    socket.on('error', drop)
  })

  void (async (): Promise<void> => {
    await mkdir(dirname(socketPath), { recursive: true })
    await unlink(socketPath).catch(() => {})
    server.listen(socketPath, () => {
      void chmod(socketPath, 0o600).catch(() => {})
      ctx.logger.info(`bridge: listening on ${socketPath}`)
    })
  })()

  ctx.effect(() => () => {
    server.close()
    try {
      unlinkSync(socketPath)
    } catch {
      // Socket already gone.
    }
  }, 'bridge: close socket server')
}
