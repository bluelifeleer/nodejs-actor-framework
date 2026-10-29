import { OpsAgent, type OpsAgentOptions } from './agent.ts';

export interface OpsAgentPluginOptions extends OpsAgentOptions {
  /** Override the plugin name (rarely needed). */
  readonly name?: string;
}

/**
 * Application plugin wrapper. It is structurally compatible with `@actor/app`
 * PluginSpec, so the package does not depend on the app layer at runtime.
 */
export function opsAgentPlugin(options: OpsAgentPluginOptions): {
  name: string;
  onReady(app: { kernel?: unknown; get?<T>(name: string): T }): void | Promise<void>;
  onStopping(): void | Promise<void>;
} {
  let agent: OpsAgent | undefined;
  return {
    name: options.name ?? 'ops-agent',
    onReady(app) {
      agent = new OpsAgent({
        ...options,
        ...(app.kernel === undefined ? {} : { system: app.kernel }),
        application: app,
      });
      agent.start();
    },
    onStopping() {
      agent?.stop();
      agent = undefined;
    },
  };
}
