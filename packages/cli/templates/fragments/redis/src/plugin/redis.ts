import { redisAdapter } from '@actor/redis';
import { resourceAdapter } from '@actor/resource';

/**
 * Redis 能力（`--with redis`）：注册成 `cache` 服务，控制器里 `ctx.get('cache')`。
 *
 * **没配 `APP_REDIS_URL` 就不挂**（返回空数组）—— 框架对资源是"连不上就启动失败"的，
 * 所以本地/CI 没 Redis 时不该把整个应用拖下水。配了之后连接失败**会**让启动失败（这是刻意的：不静默降级）。
 */
const url = process.env['APP_REDIS_URL'];

export default url === undefined || url === ''
  ? []
  : [resourceAdapter(redisAdapter(), { name: 'cache', connection: { url } })];
