# Actor Framework

Node.js `worker_threads` Actor 框架：OTP 风格监督树、优先级邮箱与背压、重试 + 死信队列、持久化（可插拔后端）、指标与全链路 Trace、Gossip 集群、Pub/Sub、以及对等的 TCP 网关（Protobuf 帧 + 双向 TLS）。

**默认零外部依赖**（仅用 Node 内置模块），要求 **Node.js >= 18**。
唯一可选依赖是 LevelDB 后端所需的 `classic-level`（`optionalDependencies`，缺失时自动跳过，不影响其它功能）。

---

## 快速开始

```bash
node actor-main.js          # 或 npm start
```

启动后监听（默认全部绑定回环地址，端口可用环境变量覆盖）：

```
  node:    <hostname>-7200
  actors:  player_001
  console: telnet 127.0.0.1:8080
  gateway: 127.0.0.1:9000 (codec=proto)
  gossip:  127.0.0.1:7200
  tls:     disabled
  store:   file
  data:    ./data
```

连接调试控制台：

```bash
telnet 127.0.0.1 8080
# 或 nc 127.0.0.1 8080
```

控制台示例（`player_001` 由 `ACTOR_BOOT_ACTORS` 默认创建）：

```
hurt player_001 10 0            # 高优先级扣血 -> OK hp=90 priority=0(HIGH)
getState player_001             # state:{"hp":90}
spawn player_002                # 创建新 Actor（纳入监督树）
pub sub game/notice player_001  # 订阅主题
pub pub game/notice {"msg":"server open"}
metrics dump                    # 真实指标（由 worker 回传到主进程）
sup info                        # 监督树状态、重启次数、熔断状态
crash player_001                # 模拟崩溃 -> 监督树自动重启
kill player_001                 # 主动停止 -> 不会被重启
```

---

## 功能状态

下表是**实测状态**，每一项都有 `test/` 下的自动化用例覆盖（共 177 个用例，`npm test`）：

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Worker 线程隔离 | ✅ | 单 Actor 崩溃不影响其他 Actor，也不会打死主进程 |
| 监督树 | ✅ | `one_for_one` / `rest_for_one` / `one_for_all` 三种策略真实生效 |
| 故障自动重启 | ✅ | worker 异常退出 → `handleChildCrash()` → 按策略重启（`crash` 命令可验证） |
| 熔断保护 | ✅ | 重启强度超限 → 停掉全部子进程并触发 `supervisor_circuit_open`，冷却后自动恢复 |
| 优先级邮箱 | ✅ | HIGH(0) > NORMAL(1) > LOW(2)；非法优先级归一化，不再导致崩溃 |
| 背压 | ✅ | 邮箱有硬上限，超限回 `mailbox_full` 并计入 `dropped`，不入库 |
| 消息重试 + 退避 | ✅ | 逐条重试，指数退避，失败归因到真正失败的那条消息 |
| 死信队列 DLQ | ✅ | 重试耗尽入 DLQ；行级容错解析；文件有上限、自动裁剪最旧记录 |
| 持久化（可插拔） | ✅ | `file`（默认，无依赖）/ `memory`（测试）/ `level`（可选 LevelDB） |
| 持久化语义 | ✅ | 入队 append、终态 ack（**ack 也持久化**）；只有未确认的消息会重放 |
| 日志压缩 | ✅ | 追加式日志 + 死记录占比超阈值时原子重写（compact） |
| 批量消费 | ✅ | 数量阈值 / 超时双触发；可选 `onBatch` 契约，批次失败时逐条兜底 |
| 令牌桶限流 | ✅ | 每 Actor 独立令牌桶；限流时不重排邮箱、不重复计数 |
| 性能指标 | ✅ | worker 增量回传主进程聚合，`metrics dump` 返回真实数据 |
| 全链路 Trace | ✅ | `traceId`/`spanId`/`parentSpanId`，发布=父 span、投递=子 span，跨网关透传，可采样 |
| Gossip 集群 | ✅ | 对等节点互相学习、LWW 版本合并、删除墓碑、静默节点剔除、存活节点保活 |
| 注册中心 | ✅ | 本地 + 远端条目（含网关地址），带 TTL 清理 |
| Pub/Sub | ✅ | 订阅关系经 Gossip 复制，跨节点经网关投递，并行扇出、逐订阅者上报成败 |
| Actor 热更新 | ✅ | 默认关闭；开启后支持箭头函数 `this` 绑定、类型校验，失败不影响运行中的 Actor |
| **网关二进制帧** | ✅ | 长度前缀 + codec 字节；**Protobuf 为默认**，同时兼容 JSON 帧，混合节点互通 |
| **网关/集群 TLS** | ✅ | 双向认证（mTLS），`nodeId` 与证书 CN 绑定，配置错误只禁用监听、绝不降级明文 |
| TCP 网关 | ✅ | 请求/响应关联、连接池、抗超大帧、握手机制 |
| Telnet 调试控制台 | ✅ | 行缓冲、可选 Token 鉴权、输入校验、连接数上限 |
| Monitor 监控 | ✅ | 被监控 Actor 死亡时通知监控者（含 `reason`） |

