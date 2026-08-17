/**
 * tool-bash — opencode-style shell tool (ported from sst/opencode, MIT).
 *
 * The command is parsed with tree-sitter-bash and split into its constituent
 * simple commands; each contributes a permission pattern (its exact source)
 * and an "always" pattern from the arity table (`git checkout main` →
 * `git checkout *`). Path arguments of known file commands that resolve
 * outside the worktree raise the external_directory consent first. Execution
 * is a plain `/bin/bash -c` — no OS sandbox; the gate is the wall.
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PermissionService } from '../permission/index.ts'
import { worktree } from '../toolfs/common.ts'
import { arityPrefix } from './arity.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_CHARS = 30_000

/** Commands that only observe the shell itself; no pattern needed. */
const CWD_ONLY = new Set(['cd', 'pwd', 'true', 'false'])

/** Commands whose path arguments are scanned for external directories. */
const FILE_COMMANDS = new Set([
  'cat', 'cp', 'mv', 'rm', 'touch', 'mkdir', 'rmdir', 'ls', 'head', 'tail',
  'less', 'more', 'ln', 'chmod', 'chown', 'sed', 'awk', 'grep', 'find',
])

interface Scan {
  dirs: Set<string>
  patterns: Set<string>
  always: Set<string>
}

type BashParser = { parse(command: string): { rootNode: BashNode } | null }
interface BashNode {
  type: string
  text: string
  children: BashNode[]
  descendantsOfType(type: string): BashNode[]
}

let parserPromise: Promise<BashParser> | undefined

/** Lazily initialize web-tree-sitter with the bash grammar. */
function parser(): Promise<BashParser> {
  parserPromise ??= (async () => {
    const { Parser, Language } = await import('web-tree-sitter')
    const require = createRequire(import.meta.url)
    await Parser.init()
    const bash = await Language.load(require.resolve('tree-sitter-bash/tree-sitter-bash.wasm'))
    const instance = new Parser()
    instance.setLanguage(bash)
    return instance as unknown as BashParser
  })()
  return parserPromise
}

function expandPath(token: string): string | undefined {
  const bare = token.replace(/^['"]|['"]$/g, '')
  if (bare.startsWith('~/')) return path.join(homedir(), bare.slice(2))
  if (bare === '~') return homedir()
  if (bare.startsWith('$HOME/')) return path.join(homedir(), bare.slice(6))
  if (path.isAbsolute(bare)) return bare
  return undefined
}

function outsideWorktree(target: string, agent: unknown): boolean {
  const rel = path.relative(worktree(agent), target)
  return rel.startsWith('..') || path.isAbsolute(rel)
}

/** Split a command into per-simple-command patterns and external dirs. */
async function scanCommand(command: string, agent: unknown): Promise<Scan> {
  const scan: Scan = { dirs: new Set(), patterns: new Set(), always: new Set() }
  const tree = (await parser()).parse(command)
  const commands = tree?.rootNode.descendantsOfType('command') ?? []
  const nodes = commands.length > 0 ? commands : [{ text: command } as BashNode]
  for (const node of nodes) {
    const text = node.text.trim()
    if (text.length === 0) continue
    const tokens = text.split(/\s+/)
    const cmd = tokens[0]
    if (cmd !== undefined && FILE_COMMANDS.has(cmd)) {
      for (const token of tokens.slice(1)) {
        if (token.startsWith('-')) continue
        const resolved = expandPath(token)
        if (resolved === undefined || !outsideWorktree(resolved, agent)) continue
        scan.dirs.add(resolved.endsWith('/') ? resolved.slice(0, -1) : path.dirname(resolved))
      }
    }
    if (cmd !== undefined && CWD_ONLY.has(cmd)) continue
    scan.patterns.add(text)
    scan.always.add(`${arityPrefix(tokens).join(' ')} *`)
  }
  return scan
}

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output
  const half = Math.floor(MAX_OUTPUT_CHARS / 2)
  return `${output.slice(0, half)}\n\n(… output truncated …)\n\n${output.slice(-half)}`
}

export const name = 'tool-bash'
export const inject = ['tools', 'permission']

/**
 * Register the bash tool into the stock registry.
 * @param ctx - plugin context carrying `tools` and `permission`.
 */
export function apply(ctx: Context): void {
  const permission: PermissionService = ctx.permission

  ctx.tools.register(defineTool({
    name: 'bash',
    description:
      'Run a bash command in the working directory and return its combined output. '
      + `Timeout defaults to ${DEFAULT_TIMEOUT_MS / 1000}s (max ${MAX_TIMEOUT_MS / 1000}s).`,
    parameters: {
      command: { type: 'string', required: true, description: 'The command to execute.' },
      timeout: { type: 'number', description: 'Timeout in milliseconds.' },
      description: { type: 'string', description: 'One line describing what this command does.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          output: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.output }],
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const scan = await scanCommand(args.command, exec.agent)
      if (scan.dirs.size > 0) {
        const globs = [...scan.dirs].map(dir => path.join(dir, '*'))
        await permission.ask({
          permission: 'external_directory',
          patterns: globs,
          always: globs,
          metadata: { command: args.command, directories: [...scan.dirs] },
          agent: exec.agent,
        })
      }
      if (scan.patterns.size > 0) {
        await permission.ask({
          permission: 'bash',
          patterns: [...scan.patterns],
          always: [...scan.always],
          metadata: { command: args.command },
          agent: exec.agent,
        })
      }

      const timeoutMs = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn('/bin/bash', ['-c', args.command], {
          cwd: worktree(exec.agent),
          env: process.env,
        })
        let combined = ''
        let timedOut = false
        const timer = setTimeout(() => {
          timedOut = true
          child.kill('SIGKILL')
        }, timeoutMs)
        const onAbort = (): void => {
          child.kill('SIGKILL')
        }
        exec.signal?.addEventListener('abort', onAbort, { once: true })
        child.stdout.on('data', (chunk: Buffer) => {
          combined += chunk.toString()
        })
        child.stderr.on('data', (chunk: Buffer) => {
          combined += chunk.toString()
        })
        child.on('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          exec.signal?.removeEventListener('abort', onAbort)
          let result = truncate(combined)
          if (timedOut) result += `\n(command timed out after ${timeoutMs}ms)`
          else if (code !== 0) result += `\n(exit code ${code})`
          resolve(result.length === 0 ? '(no output)' : result)
        })
      })
      return { output }
    },
  }))
}
