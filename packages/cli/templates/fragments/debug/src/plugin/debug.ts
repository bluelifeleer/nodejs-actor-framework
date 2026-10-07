import { debugPlugin } from '@actor/web';

/**
 * 诊断能力（`--web-plugins debug`）：`/__debug/{routes,health,config}`。
 *
 * **默认关闭**（不贡献任何路由）。要开：`APP_DEBUG=1` + `APP_DEBUG_TOKEN`（至少 16 字符）；
 * 生产环境还需要显式 `allowInProduction` —— 框架默认拒绝在生产开诊断路由。
 */
export default debugPlugin({
  enabled: process.env['APP_DEBUG'] === '1',
  ...(process.env['APP_DEBUG_TOKEN'] === undefined ? {} : { token: process.env['APP_DEBUG_TOKEN'] }),
  ...(process.env['APP_DEBUG_ALLOW_PRODUCTION'] === '1' ? { allowInProduction: true } : {}),
});