---

## 目录结构

```
actor-framework/
├── actor-main.js          # 入口：ActorManager、bootstrap、优雅退出
├── actor-worker.js        # Actor 工作线程：邮箱、限流、重试、DLQ、批量、热更新
├── supervisor.js          # OTP 监督树：三种策略 + 熔断
├── config.js              # 集中配置（全部可用环境变量覆盖）
├── telnet-console.js      # Telnet 控制台（鉴权 / 行缓冲 / 命令实现）
├── gateway.js             # 跨节点网关：长度前缀帧 + codec + mTLS + 握手
├── proto.js               # 手写 Protobuf wire codec（零依赖）
├── tls-util.js            # TLS 证书加载与 CN↔nodeId 校验
├── gossip.js              # 集群成员与注册中心复制（LWW + 墓碑 + 心跳）
├── pubsub.js              # 发布订阅（本地 + 跨节点）
├── hot-reload-manager.js  # 热更新协调（默认关闭）
├── message-store.js       # 持久化门面（后端可插拔）
├── stores/
│   ├── index.js           # 后端工厂与配置校验
│   ├── file-store.js      # 默认后端：CRC 帧日志 + 持久 ack + 日志压缩
│   ├── memory-store.js    # 内存后端（测试/临时）
│   ├── level-store.js     # 可选 LevelDB 后端（每 Actor 一个库）
│   ├── crc32.js           # 记录校验
│   └── naming.js          # 防穿越的落盘命名（含旧版迁移）
├── dead-letter-queue.js   # 死信队列（有界、容错）
├── registry.js            # 注册中心
├── token-bucket.js        # 令牌桶
├── metrics.js             # 指标聚合（主进程侧）
├── logger.js              # 30/70 采样日志
├── trace.js               # Trace 上下文
├── actor-proto.proto      # 线协议参考 schema（仅文档）
├── scripts/gen-test-certs.sh
└── test/                  # node:test 测试套件（含 fixtures/tls 测试证书）
```

---

## 传输：帧格式与编解码

网关帧格式（双向一致）：

```
uint32_be bodyLength | uint8 codec | body
codec 0 = JSON      （utf-8 JSON，便于抓包排查）
codec 1 = Protobuf  （默认，见 proto.js 与 actor-proto.proto）
```

- **codec 随帧携带**，因此节点总是同时接受两种编码：`ACTOR_GATEWAY_CODEC` 只决定**发送**用哪种，混合部署（滚动升级、异构客户端）无需协商。
- Protobuf 编解码是**手写**的（varint / length-delimited / 未知字段跳过），因此保持零依赖；未知字段会被跳过，所以后续版本可以安全地新增字段。
- 实测同样载荷下 Protobuf 帧显著小于 JSON（用例 `unit-proto` 有断言）。
- 业务载荷本身是任意 JSON，因而以 JSON 字节嵌入（`payloadJson` / `dataJson`）；框架自身的键（`type`/`priority`/`topic`/`trace`）在 `actor-proto.proto` 中给出类型。

## 集群与安全：双向 TLS

TLS 默认**关闭**。开启后网关与 Gossip 都使用 mTLS：

```bash
# 1) 自签 CA
openssl req -x509 -newkey rsa:4096 -nodes -days 3650 -sha256 \
  -keyout ca.key -out ca.crt -subj "/CN=actor-ca"

# 2) 每个节点一张证书，CN 必须等于该节点的 ACTOR_NODE_ID
openssl req -newkey rsa:2048 -nodes -keyout node-1.key -out node-1.csr -subj "/CN=node-1"
openssl x509 -req -in node-1.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out node-1.crt -days 825 -sha256 \
  -extfile <(printf "subjectAltName=IP:10.0.0.1\nextendedKeyUsage=serverAuth,clientAuth")

# 3) 启动
ACTOR_TLS_ENABLED=1 ACTOR_TLS_CA=./ca.crt \
ACTOR_TLS_CERT=./node-1.crt ACTOR_TLS_KEY=./node-1.key \
ACTOR_NODE_ID=node-1 ACTOR_ADVERTISE_HOST=10.0.0.1 \
ACTOR_GATEWAY_HOST=10.0.0.1 ACTOR_GOSSIP_HOST=10.0.0.1 node actor-main.js
```

