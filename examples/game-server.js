'use strict';

/**
 * 一个可运行的游戏服务器骨架 —— 「拿到框架之后该怎么写第一个游戏服」。
 *
 *   node examples/game-server.js                  # 默认 127.0.0.1:7777
 *   PORT=0 node examples/game-server.js           # 随机端口（会打印 PORT=<n>）
 *   node examples/game-client.js 7777             # 用附带的客户端连上去玩
 *
 * 进程结构（单进程；横向扩展时把房间分片到多个节点，见文末）：
 *
 *   TCP 客户端连接
 *        │  一行一条命令
 *        ▼
 *   Session Actor  ← 一条连接一个 Actor（限流、推送、断线清理都在这里）
 *        │  ctx.ask / ctx.tell
 *        ▼
 *   Room Actor     ← 一个房间一个 Actor（父 Actor，负责玩家的生与死）
 *        ├── Player Actor（一个玩家一个 Actor，状态落库）
 *        └── Player Actor ...
 *   Leaderboard Actor（worker 隔离：纯 CPU 的排名计算不占用主线程）
 *
 * 六个关键设计（照着改就行）：
 *   1. **粒度**：一个玩家一个 Actor，一个房间一个 Actor。别把整个世界塞进一个 Actor，
 *      否则它串行处理所有消息，玩家一多必然卡。
 *   2. **父子即监督树**：玩家是房间的子 Actor → 「玩家崩了只重启玩家」是默认行为，
 *      不需要额外代码。
 *   3. **按需落库**：玩家和房间 `persistence: { mode: 'snapshot' }`；连接会话不留档。
 *   4. **ask 用于要回值**（加入房间、查状态），**tell 用于广播**（聊天、推送）。
 *   5. **重活丢 worker**：排名/寻路/加解密 → 模块路径 + `isolation: 'worker'`。
 *   6. **限流在入口**：Session 上挂令牌桶，刷命令的客户端只影响它自己。
 *
 * 依赖怎么传（框架没有 `this.options`，两种受支持的形式）：
 *   - 节点级依赖 → 挂在 system 上（和框架自己的 `system.cluster`/`system.pubsub` 一致）：
 *       system.game = { leaderboard: 'leaderboard' };
 *       在 Actor 里用 ctx.system.game.leaderboard
 *   - 每连接依赖 → 用**工厂 + handler bag**（闭包捕获 socket，每次 spawn 都是新对象）：
 *       system.spawn(makeSession(socket), { id: ... })
 *     注意：直接 `spawn(new SomeActor())` 传**实例**是可以的，但重启会复用同一个对象
 *     （状态不会重置），只适合无状态且不需要重启的 Actor。
 *
 * 客户端协议（每行一条，参数是 JSON）：
 *   join {"playerId":"alice"}      hit {"playerId":"alice","damage":10}
 *   move {"playerId":"alice","x":3,"y":4}            stats {"playerId":"alice"}
 *   chat {"text":"gg"}             top {"n":3}       room {}      quit
 */

const net = require('net');
const { Actor, createSystem, plugins, ActorNotFoundError } = require('nodejs-actor-framework');

const PORT = Number(process.env.PORT === undefined ? 7777 : process.env.PORT);
const HOST = process.env.HOST || '127.0.0.1';
const TICK_MS = Number(process.env.TICK_MS || 200);
const SAVE_EVERY_TICKS = Number(process.env.SAVE_EVERY_TICKS || 25); // ≈5s
const ROOM_PATH = 'room-1';

// ---------------------------------------------------------------------------
// 玩家：一个玩家一个 Actor，状态落库（崩溃 / 重启 / 进程重启后仍在）
// ---------------------------------------------------------------------------

class Player extends Actor {
  preStart() {
    // 先建立默认值，之后框架才把恢复出来的快照覆盖上来（顺序由框架保证）。
    this.state = { hp: 100, maxHp: 100, level: 1, x: 0, y: 0, score: 0, deaths: 0 };
  }

