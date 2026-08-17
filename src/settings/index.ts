/**
 * settings-bridge — serves `ctx.settings` to the desktop over `ctx.bridge`.
 *
 * The harness already owns a settings registry: every row that wants a
 * user-editable section registers a namespace with a schema, a current value,
 * a revision, and whether a change applies live or needs a restart. This
 * plugin adds no store and no schema of its own — it hands that description to
 * the client and writes accepted edits back, so a settings window is generated
 * from whatever the running tree happens to expose rather than hardcoded
 * against it.
 *
 * Client → server:
 *   {type:'settings_describe'}                      the sections and their schemas
 *   {type:'settings_update', ns, section, revision}  write one section whole
 *
 * Server → client:
 *   {type:'settings', sections}                     always the full picture
 *   {type:'settings_rejected', ns, message}         the write failed; sections unchanged
 *
 * A write REPLACES the section rather than merging into it. The window renders
 * a whole section and reads a whole section back, and a merge can only ever
 * add or change keys — under one, a removed route would come back and a
 * renamed one would exist twice.
 *
 * Writes carry the revision the client rendered. A section edited elsewhere in
 * the meantime rejects rather than silently overwriting, and the reply carries
 * the current sections so the window can repaint and the user can retry.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { BridgeSend } from '../bridge/index.ts'

/** One editable section, as the settings registry describes it. */
interface SettingsDescriptor {
  ns: string
  schema: unknown
  value: unknown
  /** The registrant's composition layer — here, the profile row. */
  base?: unknown
  revision: number
  applies: 'live' | 'restart'
}

interface SettingsRegistry {
  describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]
  replace(ns: string, section: object, expectedRevision?: number): Promise<void>
}

interface BridgeRouter {
  handle(type: string, handler: (message: Record<string, unknown>, send: BridgeSend) => void | Promise<void>): () => void
}

export const name = 'settings-bridge'
export const inject = ['bridge', 'settings']

/**
 * Register the settings message types on the bridge.
 * @param ctx - plugin context carrying `bridge` and `settings`.
 */
export function apply(ctx: Context): void {
  const settings = ctx.get('settings') as SettingsRegistry
  const bridge = ctx.get('bridge') as BridgeRouter

  /**
   * The whole picture, every time: sections are few and a client that always
   * repaints from one shape cannot drift from the harness.
   * @returns the sections message.
   */
  const sections = (): Record<string, unknown> => ({
    type: 'settings',
    // A wire surface must redact: any field a namespace marks secret is
    // stripped here rather than shipped to a client.
    sections: settings.describe({ redactSecrets: true }).map(descriptor => ({
      ns: descriptor.ns,
      // Schemastery serializes to a {uid, refs} graph the client can resolve.
      schema: JSON.parse(JSON.stringify(descriptor.schema)) as unknown,
      value: descriptor.value,
      // The layer beneath the user's. A client needs it to show which entries
      // come from the profile and therefore cannot be renamed or removed here.
      base: descriptor.base,
      revision: descriptor.revision,
      applies: descriptor.applies,
    })),
  })

  ctx.effect(() => bridge.handle('settings_describe', (_message, send) => {
    send(sections())
  }), 'settings-bridge: describe')

  ctx.effect(() => bridge.handle('settings_update', async (message, send) => {
    const ns = message['ns']
    const section = message['section']
    if (typeof ns !== 'string' || ns.length === 0) {
      send({ type: 'error', message: 'settings_update needs a namespace' })
      return
    }
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      send({ type: 'error', message: 'settings_update needs an object section' })
      return
    }
    const revision = typeof message['revision'] === 'number' ? message['revision'] : undefined
    try {
      await settings.replace(ns, section as object, revision)
    } catch (error: unknown) {
      // A stale revision or a section the owner refuses is the user's problem
      // to resolve, not a transport fault: report it and repaint.
      send({
        type: 'settings_rejected',
        ns,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    send(sections())
  }), 'settings-bridge: update')
}
