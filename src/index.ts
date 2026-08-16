/**
 * A first DeepSeek Harness plugin, in TypeScript.
 *
 * It does both halves of the dsh extension model:
 *   1. CONSUMER  — registers a model-facing tool into the existing `ctx.tools`.
 *   2. PROVIDER  — claims a brand-new service name, `ctx.shout`, that nothing
 *                  had pre-registered.
 *
 * @module dsh-plugin-shout
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

/**
 * Teach TypeScript that `ctx.shout` exists. This is declaration merging: it
 * adds a typed property to every `Context` in the program and emits no runtime
 * code at all. Claiming the name at runtime is `super(ctx, 'shout')` below.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    shout: ShoutService
  }
}

/** Deployment options for the shout plugin. */
export interface Config {
  /** How many exclamation marks to append. */
  intensity?: number
}

/**
 * The service behind `ctx.shout`. Any other plugin can now call
 * `ctx.shout.render('hi')` after declaring `inject: ['shout']`.
 */
export class ShoutService extends Service {
  private readonly intensity: number

  constructor(ctx: Context, config: Config = {}) {
    // This one line is what claims the name `shout` on the context.
    super(ctx, 'shout')
    this.intensity = Math.max(0, config.intensity ?? 3)
  }

  /**
   * Uppercase text and append the configured emphasis.
   * @param text - the text to shout.
   * @returns the shouted text.
   */
  render(text: string): string {
    return text.toUpperCase() + '!'.repeat(this.intensity)
  }
}

/** The plugin's name, shown in Cordis diagnostics. */
export const name = 'shout'

/** Wait for the tool registry before mounting. */
export const inject = ['tools']

/**
 * Mount the service and register the model-facing tool.
 * @param ctx - the context this plugin was mounted into.
 * @param config - deployment configuration from the profile's YAML row.
 */
export function apply(ctx: Context, config: Config = {}): void {
  // Providing a service: `ctx.shout` exists from here until this plugin unloads.
  new ShoutService(ctx, config)

  // Consuming a service: add a tool to the registry someone else owns.
  ctx.tools.register(defineTool({
    name: 'shout',
    description:
      'Uppercase a short piece of text and add emphasis. A demonstration tool '
      + 'contributed by a user-installed dsh plugin.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The text to shout.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          shouted: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.shouted }],
    },
    execute(args) {
      return Promise.resolve({ shouted: ctx.shout.render(args.text) })
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Shout',
      kind: 'other',
      rawInput: args.text,
    }),
  }))
}
