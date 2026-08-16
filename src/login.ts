#!/usr/bin/env node
/**
 * Terminal credential setup for the pi-ai LLM layer.
 *
 * Runs pi-ai's provider-owned login flows against the same auth.json the
 * harness service reads, so a login here is immediately live in the harness.
 * OAuth flows print their authorization URL (and try to open the browser);
 * api_key flows prompt for the key and store it.
 *
 *   dsh-llm-pi-login <provider>            # OAuth when the provider has it
 *   dsh-llm-pi-login <provider> --api-key  # force api_key storage
 *   dsh-llm-pi-login <provider> --logout
 *   dsh-llm-pi-login --list
 *
 * Uses `$DSH_HOME` (falling back to `~/.dsh`) exactly like the harness, so
 * point it at the same home the profile runs with.
 */

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { createModels } from '@earendil-works/pi-ai'
import type { AuthInteraction } from '@earendil-works/pi-ai'
import { builtinProviders } from '@earendil-works/pi-ai/providers/all'
import { FileCredentialStore, fallbackAuthPath } from './store.ts'

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(command, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  const flags = new Set(args.filter(arg => arg.startsWith('--')))
  const provider = args.find(arg => !arg.startsWith('--'))
  const authPath = fallbackAuthPath()
  const store = new FileCredentialStore(authPath)

  if (flags.has('--list')) {
    const stored = await store.list()
    if (stored.length === 0) {
      console.log(`no credentials stored at ${authPath}`)
    } else {
      for (const entry of stored) console.log(`${entry.providerId}  (${entry.type})`)
    }
    return 0
  }

  if (provider === undefined) {
    console.error('usage: dsh-llm-pi-login <provider> [--api-key | --logout] | --list')
    console.error('providers with OAuth: '
      + builtinProviders().filter(p => p.auth.oauth !== undefined).map(p => p.id).join(', '))
    return 2
  }

  if (flags.has('--logout')) {
    await store.delete(provider)
    console.log(`removed credential for ${provider}`)
    return 0
  }

  const models = createModels({ credentials: store })
  for (const builtin of builtinProviders()) models.setProvider(builtin)
  const target = models.getProvider(provider)
  if (target === undefined) {
    console.error(`unknown provider "${provider}"; known: ${builtinProviders().map(p => p.id).join(', ')}`)
    return 2
  }
  const type = flags.has('--api-key') || target.auth.oauth === undefined ? 'api_key' : 'oauth'
  if (type === 'api_key' && target.auth.apiKey?.login === undefined) {
    console.error(`provider "${provider}" has no interactive api_key setup (ambient/env credentials only)`)
    return 2
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const interaction: AuthInteraction = {
    prompt: async (prompt) => {
      switch (prompt.type) {
        case 'select': {
          console.log(prompt.message)
          for (const option of prompt.options) {
            console.log(`  ${option.id}  ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`)
          }
          return rl.question('choice: ')
        }
        case 'secret':
          // Plain readline echoes input; acceptable for a scratch CLI.
          return rl.question(`${prompt.message}: `)
        default:
          return rl.question(`${prompt.message}: `)
      }
    },
    notify: (event) => {
      switch (event.type) {
        case 'auth_url':
          console.log(`\nopen to authorize:\n  ${event.url}`)
          if (event.instructions !== undefined) console.log(event.instructions)
          openBrowser(event.url)
          break
        case 'device_code':
          console.log(`\ngo to ${event.verificationUri} and enter code: ${event.userCode}`)
          break
        case 'info':
          console.log(event.message)
          for (const link of event.links ?? []) console.log(`  ${link.label ?? ''} ${link.url}`)
          break
        case 'progress':
          console.log(event.message)
          break
      }
    },
  }

  try {
    const credential = await models.login(provider, type, interaction)
    console.log(`\nstored ${credential.type} credential for ${provider} in ${authPath}`)
    return 0
  } finally {
    rl.close()
  }
}

main().then(
  code => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  },
)
