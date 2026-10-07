import { authPlugin } from '@actor/web';

/**
 * 鉴权能力（`--web-plugins auth`）。
 *
 * **没配密钥就不挂**（返回空数组）——很多场景本来就没有登录体系，脚手架不该逼你配一个假的。
 * 配了 `APP_JWT_SECRET`（HMAC 密钥，至少 32 字节）之后：
 *   - 带 `Authorization: Bearer <jwt>` 的请求会校验并把用户放进 `ctx.user`；
 *   - 哪些路由要求鉴权由控制器声明：`defineController({ auth: { required: true } })`。
 */
const secret = process.env['APP_JWT_SECRET'];

export default secret === undefined || secret === ''
  ? []
  : [
      authPlugin({
        keys: [{ algorithm: 'HS256', key: secret }],
        ...(process.env['APP_JWT_ISSUER'] === undefined ? {} : { issuer: process.env['APP_JWT_ISSUER'] }),
      }),
    ];
