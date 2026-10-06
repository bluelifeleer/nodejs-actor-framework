import { defineConfig } from '@actor/app';

/**
 * 配置 = 默认值 + 校验规则。环境变量覆盖约定：camelCase → APP_UPPER_SNAKE
 * （例如 port → APP_PORT；嵌套用 __，例如 gateway.url → APP_GATEWAY__URL）。
 */
export default defineConfig({
  dataDir: { type: 'string', default: './data' },
  // HTTP 端口属于**插件**配置：plugins.http.port。所以它由插件贡献 schema，
  // 用 APP_PLUGINS__HTTP__PORT 覆盖即可（在这里再声明一个 port 会是死字段）。
});
