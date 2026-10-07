import { defineConfig } from '@actor/app';

/** 插件自己的配置节是 `plugins.<插件名>.*`（环境变量 APP_PLUGINS__<NAME>__KEY）。 */
export default defineConfig({
  name: { type: 'string', default: 'app-plugin' },
});
