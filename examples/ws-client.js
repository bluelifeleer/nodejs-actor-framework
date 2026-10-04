'use strict';

/**
 * WebSocket 客户端（对应 examples/access-node.js 与 examples/game-cluster.js）。
 *
 *   node examples/ws-client.js wss://127.0.0.1:8443/game <token> [--insecure]
 *   node examples/ws-client.js wss://127.0.0.1:8443/game <token> --interactive
 *
 * playerId 不在消息里传：服务器从 token 里取。客户端只发命令。
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { connect } = require('../packages/core/src/ops/ws-server');

const url = process.argv[2];
const token = process.argv[3];
const interactive = process.argv.includes('--interactive');

/**
 * TLS 选项（默认校验证书，和浏览器一致）：
 *   CA=path/to/ca.crt   → 信任你的 CA（推荐，示例集群用自签测试证书时这样连）
 *   --insecure          → 跳过校验，**仅限本地调试**
 */
const insecure = process.argv.includes('--insecure');
const caPath = process.env.CA;
const tlsOptions = insecure
  ? { rejectUnauthorized: false }
  : caPath
    ? { ca: fs.readFileSync(path.resolve(caPath)) }
    : {};

if (!url || !token) {
  console.error('用法: [CA=path/to/ca.crt] node examples/ws-client.js <ws-url> <token> [--interactive|--insecure]');
  process.exit(1);
}

async function main() {
  if (insecure) console.log('警告：--insecure 已跳过证书校验，仅用于本地调试。');
  const connection = await connect(url, {
    headers: { authorization: `Bearer ${token}` },
    tls: tlsOptions,
  });
  const inbox = [];
  const waiters = [];
  connection.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      msg = { raw: String(raw) };
    }
    if (waiters.length > 0) waiters.shift()(msg);
    else inbox.push(msg);
  });

  const next = (timeoutMs = 8000) => new Promise((resolve, reject) => {
    if (inbox.length > 0) return resolve(inbox.shift());
    const timer = setTimeout(() => reject(new Error('等待服务器回复超时')), timeoutMs);
    waiters.push((msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });

  const call = async (obj) => {
    connection.sendJson(obj);
    // 推送（push）随时会到，跳过它们，直到拿到对应命令的回复
    for (;;) {
      const msg = await next();
      if (msg.push) {
        console.log('<- 推送:', JSON.stringify(msg));
        continue;
      }
      return msg;
    }
  };

  if (interactive) {
    console.log('已连接。命令：join / hit {"damage":10} / move {"x":1,"y":2} / stats / chat {"text":"gg"} / top {"n":3} / room / quit');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
    rl.prompt();
    rl.on('line', async (line) => {
      const text = line.trim();
      if (!text) return rl.prompt();
      if (text === 'quit') {
        connection.close(1000, 'bye');
        return process.exit(0);
      }
      const [cmd, ...rest] = text.split(/\s+/);
      let arg = {};
      try {
        arg = rest.length > 0 ? JSON.parse(rest.join(' ')) : {};
      } catch (err) {
        console.log('参数要是 JSON:', err.message);
        return rl.prompt();
      }
      try {
        console.log('->', JSON.stringify(await call({ cmd, ...arg })));
      } catch (err) {
        console.log('错误:', err.message);
      }
      return rl.prompt();
    });
    return;
  }

  // --- 脚本化流程 ---------------------------------------------------------
  const step = async (label, obj) => {
    const reply = await call(obj);
    console.log(`${label.padEnd(24)} -> ${JSON.stringify(reply)}`);
    return reply;
  };

  console.log(`已连接 ${url}\n`);
  const joined = await step('join（token 决定我）', { cmd: 'join' });
  await step('打自己 12 点', { cmd: 'hit', damage: 12 });
  await step('移动', { cmd: 'move', x: 5, y: 6 });
  await step('查状态', { cmd: 'stats' });
  await step('房间信息（看在哪台节点）', { cmd: 'room' });
  await step('排行榜（worker 隔离）', { cmd: 'top', n: 3 });
  await step('聊天广播', { cmd: 'chat', text: 'gg' });
  await step('伪造 playerId（会被忽略）', { cmd: 'stats', playerId: 'bob' });

  console.log(`\n你的房间: ${joined.room}（playerId 来自 token，客户端传的 playerId 被忽略）`);
  connection.close(1000, 'done');
  await new Promise((resolve) => setTimeout(resolve, 150));
  console.log('已断开');
}

main().catch((err) => {
  console.error('客户端出错:', err.message);
  if (/certificate|self-signed|UNABLE_TO_VERIFY/i.test(err.message)) {
    console.error('提示：示例用的是自签测试证书，真实环境请配置受信任证书。');
  }
  process.exit(1);
});
