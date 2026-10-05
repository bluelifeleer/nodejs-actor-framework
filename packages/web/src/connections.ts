/**
 * WebSocket 连接注册表（M2.5 第 3 步）。
 *
 * 目的：让**同一服务内**的 HTTP 请求共享 socket 上下文（游戏推送 / 实时大屏）。
 * 由 wsPlugin 注册为应用层服务，控制器用 `ctx.get('wsConnections')` 取用。
 *
 * 边界：注册表是**本节点**的。跨节点推送走 Actor（位置透明）或 pubsub 插件。
 */

export interface WsConnection {
  readonly id: string;
  /** 接入层（verifyClient）设置的玩家标识；未认证连接为 undefined。 */
  readonly playerId?: string;
  /** 连接建立时的请求路径（含查询串）。 */
  readonly path: string;
  readonly readyState: string;
  send(payload: unknown): boolean;
  close(code?: number, reason?: string): void;
}

export interface WsConnections {
  byId(id: string): WsConnection | null;
  /** 一个玩家可能多端在线。 */
  byPlayer(playerId: string): WsConnection[];
  sendTo(id: string, payload: unknown): boolean;
  broadcast(payload: unknown, filter?: (connection: WsConnection) => boolean): number;
  ids(): string[];
}

export function createConnectionRegistry(): MutableConnectionRegistry {
  const byId = new Map<string, WsConnection>();
  return {
    byId: (id) => byId.get(id) ?? null,
    byPlayer: (playerId) => [...byId.values()].filter((c) => c.playerId === playerId),
    sendTo: (id, payload) => byId.get(id)?.send(payload) ?? false,
    broadcast: (payload, filter) => {
      let sent = 0;
      for (const connection of byId.values()) {
        if (filter && !filter(connection)) continue;
        if (connection.send(payload)) sent += 1;
      }
      return sent;
    },
    ids: () => [...byId.keys()],
    register: (connection) => {
      byId.set(connection.id, connection);
    },
    unregister: (id) => {
      byId.delete(id);
    },
  };
}

/** 供 wsPlugin 内部登记/注销连接（不对外暴露，避免绕过生命周期管理）。 */
export interface MutableConnectionRegistry extends WsConnections {
  register(connection: WsConnection): void;
  unregister(id: string): void;
}
