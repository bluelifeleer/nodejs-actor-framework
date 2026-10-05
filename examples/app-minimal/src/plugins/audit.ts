import { definePlugin } from '@actor/app';

/**
 * 用户自定义插件：和内置能力走完全相同的机制（没有特权通道）。
 * 它有自己的配置 schema —— 会被合并进应用配置的 `plugins.audit.*`，
 * 因此可以用环境变量覆盖：APP_PLUGINS__AUDIT__LEVEL=warn
 */
export const auditPlugin = definePlugin({
  name: 'audit',
  config: {
    level: { type: 'string', default: 'info', enum: ['info', 'warn'] },
  },
  setup(app, config) {
    console.log(
      `[plugin:audit] level=${String(config.level)} greeting=${app.config.get<string>('greeting')}`,
    );
  },
  teardown() {
    console.log('[plugin:audit] teardown');
  },
});
