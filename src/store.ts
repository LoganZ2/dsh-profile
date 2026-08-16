/**
 * File-backed pi-ai credential store: one auth.json under the harness home,
 * one type-tagged credential per provider id. `modify` is the only write
 * path, serialized through a promise chain, so OAuth refresh (which pi-ai
 * runs inside `modify`) cannot double-refresh a rotated token in-process.
 */

import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'

/**
 * Resolve the harness home the same way the launcher does: `$DSH_HOME` when
 * set and non-blank, `~/.dsh` otherwise. The service prefers the boot-provided
 * `dshHomePath` service; this fallback keeps the login CLI (which runs without
 * a harness context) on the same file.
 */
export function fallbackAuthPath(env: Record<string, string | undefined> = process.env): string {
  const fromEnv = env['DSH_HOME']
  const home = fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh')
  return resolve(home, 'pi-ai', 'auth.json')
}

export class FileCredentialStore implements CredentialStore {
  /** Serializes every read-modify-write against this store instance. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string) {}

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task)
    this.chain = next.catch(() => {})
    return next
  }

  private async load(): Promise<Record<string, Credential>> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as Record<string, Credential>
    } catch (error: unknown) {
      if ((error as { code?: string }).code === 'ENOENT') return {}
      throw error
    }
  }

  /** Atomic replace with owner-only permissions; the file holds live tokens. */
  private async save(all: Record<string, Credential>): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const tmp = `${this.path}.${process.pid}.tmp`
    await writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, this.path)
  }

  read(providerId: string): Promise<Credential | undefined> {
    return this.enqueue(async () => (await this.load())[providerId])
  }

  list(): Promise<readonly CredentialInfo[]> {
    return this.enqueue(async () =>
      Object.entries(await this.load()).map(([providerId, credential]) => ({
        providerId,
        type: credential.type,
      })))
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const all = await this.load()
      const current = all[providerId]
      const next = await fn(current)
      // undefined leaves the entry unchanged, per the CredentialStore contract.
      if (next === undefined) return current
      all[providerId] = next
      await this.save(all)
      return next
    })
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(async () => {
      const all = await this.load()
      if (!(providerId in all)) return
      delete all[providerId]
      if (Object.keys(all).length === 0) {
        await unlink(this.path).catch(() => {})
        return
      }
      await this.save(all)
    })
  }
}
