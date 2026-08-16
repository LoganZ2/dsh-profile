/**
 * agent-pi — the loop plugin. pi-agent-core's `Agent` is the engine; every
 * capability arrives from a sibling plugin through the context:
 *
 *   - the model runtime is `ctx.llm.streamFn()` — this plugin never sees a
 *     provider, credential, or transport
 *   - the model descriptor comes from `ctx.llm.piModel(provider, model)`
 *   - the task comes from the launcher's `cmdlineArgs`; the exit goes through
 *     the launcher's `appExit`
 *
 * v1 is deliberately a bare loop: no tools, no session persistence. Those
 * arrive as their own plugins feeding the same Agent, not as harness bundles.
 *
 * @module dsh-bundle-loganz2/agent
 */

import type { Context } from '@deepseek-ai/cordis'
import { Agent } from '@earendil-works/pi-agent-core'

/** Deployment configuration: which route/model drives the loop. */
export interface Config {
  /** Provider route configured in the llm layer. */
  provider: string
  /** Model id on that route. */
  model: string
  /** System prompt for the run. */
  systemPrompt?: string
}

export const name = 'agent-pi'

/** The model runtime is the one hard dependency. */
export const inject = ['llm']

/**
 * Mount the one-shot runner: read the task, drive the loop, stream text to
 * stdout, exit with the run's outcome.
 * @param ctx - plugin context carrying the llm seam and launcher services.
 * @param config - route, model, and prompt for the run.
 */
export function apply(ctx: Context, config: Config): void {
  const args = ctx.get('cmdlineArgs') as { get(): readonly string[] } | undefined
  const exit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (args === undefined || exit === undefined) {
    throw new Error('agent-pi: the launcher must provide cmdlineArgs and appExit')
  }
  const task = args.get().join(' ').trim()
  if (task.length === 0) {
    process.stderr.write('agent-pi: no task given; usage: dsh --profile <name> "<task>"\n')
    exit(2)
    return
  }

  void (async (): Promise<void> => {
    try {
      const model = ctx.llm.piModel(config.provider, config.model)
      const agent = new Agent({
        initialState: {
          ...config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt },
          model,
        },
        streamFn: ctx.llm.streamFn(),
      })
      agent.subscribe((event) => {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
          process.stdout.write(event.assistantMessageEvent.delta)
        }
      })
      await agent.prompt(task)
      await agent.waitForIdle()
      process.stdout.write('\n')
      const last = agent.state.messages.at(-1)
      const failed = last !== undefined
        && 'stopReason' in last
        && (last.stopReason === 'error' || last.stopReason === 'aborted')
      if (failed && 'errorMessage' in last && last.errorMessage !== undefined) {
        process.stderr.write(`agent-pi: ${last.errorMessage}\n`)
      }
      exit(failed ? 1 : 0)
    } catch (error: unknown) {
      process.stderr.write(`agent-pi: ${error instanceof Error ? error.message : String(error)}\n`)
      exit(1)
    }
  })()
}
