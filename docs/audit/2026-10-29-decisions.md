# 剩余 4 项取舍记录（2026-10-29）

> 关联审查：[2026-10-29-review.md](./2026-10-29-review.md)。  
> 结论：**修 2 项（JWT、契约套件）、接受 2 项（N9、N10）**。接受项不是“忘了”，而是明确边界；触发条件变化时按下面“复审触发条件”重新评估。

## 背景

这 4 项都不是“功能缺失”，而是边界与默认值：

- `N9`：入站帧的 `senderHost/senderPort` 可让本节点 dial 任意地址（SSRF 面）。
- `N10`：跨节点转发没有 hop 计数，错误发现/恶意节点可能制造转发环。
- 契约套件：生产入口 re-export 了 `import 'node:test'` 的测试工具。
- JWT：不传 `expiresInSec` 时 token 没有 `exp`，默认永久有效。

## D1：JWT 默认要求 `exp`（已修）

**决定**

- `authPlugin` 默认 `requireExp: true`：没有 `exp` 的 token 一律 401，服务端日志 reason=`missing_exp`。
- `authPlugin({ requireExp: false })` 只在迁移期/内部工具显式关闭。
- 低层 `verifyJwt` 默认仍为 `false`，避免破坏既有调用方；需要严格校验时显式传 `requireExp: true`。

**理由**

安全默认应偏向“拒绝永久 token”。修复成本低，对单机/小公司用户也有直接价值。

**代价**

不带 `exp` 的旧 token 会被拒绝；迁移办法是重新签发带 `expiresInSec` 的 token，或临时 `requireExp: false`。

**测试**

`packages/web/test/auth.test.ts`：`auth plugin: 默认拒绝没有 exp 的 token；requireExp:false 才放行（回归）`。

## D2：契约套件的 `node:test` 惰性加载（已修）

**决定**

`run*Contract` 仍随包发布，但 `node:test` 不再静态 import；只有真正调用契约函数时才 `require('node:test')`。

**理由**

保持既有 import 路径不变，同时保证：

- 应用启动/生产 import 不会加载测试运行器；
- 打包到 serverless/边缘时不会因 `node:test` 静态引用报错；
- 用户仍然可以 `import { runXContract } from '@actor/x'` 自证合规。

**代价**

契约函数第一次调用时多一次模块加载；不影响测试结果。

**测试**

- 契约套件自身的集成测试全部通过；
- `test/unit-runtime-imports.test.js` 静态扫描：运行时源码不得出现 `import ... from 'node:test'`。

## D3：N9 `senderHost` SSRF（接受）

**决定**

本轮不改。保留“集群成员必须可信”的假设，并在集群文档/启动路径强调非回环必须 TLS。

**理由**

- 默认路径是单机/SQLite；集群是进阶能力。
- 正确修复需要区分“观察到的 socket 地址”和“帧里声称的地址”，并处理 NAT/端口映射；1–2 天，且容易引入集群连通性回归。
- 在 mTLS + 内网前提下，攻击者需要集群证书，风险可控。

**复审触发条件**

- gateway 暴露到公网；
- 多租户集群 / 不受信任节点；
- 出现“节点主动连接异常地址”的告警或事故。

## D4：N10 网关转发环路（接受）

**决定**

本轮不改。跨节点转发保持现状，不增加 hop 计数。

**理由**

- 单机无感；触发需要集群 + 跨节点转发 + 错误发现/恶意节点。
- 修复需要改 protobuf 字段、转发路径与兼容逻辑，收益只在集群场景。
- 当前集群默认拓扑是“访问层 → 游戏节点”的一跳，环路需要额外条件。

**复审触发条件**

- 集群成为默认/主推能力；
- 出现消息风暴、CPU 异常、重复转发日志；
- 引入多跳路由/服务网格式转发。

## 总表

| 项 | 决定 | 成本 | 复审触发 |
|---|---|---|---|
| JWT `requireExp` | 修 | 2–4h | — |
| 契约套件 `node:test` | 修（惰性加载） | 0.5d | — |
| N9 senderHost SSRF | 接受 | 1–2d | 公网 gateway / 多租户 |
| N10 转发环路 | 接受 | 0.5–1d | 集群默认 / 多跳 |

## 验证

```text
npm test          → 全绿
npm run typecheck → 0 errors
npm run docs:build→ 通过
```