安全性质：

- **双向认证**：服务端 `requestCert` 且 `rejectUnauthorized`，客户端同样校验服务端证书链。
- **身份绑定**：`ACTOR_TLS_VERIFY_NODE_ID=1`（默认）要求对端证书 **CN 等于其声明的 `nodeId`**，因此一张合法证书无法冒充别的节点；网关还要求对端在发送任何数据前先完成 `hello` 握手。
- **不降级**：TLS 配置缺失或证书读不到时，该监听器会被**禁用**并告警，绝不会静默退回明文。
- 测试证书是**一次性**的，由 `npm run gen-test-certs` 生成（`test/fixtures/tls/`），仅供测试使用。

## 持久化：后端与语义

`ACTOR_STORE` 选择后端，接口一致（`append` / `ack` / `load` / `pendingCount` / `clear` / `compact`）：

| 后端 | 说明 | 适用 |
| --- | --- | --- |
| `file`（默认） | 每 Actor 一个追加式日志，记录带 CRC 帧；ack 也写入日志（O(1) 且持久），死记录占比超阈值时原子重写压缩；容错截断/损坏记录；自动迁移旧版 `.jsonl` | 单机、中小规模、零依赖 |
| `memory` | 纯内存，进程退出即丢 | 测试、临时场景 |
| `level` | 可选 `classic-level`；**每个 Actor 一个 LevelDB**（worker 之间无锁争用），按入队序号做范围扫描，ack 用批量删除 | 高吞吐、需要 O(1) ack |

语义要点：

- **至少一次投递**：消息入队落盘，终态（成功或入 DLQ）才 ack；崩溃重启只重放未确认的消息，业务 handler 应幂等。
- **ack 是持久的**：ack 会写入日志（而不是只留在内存），因此重启不会把已确认的消息再投一次。
- **顺序**：同一优先级内 FIFO；重试 `pushFront` 保持队首；限流不重排邮箱。
- **背压**：邮箱满立即拒绝（`mailbox_full`），被拒消息不落盘。
- 升级提示：旧版 `.jsonl` 会在首次读取时自动迁移为带帧日志，原文件重命名为 `*.jsonl.migrated` 保留。

---

## 配置

全部配置集中在 `config.js`，均可用环境变量覆盖。

**基础**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACTOR_DATA_DIR` | `./data` | 持久化、DLQ、日志目录 |
| `ACTOR_LOG_DIR` | 同 `ACTOR_DATA_DIR` | 日志目录 |
| `ACTOR_NODE_ID` | `<hostname>-<gossipPort>` | 集群内节点标识（唯一；TLS 下需等于证书 CN） |
| `ACTOR_BOOT_ACTORS` | `player_001` | 启动创建的 Actor，逗号分隔；设为空表示不创建 |
| `ACTOR_REGISTRY_PRUNE_MS` | `3000` | 远端注册条目过期检查周期 |

**控制台**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACTOR_TELNET_ENABLED` / `_HOST` / `_PORT` | `true` / `127.0.0.1` / `8080` | 控制台；绑定非回环地址时**必须**设置 Token |
| `ACTOR_TELNET_TOKEN` | 空 | 鉴权令牌（首条命令 `auth <token>`） |
| `ACTOR_TELNET_MAX_LINE` / `_MAX_CONN` | 64KB / 8 | 行长与连接数上限 |

