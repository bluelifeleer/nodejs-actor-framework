import { defineConfig } from '@actor/app';

export default defineConfig({
  greeting: { type: 'string', default: 'hello' },
  // 注意：http 插件自己的配置在 plugins.http.* 下（由插件贡献 schema），
  // 因此端口可用 APP_PLUGINS__HTTP__PORT 覆盖，不需要在这里重复声明。
});
