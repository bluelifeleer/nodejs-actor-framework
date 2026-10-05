# HTTP 应用示例（app-web）

演示 `@actor/app` + `@actor/web`：**配置 → 路由 → 无状态控制器 → Actor**，以及优雅停止。

```
config/default.ts          配置（http 插件自己的配置在 plugins.http.*，可被环境变量覆盖）
src/actors/room.ts         状态留在 Actor（普通类，无继承）
src/controllers/index.ts   控制器：函数式 / body 输入 / 路径+查询参数 / 每请求超时
src/routes.ts              路由：**语法糖** routes({ prefix: '/api', GET: {...}, children: [...] })
                           嵌套子路由器 prefix: '/rooms' 贡献 /api/rooms/:id
src/module.ts              defineModule({ actors, routes })
src/app.ts                 defineApp({ config, modules, plugins: [http, metrics] })
main.ts                    启动 + SIGTERM 优雅退出
```

```bash
cd examples/app-web
APP_PLUGINS__HTTP__PORT=0 node main.ts      # 0 = 随机端口，启动后打印真实地址
curl -i localhost:PORT/api/health
curl -i -X POST localhost:PORT/api/join -H 'content-type: application/json' -d '{"playerId":"alice"}'
curl -i 'localhost:PORT/api/rooms/1?verbose=true'   # 由嵌套子路由器贡献
curl -i localhost:PORT/api/slow                     # 504（ask 超时映射）
curl -I localhost:PORT/api/rooms/1                  # HEAD 回退到 GET，无 body
curl -i -X OPTIONS localhost:PORT/api/rooms/1       # 204 + Allow
```

错误约定见 `docs/design/m2-web-layer.md` §4：400 输入校验（一次报全部问题）、404 未知路由、
405 方法不匹配（带 `Allow`）、504 ask 超时、500 未捕获异常（响应不含内部细节）。
