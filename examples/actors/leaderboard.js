import { Actor } from 'nodejs-actor-framework';
import workerThreads from 'node:worker_threads';

/**
 * worker 隔离的排行榜 Actor（示例）。
 *
 * 为什么单独一个文件：`isolation: 'worker'` 要求定义是**模块路径**——代码要被加载进
 * 线程，框架不提供把任意函数送进线程的 eval 通道。
 *
 * 什么时候该用：纯 CPU 计算（排名、寻路、序列化、校验、加解密）。它跑在自己的线程里，
 * 自旋 200ms 也不会卡住主线程上的房间/玩家 Actor。
 */



export default class Leaderboard extends Actor {
  preStart() {
    this.state = { queries: 0, lastTop: [] };
  }

  async receive(msg, ctx) {
    switch (msg.type) {
      case 'top': {
        this.state.queries += 1;
        const topN = msg.topN || 10;
        // 故意写成一个"重活"：真实项目里这里可能是很贵的计算。
        const ranked = [...msg.entries]
          .sort((a, b) => b.score - a.score)
          .slice(0, topN)
          .map((entry, index) => ({ rank: index + 1, playerId: entry.playerId, score: entry.score }));
        this.state.lastTop = ranked;
        return ranked;
      }
      case 'stats':
        return { ...this.state, threadId: workerThreads.threadId, path: ctx.path };
      default:
        throw new Error(`leaderboard: unknown message "${msg.type}"`);
    }
  }
};
