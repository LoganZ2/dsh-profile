/**
 * Shared plumbing for the opencode-style fs tools: worktree resolution,
 * the external-directory consent gate, and diff rendering for edit approvals.
 * Plain node fs throughout — the boundary is the permission gate, not an fs
 * abstraction (the opencode trade).
 */

import path from 'node:path'
import type { PermissionService } from '../permission/index.ts'

/** The project boundary: the process working directory at mount. */
export function worktree(): string {
  return process.cwd()
}

/** Resolve a model-supplied path against the worktree. */
export function resolvePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(worktree(), filePath)
}

/** The pattern a path contributes to permission asks: worktree-relative. */
export function relPattern(filepath: string): string {
  return path.relative(worktree(), filepath)
}

function contained(target: string): boolean {
  const rel = path.relative(worktree(), path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Consent gate for paths outside the project: one ask per parent directory,
 * with a `dir/*` glob offered as the "always" grant.
 * @param permission - the mounted permission service.
 * @param target - absolute path the tool wants to touch.
 * @param agent - the asking agent, for plan-overlay resolution.
 * @param kind - whether the target itself is the directory.
 */
export async function assertExternalDirectory(
  permission: PermissionService,
  target: string,
  agent: unknown,
  kind: 'file' | 'directory' = 'file',
): Promise<void> {
  if (contained(target)) return
  const dir = kind === 'directory' ? path.resolve(target) : path.dirname(path.resolve(target))
  const glob = path.join(dir, '*')
  await permission.ask({
    permission: 'external_directory',
    patterns: [glob],
    always: [glob],
    metadata: { filepath: target, parentDir: dir },
    agent,
  })
}

/** Trim a unified diff's file headers down to the essential hunk view. */
export function trimDiff(diff: string): string {
  const lines = diff.split('\n')
  const kept = lines.filter(line => !line.startsWith('===') && !line.startsWith('---') && !line.startsWith('+++'))
  return kept.join('\n').trimStart()
}
