import net from 'node:net';
import readline from 'node:readline';

/**
 * 极简游戏客户端（示例）—— 用来验证 examples/game-server.js。
 *
 *   node examples/game-client.js 7777              # 跑一段脚本化流程
 *   node examples/game-client.js 7777 --interactive # 手动输入命令
 *
 * 它只做两件事：把命令写成一行 JSON 协议文本发出去，把服务器返回的每一行打印出来。
 * 真实的客户端（Unity/浏览器）做的是同一件事，只是用 WebSocket/QUIC 承载。
 */




const port = Number(process.argv[2] || 7777);
const host = process.env.HOST || '127.0.0.1';
const interactive = process.argv.includes('--interactive');

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => resolve(socket));
    socket.on('error', reject);
  });
}

async function main() {
  const socket = await connect();
  let buffer = '';
  const inbox = [];
  const waiters = [];

  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = { raw: line };
      }
      if (waiters.length > 0) waiters.shift()(parsed);
      else inbox.push(parsed);
    }
  });

  const send = (line) => socket.write(`${line}\n`);
  const nextMessage = (timeoutMs = 3000) => new Promise((resolve, reject) => {
    if (inbox.length > 0) return resolve(inbox.shift());
    const timer = setTimeout(() => reject(new Error('等待服务器回复超时')), timeoutMs);
    waiters.push((msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
  });
  const call = async (line) => {
    send(line);
    return nextMessage();
  };

  if (interactive) {
    console.log(`已连接 ${host}:${port}。输入命令（join/hit/move/stats/chat/top/room/quit），Ctrl-C 退出。`);
    // 推送（push）随时可能到达，用后台循环打印
    (async () => {
      for (;;) {
        const msg = await nextMessage(600000);
        console.log('<-', JSON.stringify(msg));
      }
    })().catch(() => {});
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
    rl.prompt();
    rl.on('line', (line) => {
      if (line.trim()) send(line.trim());
      if (line.trim() === 'quit') setTimeout(() => process.exit(0), 200);
      rl.prompt();
    });
    return;
  }

  // --- 脚本化流程：把「一个玩家从进服到退出」跑一遍 ------------------------
  const step = async (label, line, print = true) => {
    const reply = await call(line);
    if (print) console.log(`${label.padEnd(22)} -> ${JSON.stringify(reply)}`);
    return reply;
  };

  console.log(`已连接 ${host}:${port}\n`);
  await step('join alice', 'join {"playerId":"alice"}');
  await step('join bob', 'join {"playerId":"bob"}');
  await step('bob 打 alice 10 点', 'hit {"playerId":"alice","damage":10}');
  await step('alice 移动', 'move {"playerId":"alice","x":3,"y":4}');
  await step('alice 查询', 'stats {"playerId":"alice"}');
  // 刷屏：连发 12 条（令牌桶容量 30 / 20 每秒，这里演示「入口限流不影响其他连接」）。
  // 每条都会有一条回复，所以要把它们一起收掉，否则后面的请求会读到前面的回复。
  const flood = 12;
  for (let i = 0; i < flood; i += 1) send('hit {"playerId":"alice","damage":1}');
  const floodReplies = [];
  for (let i = 0; i < flood; i += 1) floodReplies.push(await nextMessage(5000));
  const lastHp = floodReplies[floodReplies.length - 1].result?.hp;
  console.log(`刷屏 ${flood} 次`.padEnd(22) + ` -> 全部处理，最后 hp=${lastHp}（限流时消息停在队首，顺序不乱）`);

  await step('房间状态', 'room {}');
  await step('排行榜（worker 隔离）', 'top {"n":2}');
  await step('聊天广播', 'chat {"text":"gg"}');
  console.log('\n提示：服务器终端里会看到 alice 收到的聊天推送（走 Session 推送）。');
  send('quit');
  await new Promise((resolve) => setTimeout(resolve, 200));
  socket.end();
  console.log('已断开');
}

main().catch((err) => {
  console.error('客户端出错:', err.message);
  process.exit(1);
});
