import type { AppDeps } from '@actor/app';

/** 状态留在 Actor 里（控制器是无状态的）。 */
export class Room {
  deps: AppDeps;
  id = 'lobby';
  players: string[] = [];

  constructor(deps: AppDeps) {
    this.deps = deps;
  }

  async receive(msg: { type: 'join'; playerId: string } | { type: 'state' } | { type: 'slow' }) {
    switch (msg.type) {
      case 'join':
        this.players.push(msg.playerId);
        return { joined: msg.playerId, players: this.players.length };
      case 'state':
        return { id: this.id, players: [...this.players], greeting: this.deps.config.get<string>('greeting') };
      case 'slow':
        await new Promise((resolve) => setTimeout(resolve, 1000)); // 用于演示每请求超时
        return { slow: true };
      default:
        return { error: 'unknown message' };
    }
  }
}