  postRecover(ctx) {
    if (ctx.restored) ctx.log('player restored', { path: ctx.path, hp: this.state.hp, score: this.state.score });
  }

  async receive(msg, ctx) {
    switch (msg.type) {
      case 'hit': {
        const damage = Number(msg.damage) || 0;
        this.state.hp -= damage;
        this.state.score += damage;
        if (this.state.hp <= 0) {
          this.state.deaths += 1;
          this.state.hp = this.state.maxHp; // 复活
          if (ctx.sender) ctx.tell(ctx.sender, { type: 'event', text: `${ctx.id} 阵亡并复活（第 ${this.state.deaths} 次）` });
          return { respawned: true, ...this.state };
        }
        return { ...this.state };
      }
      case 'move':
        this.state.x = Number(msg.x) || 0;
        this.state.y = Number(msg.y) || 0;
        return { x: this.state.x, y: this.state.y };
      case 'stats':
        return { playerId: ctx.id, ...this.state };

      // 通知类消息（房间广播的"发生了什么"）：记下即可，**不能崩**。
      // 如果在这里 throw，玩家 Actor 会因一条广播而重启、状态归零。
      case 'event':
        this.state.lastEvent = msg.text || null;
        return 'noted';

      // 房间在 tick 里定期调用：显式存快照（被 kill -9 也不丢最近一次存档）
      case 'save':
        await ctx.saveSnapshot();
        return { saved: true, hp: this.state.hp };

      // 演示失败语义：默认 failure='crash' —— 错误冒泡给 ask 调用方，
      // 玩家 Actor 被父 Actor（房间）重启，其它玩家不受影响。
      case 'crash':
        throw new Error(`player ${ctx.id} crashed on purpose`);

      default:
        throw new Error(`player: unknown message "${msg.type}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// 房间：一个房间一个 Actor，是玩家的父 Actor
// ---------------------------------------------------------------------------

class Room extends Actor {
  preStart() {
    // roster 也落库：进程重启后房间能把自己名下的玩家重新拉起来。
    this.state = { roster: [], ticks: 0 };
    /**
     * playerId → 会话 Actor 的 **ref**（不是 path 字符串）。
     *
     * 存 ref 而不是路径的原因：远端会话的 ref 里带着"回信地址"，
     * 房间可以直接把推送发回去，不必等 gossip 发现这个刚建立的会话。
     *
     * 故意放在实例字段而不是 `this.state`：会话引用是**易失**的（进程重启就没了），
     * 落库只应保存游戏状态。`preStart` 每次重启都会重新初始化它。
     */
    this.sessions = Object.create(null);
  }

  /**
   * 恢复钩子 —— 这里做「父 Actor 重启后把孩子拉回来」。
   *
   * 两个必须注意的点：
   *   1. 框架**不会**替你重建子 Actor：监督树只记得"我有哪些孩子"，不知道怎么构造它们。
   *      父 Actor 必须在恢复后自己 spawn 回来（下面的循环）。
   *   2. 只能在 `postRecover` 做，不能在 `preStart`：`preStart → 应用快照 → postRecover`，
   *      preStart 时 `this.state.roster` 还是默认值。
   */
  async postRecover(ctx) {
    if (!ctx.restored) return;
    let rebuilt = 0;
    for (const playerId of this.state.roster) {
      if (ctx.system.resolve(`${ctx.path}/${playerId}`)) continue; // 已存在就别重复建
      await ctx.spawn(Player, { id: playerId, persistence: { mode: 'snapshot' } });
      rebuilt += 1;
    }
    if (rebuilt > 0) ctx.log('room rebuilt children', { rebuilt, roster: this.state.roster });
  }

  async receive(msg, ctx) {
    switch (msg.type) {
      case 'join':
        return this._join(msg.playerId, ctx);

      case 'whoami':
        return { playerId: ctx.sender ? ctx.sender.path : null, room: ctx.path };

      case 'leave': {
        if (!this.state.roster.includes(msg.playerId)) return { left: false };
        this.state.roster = this.state.roster.filter((id) => id !== msg.playerId);
        await ctx.stop(msg.playerId); // 玩家自己的快照会在 stop 时写盘
        return { left: true, roster: this.state.roster };
      }

      case 'hit':
      case 'move':
      case 'stats':
        // 房间只转发：真正处理的是玩家 Actor（这就是分片的收益）
        return this._player(ctx, msg.playerId).ask(msg, 3000);

      case 'chat': {
        // 广播要发给**会话**（socket 在会话 Actor 手里），同时通知玩家 Actor 记录事件。
        const results = [];
        const text = `[聊天] ${msg.text}`;
        for (const playerId of [...this.state.roster]) {
          const session = this.sessions[playerId];
          let pushed = false;
          if (session) pushed = ctx.tell(session, { type: 'push', text, from: msg.from });
          ctx.tell(playerId, { type: 'event', text, from: msg.from }); // 通知玩家 Actor（不崩）
          results.push({ playerId, pushed });
        }
        return { delivered: results.filter((r) => r.pushed).length, total: results.length };
      }

      // 客户端断线：只清会话映射，**保留玩家 Actor 与状态**，下次登录还能接上
      case 'disconnect': {
        delete this.sessions[msg.playerId];
        return { disconnected: true, playerId: msg.playerId };
      }

      case 'top': {
        // 排名是纯 CPU 计算 → 交给 worker 隔离的 Leaderboard
        const entries = [];
        for (const playerId of this.state.roster) {
          const stats = await this._player(ctx, playerId).ask({ type: 'stats' }, 3000);
          entries.push({ playerId, score: stats.score });
        }
        const leaderboard = ctx.system.game.leaderboard; // 节点级依赖挂在 system 上
        return ctx.ask(leaderboard, { type: 'top', entries, topN: msg.n || 10 }, 5000);
      }

      // tick 由进程内的定时器驱动（时钟在 Actor 世界之外，只负责投递一条消息）
      case 'tick': {
        this.state.ticks += 1;
        if (this.state.ticks % SAVE_EVERY_TICKS === 0) {
          await this._saveRoster(ctx);
          let saved = 0;
          for (const playerId of this.state.roster) {
            try {
              await this._player(ctx, playerId).ask({ type: 'save' }, 2000);
              saved += 1;
            } catch (err) {
              ctx.log('save failed', { playerId, err: err.message }); // 一个玩家存盘失败不影响别人
            }
          }
          return { tick: this.state.ticks, saved };
        }
        return { tick: this.state.ticks };
      }

      case 'room':
        return { room: ctx.path, node: ctx.system.name, tick: this.state.ticks, roster: this.state.roster, children: ctx.children };

      default:
        throw new Error(`room: unknown message "${msg.type}"`);
    }
  }

  // 加入：幂等。判断依据是「这个玩家 Actor 是否存在」，而不是名册数组
  //（重启后名册有记录、子 Actor 却还没建出来，只看名册会误判成已加入）。
  async _join(playerId, ctx) {
    if (!playerId) throw new Error('join 需要 playerId');
    // 会话从"谁在问"推断（ctx.sender），不信任客户端传来的路径。
    // 本地会话是普通 ActorRef，跨节点的会话是可回信的 RemoteSender —— 两者用法一样。
    if (ctx.sender && ctx.sender.path) this.sessions[playerId] = ctx.sender;
    const existing = ctx.system.resolve(`${ctx.path}/${playerId}`);
    if (!existing) {
      // 玩家 Actor 由房间（父 Actor）创建 → 自动进入监督树
      await ctx.spawn(Player, { id: playerId, persistence: { mode: 'snapshot' } });
      if (!this.state.roster.includes(playerId)) this.state.roster.push(playerId);
      await this._saveRoster(ctx);
      return { joined: true, playerId, roster: this.state.roster };
    }
    if (!this.state.roster.includes(playerId)) {
      this.state.roster.push(playerId);
      await this._saveRoster(ctx);
    }
    const stats = await existing.ask({ type: 'stats' }, 3000);
    return { joined: false, alreadyIn: true, ...stats };
  }

  _player(ctx, playerId) {
    if (!playerId) throw new ActorNotFoundError('playerId 是必填的');
    const ref = ctx.system.resolve(`${ctx.path}/${playerId}`);
    if (!ref) throw new ActorNotFoundError(`玩家 ${playerId} 不在房间 ${ctx.path} 里，先 join`);
    return ref;
  }

  async _saveRoster(ctx) {
    try {
      await ctx.saveSnapshot();
    } catch (err) {
      ctx.log('roster save failed', { err: err.message });
    }
  }
}

// ---------------------------------------------------------------------------
// 会话：一条 TCP 连接一个 Actor（框架不管客户端协议，这层由你写）
//
// 用「工厂 + handler bag」：闭包捕获这个连接的 socket，每次 spawn 返回新对象，
// 所以重启/重建都不会串线。
// ---------------------------------------------------------------------------

function makeSession(socket) {
  const write = (obj) => {
    if (!socket.destroyed) socket.write(`${JSON.stringify(obj)}\n`);
  };

  // 注意：handler bag 只会转发框架认识的钩子（receive/onMessage、preStart/onStart、
  // postStop/onStop、postRecover、preRestart、applyEvent、state）。
  // 自己加的 `_helper()` 方法**不会**被转发，所以辅助函数写成闭包而不是 bag 的方法。
  async function onLine(line, ctx) {
      this.state.lines += 1;
      const [cmd, ...rest] = line.trim().split(/\s+/);
      const raw = rest.join(' ');

      let arg = {};
      try {
        arg = raw ? JSON.parse(raw) : {};
      } catch (err) {
        this.state.errors += 1;
        write({ ok: false, cmd, error: `参数必须是合法 JSON: ${err.message}` });
        return 'bad-json';
      }

      try {
        switch (cmd) {
          case 'join':
            this.state.playerId = arg.playerId || ctx.id;
            write({ ok: true, cmd, result: await ctx.ask(ROOM_PATH, { type: 'join', playerId: this.state.playerId }, 3000) });
            return 'ok';
          case 'hit':
          case 'move':
          case 'stats':
            write({ ok: true, cmd, result: await ctx.ask(ROOM_PATH, { ...arg, type: cmd }, 3000) });
            return 'ok';
          case 'chat':
            write({ ok: true, cmd, result: await ctx.ask(ROOM_PATH, { type: 'chat', text: arg.text, from: this.state.playerId }, 5000) });
            return 'ok';
          case 'top':
            write({ ok: true, cmd, result: await ctx.ask(ROOM_PATH, { type: 'top', n: arg.n }, 8000) });
            return 'ok';
          case 'room':
            write({ ok: true, cmd, result: await ctx.ask(ROOM_PATH, { type: 'room' }, 3000) });
            return 'ok';
          case 'quit':
            write({ bye: true });
            return ctx.stopSelf();
          default:
            this.state.errors += 1;
            write({ ok: false, error: `unknown command "${cmd}"` });
            return 'unknown';
        }
      } catch (err) {
        // 业务错误回给客户端，而不是让会话 Actor 崩掉
        this.state.errors += 1;
        write({ ok: false, cmd, error: err.message });
        return 'error';
      }
  }

  return {
    state: () => ({ playerId: null, lines: 0, errors: 0 }),

    async onMessage(msg, ctx) {
      // 服务器主动推送（房间广播会走到这里）
      if (msg.type === 'push') {
        write({ push: 'event', text: msg.text, from: msg.from });
        return 'pushed';
      }
      if (msg.type === 'close') {
        write({ bye: true });
        return ctx.stopSelf();
      }
      return onLine.call(this, msg.line, ctx);
    },

    onStop() {
      if (!socket.destroyed) socket.end();
    },
  };
}


// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function main() {
  const system = createSystem({
    name: process.env.NODE_ID || 'game-node-1',
    persistenceDir: process.env.DATA_DIR, // 默认 ./data
    shutdownTimeoutMs: 3000,
    plugins: [
      plugins.tracing(),                             // 一条请求链路一个 traceId，方便排查
      plugins.deadLetters(),                         // 重试耗尽的失败消息落盘
      plugins.rateLimit({ capacity: 50, rate: 25 }),  // 默认每 Actor 令牌桶
      plugins.metrics({ exporter: { enabled: true, host: '127.0.0.1', port: Number(process.env.METRICS_PORT || 9464) } }),
      // 多节点（把房间分片到多台机器）时打开：
      // plugins.cluster({ seeds: ['10.0.0.1:7200'] }),
    ],
  });

  // 节点级依赖：和框架自己的 system.cluster / system.pubsub 一个位置
  await system.spawn('./examples/actors/leaderboard.js', { id: 'leaderboard', isolation: 'worker' });
  system.game = { leaderboard: 'leaderboard' };

  // 房间：自己落库（名册）
  await system.spawn(Room, { id: ROOM_PATH, persistence: { mode: 'snapshot' } });

  // 房间在 postRecover 里已经把名册中的玩家重建好了（见 Room.postRecover）
  const roomInfo = system.inspect(ROOM_PATH);
  const roster = roomInfo.state && Array.isArray(roomInfo.state.roster) ? roomInfo.state.roster : [];
  if (roster.length > 0) console.log(`已恢复房间名册并重建玩家 Actor：${roster.join(', ')}`);

  // 时钟：不属于 Actor 世界，只负责把 tick 消息投递给房间
  const ticker = setInterval(() => system.ref(ROOM_PATH).tell({ type: 'tick' }), TICK_MS);
  ticker.unref();

  // 客户端入口：一条连接一个 Session Actor。
  // 框架不提供 WebSocket/HTTP —— 客户端协议层由你写，这一层只做「翻译」：
  // socket 数据 → 消息；Actor 的回复 → 写回 socket。
  let sessionSeq = 0;
  const server = net.createServer(async (socket) => {
    socket.setNoDelay(true);
    const session = await system.spawn(makeSession(socket), {
      id: `session-${++sessionSeq}`,
      mailbox: { maxSize: 200 },              // 有界邮箱：客户端刷屏不会吃光内存
      rateLimit: { capacity: 30, rate: 20 },   // 入口限流：刷命令只影响这条连接
    });

    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line.trim()) session.tell({ type: 'line', line }); // 一行一条命令
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      // 断线清理：会话 Actor 停掉（玩家数据保留，重新 join 还能回来）
      if (system.resolve(session.path)) session.tell({ type: 'close' });
    });
  });

  await new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(PORT, HOST, resolve);
  });

  const port = server.address().port;
  console.log('游戏服务器已启动');
  console.log(`  客户端入口 : tcp://${HOST}:${port}    例：node examples/game-client.js ${port}`);
  console.log(`  指标端点   : http://127.0.0.1:${process.env.METRICS_PORT || 9464}/metrics`);
  console.log(`  tick       : 每 ${TICK_MS}ms（每 ${SAVE_EVERY_TICKS} tick 存一次快照）`);
  console.log(`  PORT=${port}`); // 供脚本/测试解析

  // 优雅退出：停止接受新连接 → 停止所有 Actor（玩家/房间快照在这里写盘）→ 关指标端点
  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    console.log(`\n[${signal}] 正在退出：保存快照并停止 Actor…`);
    clearInterval(ticker);
    await new Promise((resolve) => server.close(resolve));
    await system.stop();
    console.log('已安全退出（玩家与房间状态已落库）');
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(signal));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('启动失败:', err);
    process.exit(1);
  });
}

module.exports = { Player, Room, makeSession, main };
