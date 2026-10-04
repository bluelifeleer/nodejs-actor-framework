# 用 Prometheus 给框架告警

框架自带 `/metrics`（Prometheus 文本格式），所以**有 Prometheus 时不需要写任何代码**：

1. 启动节点时打开指标端点（默认关闭）：

   ```bash
   ACTOR_METRICS_ENABLED=1 ACTOR_METRICS_PORT=9464 node examples/game-cluster.js
   ```

2. Prometheus 抓取（见 `alerts.yml` 顶部注释）：

   ```yaml
   scrape_configs:
     - job_name: actor-framework
       scrape_interval: 5s
       static_configs:
         - targets: ['10.0.0.1:9464', '10.0.0.2:9464']
   rule_files:
     - alerts.yml
   ```

3. 关键指标（全部由框架直接导出）：

   | 指标 | 类型 | 用途 |
   | --- | --- | --- |
   | `actor_mailbox_depth` / `actor_mailbox_depth_total` | gauge | 单 Actor / 全局积压，处理不过来的第一信号 |
   | `actor_messages_throttled_total` | counter | 被限流的消息数，刷屏/攻击或阈值过小 |
   | `actor_dead_lettered_total` | counter | 死信，业务消息真的丢了（critical） |
   | `actor_messages_handled_total` / `_failed_total` | counter | 吞吐与失败率（按 actor 标签下钻） |
   | `actor_message_latency_seconds_avg` / `_max` | gauge | 单 Actor 处理耗时 |
   | `actor_supervisor_restarts_in_window` / `actor_supervisor_escalations_total` | gauge / counter | 崩溃循环与升级 |
   | `actor_isolated_actors` | gauge | worker 隔离的 Actor 数 |
   | `actor_cluster_actors` / `_remote_actors` / `_peers` | gauge | 集群视图 |
   | `actor_process_resident_memory_bytes` | gauge | 内存（配合容器上限告警） |

4. **没有 Prometheus** 时用进程内告警器：`node examples/alerts.mjs`
   （`lib/obs/alerting.js`：支持 `>`、`rate>`、`increase>` 条件、`for:` 持续时间、
   fire/resolve、console + webhook 通知）。
