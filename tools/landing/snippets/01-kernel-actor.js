// 内核：OTP 风格监督树 + 每个 Actor 一条 FIFO 邮箱
// 可 `node 01-kernel-actor.js` 直接跑（下面的 assert 就是它的自检）。
// CJS 项目里把前两行换成 `const assert = require('node:assert');` /
// `const { Actor, createSystem } = require('nodejs-actor-framework');` 即可，两者都支持。
import assert from 'node:assert';

import { Actor, createSystem } from 'nodejs-actor-framework';

class Player extends Actor {
  preStart() {
    this.state = { hp: 100 }; // 恢复之前运行：用于建立初始状态
  }

  async receive(msg, ctx) {
    switch (msg.type) {
      case 'hurt':
        this.state.hp -= msg.damage;
        return this.state.hp; // 返回值就是 ask() 的回复
      case 'pet':
        // 子 Actor：父 Actor 就是它的监督者，路径全局唯一
        return (await ctx.spawn(Pet, { id: 'pet-1' })).path;
      default:
        // 抛错 = 崩溃，交给监督树（重启强度用尽则向上升级）
        throw new Error(`unknown message ${msg.type}`);
    }
  }
}

class Pet extends Actor {
  preStart() {
    this.state = { happy: 0 };
  }

  receive() {
    this.state.happy += 1;
    return this.state.happy;
  }
}

(async () => {
  const system = createSystem({
    defaults: { supervision: { strategy: 'one_for_one', maxRestarts: 3, withinSeconds: 5 } },
  });
  const player = await system.spawn(Player, { id: 'player_001' });

  player.tell({ type: 'hurt', damage: 5 }); // 发后不理：不分配 reply、不设定时器
  const hp = await player.ask({ type: 'hurt', damage: 5 }); // 请求-响应：有超时、有真实错误
  const petPath = await player.ask({ type: 'pet' }); // 路径即地址：player_001/pet-1

  assert.strictEqual(hp, 90);
  assert.strictEqual(petPath, 'player_001/pet-1');
  assert.strictEqual(system.stats().actors, 2, '内省：邮箱深度、计数器、子 Actor 都能查');

  await system.stop();
  console.log(`hp=${hp} pet=${petPath} actors=2`);
})();
