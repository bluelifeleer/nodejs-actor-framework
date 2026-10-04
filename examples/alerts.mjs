'use strict';

/**
 * 告警示例：把框架自带的 /metrics 变成可执行的告警。
 *
 *   node examples/alerts.js
 *
 * 两种接法（README 里也写了）：
 *   1. 有 Prometheus：直接用 examples/prometheus/alerts.yml 里的规则，本文件不需要。
 *   2. 没有 Prometheus（单机、内网、或想先跑起来）：用本文件的方式，进程内评估规则。
 *
 * 本示例故意制造两个真实故障：
 *   - 邮箱积压：一个慢 Actor 被灌大量消息 → actor_mailbox_depth_total 涨上去；
 *   - 死信：一个永远失败的 Actor（failure='retry'）耗尽重试 → actor_dead_lettered_total 增长。
 * 然后停止灌入/修复，让你看到 resolved 通知（告警不会卡在 firing）。
 */

import { createSystem, plugins } from 'nodejs-actor-framework';   // 具名导入 CJS 包（需 lexer 可分析）
import { AlertManager, consoleNotifier, defaultGameRules, webhookNotifier } from '../packages/core/src/obs/alerting.js';
import MetricsExporter from '../packages/core/src/obs/metrics-exporter.js';

const { renderFamilies } = MetricsExporter;

async function main() {
  const system = createSystem({
    name: 'alerts-demo',
    logger: false,
    plugins: [
      plugins.deadLetters(),
      plugins.rateLimit({ capacity: 500, rate: 100 }),
      plugins.metrics({ intervalMs: 100 }),
    ],
  });

  // 插件是在 init()/首次 spawn 时安装的；这里要用 system.metrics，所以先显式 init。
  await system.init();

  // 进程内把框架指标渲染成 Prometheus 文本，再交给告警器评估。
  // 生产里把 source 换成 { url: 'http://127.0.0.1:9464/metrics' } 即可。
  const exporter = new MetricsExporter({
    metrics: system.metrics,
    framework: system,
    storeBackend: 'file',
    collectors: [() => {
      if (typeof system.collectMetrics === 'function') system.collectMetrics();
      return [];
    }],
  });

  const rules = [
    // 邮箱积压：1 秒内持续超过 500 就告警（避免瞬时抖动误报）
    { name: 'MailboxBacklog', metric: 'actor_mailbox_depth_total', condition: '>', threshold: 500, for: '1s', severity: 'warning', summary: '处理速度跟不上，消息在积压' },
    // 被限流的速率：说明有人在刷（或正常流量超限），持续 2 秒才报
    { name: 'ThrottledFlood', metric: 'actor_messages_throttled_total', condition: 'rate>', threshold: 10, for: '2s', severity: 'info', summary: '限流触发频繁，检查是不是刷屏' },
    // 死信：只要新增就报（critical），因为消息真的丢了
    { name: 'DeadLettersGrowing', metric: 'actor_dead_lettered_total', condition: 'increase>', threshold: 0, for: '0s', severity: 'critical', summary: '出现死信：业务消息被丢弃' },
    // 反复重启：可能连续崩溃
    { name: 'ActorCrashLoop', metric: 'actor_supervisor_restarts_in_window', condition: '>', threshold: 1, for: '0s', severity: 'critical', summary: 'Actor 在反复重启' },
  ];

  const alerts = new AlertManager({
    source: { snapshot: () => renderFamilies(exporter.snapshot()) },
    rules,
    intervalMs: 500,
    notifiers: [
      consoleNotifier(),
      // 真实环境再挂一个 webhook（钉钉/Slack/自建网关）：
      // webhookNotifier(process.env.ALERT_WEBHOOK),
    ],
  });

  for (const event of ['firing', 'resolved']) {
    alerts.on(event, (e) => {
      // 这里可以接入你自己的通知/工单系统
      if (process.env.ALERT_WEBHOOK) webhookNotifier(process.env.ALERT_WEBHOOK).send(e).catch(() => {});
    });
  }

  await alerts.start();
  console.log('告警器已启动（每 500ms 评估一次）\n');

  // --- 制造故障 1：慢 Actor + 灌消息 → 邮箱积压 -----------------------------
  const slow = await system.spawn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50)); // 每条 50ms
    return 'ok';
  }, { id: 'slow-consumer', mailbox: { maxSize: 5000 } });

  console.log('灌入 2000 条消息给一个每 50ms 才处理一条的 Actor…');
  for (let i = 0; i < 2000; i += 1) slow.tell(i);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  console.log('此时状态:', JSON.stringify(alerts.status().alerts.filter((a) => a.status !== 'inactive')));

  // --- 制造故障 2：永远失败的 Actor → 死信 ---------------------------------
  const failing = await system.spawn(async () => {
    throw new Error('always fails');
  }, { id: 'doomed', failure: 'retry', maxRetry: 0, mailbox: { maxSize: 100 } });
  await failing.ask('boom').catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1200));

  console.log('\n--- 当前告警状态 ---');
  for (const alert of alerts.status().alerts) {
    const flag = alert.status === 'firing' ? 'FIRING ' : alert.status === 'pending' ? 'PENDING' : 'ok     ';
    console.log(`  ${flag} ${alert.name.padEnd(20)} value=${alert.value === null ? 'n/a' : alert.value} ${alert.summary}`);
  }

  // --- 恢复：停止灌入并等它排空 → 应该收到 resolved -------------------------
  console.log('\n排空积压（把慢 Actor 停掉，队列会被丢弃/拒绝）…');
  await slow.stop();
  const clear = await system.spawn(async () => 'ok', { id: 'fast-consumer' });
  await clear.ask('x');
  await new Promise((resolve) => setTimeout(resolve, 2500));

  console.log('\n--- 最终状态（积压类告警应已 resolved）---');
  for (const alert of alerts.status().alerts) console.log(`  ${alert.status.padEnd(9)} ${alert.name} value=${alert.value === null ? 'n/a' : alert.value}`);

  await alerts.stop();
  await system.stop();
  console.log('\n演示结束。规则文件见 examples/prometheus/alerts.yml（有 Prometheus 时用它）。');
}

if (process.argv[1] === import.meta.filename) {
  main().catch((err) => {
    console.error('告警示例失败:', err);
    process.exit(1);
  });
}

export { main };