**网关与集群**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACTOR_GATEWAY_ENABLED` / `_HOST` / `_PORT` | `true` / `127.0.0.1` / `9000` | 跨节点网关 |
| `ACTOR_GATEWAY_CODEC` | `proto` | 发送帧编码：`proto` 或 `json`（接收始终自动识别） |
| `ACTOR_GATEWAY_MAX_FRAME` | 8MB | 单帧上限 |
| `ACTOR_GOSSIP_ENABLED` / `_HOST` / `_PORT` | `true` / `127.0.0.1` / `7200` | 集群 Gossip（默认端口避开 macOS AirPlay 的 7000） |
| `ACTOR_GOSSIP_SEEDS` | 空 | 种子节点 `host:port,...` |
| `ACTOR_ADVERTISE_HOST` | `127.0.0.1` | 告知其它节点的可达地址（多机部署必须设置） |
| `ACTOR_GOSSIP_INTERVAL_MS` / `_PEER_TIMEOUT_MS` | 1000 / 6000 | 同步间隔与节点静默判定 |

**TLS**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACTOR_TLS_ENABLED` | `0` | 开启网关与 Gossip 的 mTLS |
| `ACTOR_TLS_KEY` / `_CERT` / `_CA` | 空 | 本节点私钥/证书与信任的 CA（开启时必填） |
| `ACTOR_TLS_PASSPHRASE` | 空 | 私钥口令 |
| `ACTOR_TLS_SERVER_NAME` | 空 | 客户端 SNI 名称 |
| `ACTOR_TLS_REQUEST_CERT` / `_REJECT_UNAUTHORIZED` | `1` / `1` | 双向认证开关 |
| `ACTOR_TLS_VERIFY_NODE_ID` | `1` | 校验对端 `nodeId` == 证书 CN |
| `ACTOR_TLS_MIN_VERSION` | `TLSv1.2` | 最低协议版本 |

**持久化与消息**

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ACTOR_STORE` | `file` | `file` / `memory` / `level` |
| `ACTOR_STORE_LEVEL_PATH` | `<data>/level` | LevelDB 根目录 |
| `ACTOR_STORE_COMPACT_BYTES` | 256KB | file 后端压缩触发阈值 |
| `ACTOR_MAX_MAILBOX` | `1000` | 邮箱上限（背压） |
| `ACTOR_BATCH_MAX` / `_TIMEOUT_MS` | `5` / `200` | 批量双触发阈值 |
| `ACTOR_MAX_RETRY` / `_RETRY_BACKOFF_MS` | `3` / `50` | 重试次数与退避基数 |
| `ACTOR_BUCKET_CAPACITY` / `_RATE` | `100` / `50` | 令牌桶容量与速率 |
| `ACTOR_SUP_STRATEGY` / `_MAX_RESTARTS` / `_WITHIN_SECONDS` | `one_for_one` / `3` / `5` | 监督策略与熔断阈值 |
| `ENABLE_HOT_RELOAD` | `0` | 热更新开关（动态执行代码，默认关闭） |
| `ACTOR_HOT_RELOAD_MODULE` | 空 | 更安全的替代：从受审查模块加载 handler |

### 集群示例（Protobuf + mTLS + LevelDB）

```bash
# 节点 1
ACTOR_NODE_ID=node-1 ACTOR_ADVERTISE_HOST=10.0.0.1 ACTOR_GATEWAY_HOST=10.0.0.1 \
ACTOR_TLS_ENABLED=1 ACTOR_TLS_CA=ca.crt ACTOR_TLS_CERT=node-1.crt ACTOR_TLS_KEY=node-1.key \
ACTOR_STORE=level ACTOR_TELNET_TOKEN=$(openssl rand -hex 16) node actor-main.js

