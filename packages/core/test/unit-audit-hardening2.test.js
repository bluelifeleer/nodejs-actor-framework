'use strict';

/**
 * 审计 Round 5：低危/提示项里可机械验证的部分。
 *
 *   S15 `resolveActorModule` 不解析符号链接（root 内软链可指向 root 外），且 `..foo/x.js`
 *       这种**合法的**相对名会被 startsWith('..') 误拒；
 *   S13 恒定时间比较在长度不等时**提前返回**（内容比较是恒定时间，长度会经耗时泄漏）；
 *   S11 分帧与 WS 读取按每个 data 事件 `Buffer.concat` → 单帧 O(n²) 拷贝。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');


test('audit/paths: resolveActorModule 必须解符号链接，且不得误拒以 .. 开头的合法名字', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'evil.js'), 'module.exports = 1;\n');
    fs.writeFileSync(path.join(root, 'ok.js'), 'module.exports = 2;\n');
    fs.symlinkSync(path.join(outside, 'evil.js'), path.join(root, 'link.js'));
    fs.mkdirSync(path.join(root, '..foo'), { recursive: true });
    fs.writeFileSync(path.join(root, '..foo', 'inner.js'), 'module.exports = 3;\n');

    // config.root 在**模块导入时**就定了（ACTOR_APP_ROOT 或 cwd），所以要在一个设好环境变量的子进程里验证
    const script = `
      const assert = require('node:assert');
      const path = require('node:path');
      const { resolveActorModule } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'worker', 'worker-delegate.ts'))});
      const root = process.env.ACTOR_APP_ROOT;
      try {
        resolveActorModule('link.js');
        console.log('SYMLINK_ALLOWED');
      } catch (err) {
        console.log('SYMLINK_REJECTED');
      }
      console.log('DOTDOT=' + (resolveActorModule('..foo/inner.js') === path.join(root, '..foo', 'inner.js')));
      console.log('OK=' + (resolveActorModule('ok.js') === path.join(root, 'ok.js')));
    `;
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const run = promisify(execFile);
    const { stdout } = await run(process.execPath, ['-e', script], { env: { ...process.env, ACTOR_APP_ROOT: root } });
    assert.match(stdout, /SYMLINK_REJECTED/, '指向 root 外的符号链接没有被拒绝');
    assert.match(stdout, /DOTDOT=true/, 'root 内以 `..` 开头的合法名字被误拒了');
    assert.match(stdout, /OK=true/, 'root 内的普通路径解析失败');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('audit/crypto: 恒定时间比较在长度不等时也要走等长比较（不早退）', () => {
  const { timingSafeEqual } = require('../src/ops/token.ts');
  assert.strictEqual(timingSafeEqual('abc', 'abc'), true);
  assert.strictEqual(timingSafeEqual('abc', 'abd'), false);
  assert.strictEqual(timingSafeEqual('abc', 'abcd'), false);
  // 长度不等时也必须返回 false（正确性），但实现里不能是"看到长度不等就 return false"
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ops', 'token.ts'), 'utf8');
  const body = source.slice(source.indexOf('function timingSafeEqual'), source.indexOf('function timingSafeEqual') + 700);
  assert.ok(
    !/if\s*\([^)]*length\s*!==[^)]*\)\s*return false/.test(body),
    '长度不等时直接 return false（早退）—— 应当用等长缓冲做一次 timingSafeEqual',
  );
});

test('audit/framing: 分帧读取不得对每个 chunk 做 Buffer.concat（O(n²)），且任意切分都要正确', async () => {
  const framing = await import('../src/cluster/framing.ts');
  const proto = await import('../src/cluster/proto.ts');
  const f = (framing.default || framing).createFraming({
    protoEncode: proto.encodeGatewayFrame || proto.default?.encodeGatewayFrame,
    protoDecode: proto.decodeGatewayFrame || proto.default?.decodeGatewayFrame,
  });

  // **多种切分方式都要正确**：这是本测试的重点。我只写"整块 + 单帧"的第一版是**绿的**，
  // 而当时实现里有个真 bug（rest 从前一帧的视图上取 → 同一块里的后续帧全丢 → 网关请求全超时）。
  const payloads = [1, 2, 3].map((i) => f.encode({ kind: 'deliver', id: `x${i}`, targetActorId: 'a', payload: { i } }, 1));
  const all = Buffer.concat(payloads);
  const splitters = {
    整块: (b) => [b],
    逐字节: (b) => [...b].map((x) => Buffer.from([x])),
    每7字节: (b) => {
      const out = [];
      for (let i = 0; i < b.length; i += 7) out.push(b.subarray(i, i + 7));
      return out;
    },
  };
  for (const [name, split] of Object.entries(splitters)) {
    const decoder = new f.FrameDecoder(1 << 20);
    const decoded = [];
    for (const chunk of split(all)) decoded.push(...decoder.push(chunk));
    assert.deepStrictEqual(
      decoded.map((frame) => frame.id),
      ['x1', 'x2', 'x3'],
      `${name} 切分下解帧不正确（同一块里的多帧必须都能解出来）`,
    );
  }

  // 结构性断言：不能是"每次 push 都 concat 已收到的全部字节"
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'cluster', 'framing.ts'), 'utf8');
  assert.ok(
    !/this\.buf\s*=\s*this\.buf\.length\s*\?\s*Buffer\.concat/.test(source),
    'framing 仍在对每个 chunk 做 Buffer.concat 累加（单帧 O(n²) 拷贝）',
  );
});

test('audit/console: 无 token 的控制台必须显式 opt-in；认证失败要有退避', async () => {
  const net = require('node:net');
  const { TelnetConsole } = require('../src/ops/telnet-console.ts');
  const stubSystem = {
    resolve: () => null,
    spawn: async () => ({ path: 'x', id: 'x' }),
    stats: () => ({}),
    listActors: () => [],
    inspect: () => ({}),
    stop: async () => {},
    readDeadLetters: async () => [],
    clearDeadLetters: async () => 0,
    connect: async () => ({}),
  };

  // 1) 回环 + 无 token：不显式 opt-in 就不许启动
  const bare = new TelnetConsole({ host: '127.0.0.1', port: 0, token: '', context: { system: stubSystem } });
  await assert.rejects(() => bare.listen(), /without a token|allowUnauthenticated/i);

  // 2) 正确 token 必须**永远**能用（退避只惩罚失败，不能把运维一起锁在门外）
  const console_ = new TelnetConsole({
    host: '127.0.0.1',
    port: 0,
    token: 'secret-token',
    maxAuthFailures: 2,
    context: { system: stubSystem },
  });
  const port = await console_.listen();
  const attempt = (line) =>
    new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`${line}\n`));
      let out = '';
      const finish = () => {
        socket.destroy(); // 认证成功那一轮会话保持打开，不销毁会让 close() 一直等它
        resolve(out);
      };
      const timer = setTimeout(finish, 5_000);
      const done = () => {
        clearTimeout(timer);
        finish();
      };
      socket.on('data', (d) => {
        out += d;
        if (/authenticated/.test(out)) done(); // 成功：拿到标记就收
      });
      socket.on('close', done); // 失败：服务端会 end()
      socket.on('error', done);
    });
  try {
    assert.match(await attempt('auth wrong'), /authentication required/i);
    assert.match(await attempt('auth also-wrong'), /authentication required/i);
    // 连续失败之后，正确的 token 仍然必须被接受
    assert.match(
      await attempt('auth secret-token'),
      /authenticated/,
      '失败退避把正确的 token 也挡住了（攻击者可以借此锁死运维）',
    );
  } finally {
    await console_.close().catch(() => {});
  }
});
