/**
 * tool-fs — opencode-style file tools on plain node fs: read, write, edit,
 * glob, grep. Every action passes the permission gate first; paths outside
 * the worktree additionally need the external_directory consent. No fs
 * abstraction, no jail — the gate is the boundary (ported from sst/opencode,
 * MIT; LSP/formatter/watcher integrations dropped).
 *
 * glob and grep shell out to ripgrep (`rg`), which must be on PATH.
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createTwoFilesPatch } from 'diff'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PermissionService } from '../permission/index.ts'
import { assertExternalDirectory, relPattern, resolvePath, trimDiff, worktree } from './common.ts'
import { replaceContent } from './replace.ts'

const MAX_READ_LINES = 2000
const MAX_LINE_LENGTH = 2000
const MAX_SEARCH_RESULTS = 100

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    output: { type: 'string', required: true },
  },
} as const

const RENDER = (_args: unknown, value: { output: string }): { type: 'text'; text: string }[] =>
  [{ type: 'text', text: value.output }]

function run(command: string, args: string[], cwd: string, signal?: AbortSignal): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, ...signal === undefined ? {} : { signal } })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', code => resolve({ stdout, code }))
  })
}

export const name = 'tool-fs'
export const inject = ['tools', 'permission']

/**
 * Register the file tools into the stock registry.
 * @param ctx - plugin context carrying `tools` and `permission`.
 */
export function apply(ctx: Context): void {
  const permission: PermissionService = ctx.permission

  ctx.tools.register(defineTool({
    name: 'read',
    description:
      'Read a file. Returns the content with line numbers. Use offset/limit for large files. '
      + `At most ${MAX_READ_LINES} lines per call.`,
    parameters: {
      filePath: { type: 'string', required: true, description: 'Absolute or worktree-relative path.' },
      offset: { type: 'number', description: '1-based line to start from.' },
      limit: { type: 'number', description: 'Maximum lines to return.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: RENDER },
    async execute(args, exec) {
      const filepath = resolvePath(args.filePath)
      await assertExternalDirectory(permission, filepath, exec.agent)
      await permission.ask({
        permission: 'read',
        patterns: [relPattern(filepath)],
        always: ['*'],
        agent: exec.agent,
      })
      const text = await readFile(filepath, 'utf8')
      const lines = text.split('\n')
      const offset = Math.max(1, args.offset ?? 1)
      const limit = Math.min(args.limit ?? MAX_READ_LINES, MAX_READ_LINES)
      const slice = lines.slice(offset - 1, offset - 1 + limit)
      const numbered = slice
        .map((line, index) => {
          const cut = line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line
          return `${String(offset + index).padStart(5, '0')}| ${cut}`
        })
        .join('\n')
      const truncated = offset - 1 + limit < lines.length
        ? `\n\n(File has ${lines.length} lines; showing ${offset}-${offset + slice.length - 1}.)`
        : ''
      return { output: `<file>\n${numbered}${truncated}\n</file>` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'write',
    description: 'Write a file, creating parent directories. Overwrites existing content.',
    parameters: {
      filePath: { type: 'string', required: true, description: 'Absolute or worktree-relative path.' },
      content: { type: 'string', required: true, description: 'The full new file content.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: RENDER },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const filepath = resolvePath(args.filePath)
      await assertExternalDirectory(permission, filepath, exec.agent)
      const before = await readFile(filepath, 'utf8').catch(() => '')
      const diff = trimDiff(createTwoFilesPatch(filepath, filepath, before, args.content))
      await permission.ask({
        permission: 'edit',
        patterns: [relPattern(filepath)],
        always: ['*'],
        metadata: { filepath, diff },
        agent: exec.agent,
      })
      await mkdir(path.dirname(filepath), { recursive: true })
      await writeFile(filepath, args.content)
      return { output: `Wrote ${relPattern(filepath)}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'edit',
    description:
      'Replace one occurrence of oldString with newString in a file. oldString must match '
      + 'uniquely (whitespace-tolerant); set replaceAll to replace every occurrence.',
    parameters: {
      filePath: { type: 'string', required: true, description: 'Absolute or worktree-relative path.' },
      oldString: { type: 'string', required: true, description: 'Text to replace, with enough context to be unique.' },
      newString: { type: 'string', required: true, description: 'Replacement text.' },
      replaceAll: { type: 'boolean', description: 'Replace every occurrence.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: RENDER },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const filepath = resolvePath(args.filePath)
      await assertExternalDirectory(permission, filepath, exec.agent)
      const before = await readFile(filepath, 'utf8')
      const after = replaceContent(before, args.oldString, args.newString, args.replaceAll ?? false)
      const diff = trimDiff(createTwoFilesPatch(filepath, filepath, before, after))
      await permission.ask({
        permission: 'edit',
        patterns: [relPattern(filepath)],
        always: ['*'],
        metadata: { filepath, diff },
        agent: exec.agent,
      })
      await writeFile(filepath, after)
      return { output: `Edited ${relPattern(filepath)}\n${diff}` }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'glob',
    description: 'Find files by glob pattern (e.g. "**/*.ts"), newest first, max 100 results.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'The glob pattern.' },
      path: { type: 'string', description: 'Directory to search; defaults to the worktree.' },
    },
    output: { schema: OUTPUT_SCHEMA, render: RENDER },
    async execute(args, exec) {
      const search = args.path === undefined ? worktree() : resolvePath(args.path)
      await permission.ask({
        permission: 'glob',
        patterns: [args.pattern],
        always: ['*'],
        agent: exec.agent,
      })
      await assertExternalDirectory(permission, search, exec.agent, 'directory')
      const result = await run('rg', ['--files', '--glob', args.pattern], search, exec.signal)
      const files = result.stdout.split('\n').filter(line => line.length > 0)
      const shown = files.slice(0, MAX_SEARCH_RESULTS)
      const suffix = files.length > MAX_SEARCH_RESULTS
        ? `\n(Truncated to first ${MAX_SEARCH_RESULTS} of ${files.length} results.)`
        : ''
      return { output: shown.length === 0 ? 'No files found' : shown.join('\n') + suffix }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'grep',
    description: 'Search file contents with a regex (ripgrep). Returns matching lines with file:line.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'The regex to search for.' },
      path: { type: 'string', description: 'Directory or file to search; defaults to the worktree.' },
      include: { type: 'string', description: 'File glob to restrict the search (e.g. "*.ts").' },
    },
    output: { schema: OUTPUT_SCHEMA, render: RENDER },
    async execute(args, exec) {
      const search = args.path === undefined ? worktree() : resolvePath(args.path)
      await permission.ask({
        permission: 'grep',
        patterns: [args.pattern],
        always: ['*'],
        agent: exec.agent,
      })
      const info = await stat(search).catch(() => undefined)
      await assertExternalDirectory(permission, search, exec.agent, info?.isDirectory() ? 'directory' : 'file')
      const rgArgs = ['-n', '--no-heading', '--max-count', '10']
      if (args.include !== undefined) rgArgs.push('--glob', args.include)
      rgArgs.push('--', args.pattern)
      const result = await run('rg', rgArgs, search, exec.signal)
      const lines = result.stdout.split('\n').filter(line => line.length > 0)
      const shown = lines.slice(0, MAX_SEARCH_RESULTS)
      const suffix = lines.length > MAX_SEARCH_RESULTS ? `\n(Truncated to ${MAX_SEARCH_RESULTS} lines.)` : ''
      return { output: shown.length === 0 ? 'No matches found' : shown.join('\n') + suffix }
    },
  }))
}