# 节点 2
ACTOR_NODE_ID=node-2 ACTOR_ADVERTISE_HOST=10.0.0.2 ACTOR_GATEWAY_HOST=10.0.0.2 \
ACTOR_TLS_ENABLED=1 ACTOR_TLS_CA=ca.crt ACTOR_TLS_CERT=node-2.crt ACTOR_TLS_KEY=node-2.key \
ACTOR_STORE=level ACTOR_GOSSIP_SEEDS=10.0.0.1:7200 \
ACTOR_TELNET_TOKEN=$(openssl rand -hex 16) node actor-main.js
```

在节点 2 上 `registry list` 会看到节点 1 的 Actor（`type: "remote"`），直接 `hurt <actorId> ...` 即可跨节点调用；投递走 Protobuf 帧 + mTLS。

---

## 控制台命令

```
help                                              # 命令列表
hurt [actorId] [damage] [priority]                # 扣血，priority 0/1/2
getState [actorId]                                # 查询状态
actors                                            # 本节点 Actor 列表
spawn [actorId]                                   # 纳入监督树创建 Actor
kill [actorId]                                    # 主动停止（不会重启）
crash [actorId]                                   # 模拟崩溃（监督树会重启）
drop [actorId]                                    # 停止并移出监督树
sup info                                          # 监督树状态
registry list                                     # 注册中心（含远端）
dlq list | dlq size | dlq clear                   # 死信队列
metrics dump                                      # 指标快照
pub sub [topic] [actorId] | pub unsub ...         # 订阅 / 取消订阅
pub pub [topic] json | pub topics                 # 发布 / 主题列表
hotreload [actorId] <code>                        # 热更新（需 ENABLE_HOT_RELOAD=1）
hotload [actorId] [module] [export]               # 从模块文件加载 handler
gossip info                                       # 集群信息（peers / nodes / 注册表大小）
gateway ping [host] [port]                        # 网关连通性
exit
```

启用鉴权时，第一条命令必须是 `auth <token>`。

## 安全

- **热更新默认关闭**：`new Function` 动态编译等价于任意代码执行，需显式 `ENABLE_HOT_RELOAD=1`；更安全的做法是用 `hotload` 从项目内受审查模块加载（路径限制在项目根目录）。
- **控制台**：默认只绑定 `127.0.0.1`；若绑定非回环地址而**未**设置 Token，会拒绝启动控制台并告警，而不是把 RCE 暴露到网络。
- **网关 / Gossip**：默认绑定回环。跨机器部署请开启 mTLS（见上）并配合防火墙；未开 TLS 时应只跑在可信网络内。
- **输入校验**：actorId 限制为 `[A-Za-z0-9._:-]{1,128}`（落盘名再经哈希与转义，无法穿越目录）；优先级、伤害值、JSON 载荷都会校验。
- **文件权限**：`data/` 内含消息与日志，建议部署时限制目录权限。

---

## 测试

```bash
npm test                    # 177 个用例，仅用 Node 内置 node:test
npm run gen-test-certs      # 需要时重新生成测试证书（openssl）
```

覆盖重点：

- **回归用例（对应真实缺陷）**
  - 批量中一条消息失败时同批其它消息不丢失，DLQ 归因正确；
  - 单条消息失败进入重试/DLQ，而不是打死 worker 或主进程；
  - 崩溃重启只重放未确认消息，且 **ack 跨重启保持有效**（不会重复投递）；
  - 优先级越界、非数字伤害值不再导致崩溃或 `NaN` 状态；
  - 热更新箭头函数能拿到 `this`，非法代码被拒绝且不影响运行中的 Actor；
  - worker 未捕获异常不会打死主进程，且 Actor 会被重启；
  - 指标真正从 worker 传到主进程（`metrics dump` 不再是 `{}`）；
  - 存活节点的远端 Actor 不会被 TTL 误剔除（负向验证：去掉修复后该用例失败）。
- **单元测试**：配置、Trace、Protobuf 编解码（含未知字段跳过与畸形帧）、帧编解码（两种 codec 混用）、三后端持久化一致性、CRC 损坏/截断恢复、日志压缩、旧版迁移、DLQ、注册中心、令牌桶、指标合并、优先级邮箱、监督树三策略与熔断、网关双工、Gossip LWW/墓碑。
- **安全测试**：mTLS 双向投递、不受信任 CA 被拒、无客户端证书被拒、明文客户端无法接入 TLS 网关、`nodeId` 与证书 CN 不匹配被拒（网关与 Gossip 各自覆盖）、TLS 配置错误时禁用而非降级明文。
- **集成测试**：真实 worker 的启动/收发/重启/监控；控制台行缓冲、鉴权与输入校验；双节点集群的 Gossip 发现、跨节点投递、跨节点 Pub/Sub、Actor 下线注销、存活保活。

---

## 限制与 Roadmap

**已知限制**

1. Gossip 为最终一致性（LWW + 墓碑），无向量时钟；不适合强一致业务状态。
2. 跨节点投递要求载荷可 JSON 序列化（不传函数、`undefined`、循环引用）。
3. `level` 后端按 Actor 分库：适合中大型 Actor；海量小 Actor 建议用 `file` 后端。
4. 主进程承担路由与聚合，是单线程的；极高吞吐需要按业务分片到多个路由进程。
5. 日志 / 指标 / 死信仍是追加写，生产环境需配置 logrotate。
6. 网关与 Gossip 的 TLS 已就绪，但尚无证书轮换与吊销（CRL/OCSP）机制。
7. 热更新开启后仍是「动态执行代码」，请只对内部可控输入开放。

**Roadmap**

- Gossip 消息也改用二进制帧（当前为换行 JSON，便于排查）
- 证书轮换 / 吊销，以及基于 SPIFFE 之类的节点身份
- 持久化后端热迁移工具（`file` → `level`）
- 指标对接 Prometheus / OpenTelemetry
- 按负载调度 `spawn` 到低负载节点

## License

MIT，见 [LICENSE](LICENSE)。
