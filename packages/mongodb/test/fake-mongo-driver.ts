import { createFakeMongoDb, type FakeMongoDb } from './fake-mongo.ts';

/**
 * 假 `mongodb` 模块：`MongoClient` 的**最小可信形状**（connect/db/close/startSession/on/topology）。
 *
 * 关键点：`command({ ping: 1 })` 在"不健康"时抛错 —— 这样契约套件的 `setHealthy` 才测得到东西；
 * 驱动事件（open/close/serverHeartbeatFailed）用真的监听器投递（只记录不投递会变成假绿）。
 */
export interface FakeMongoDriver {
  readonly module: { MongoClient: new (url: string, options?: Record<string, unknown>) => unknown };
  readonly db: FakeMongoDb;
  readonly state: {
    url: string;
    clientOptions: Record<string, unknown>;
    closed: number;
    sessions: number;
    opened: number;
    lastSession: Record<string, unknown> | null;
    operationOptions: Array<Record<string, unknown> | undefined>;
  };
  setHealthy(healthy: boolean): void;
  fire(event: string, detail?: unknown): void;
}

export function createFakeMongoDriver(): FakeMongoDriver {
  const state = {
    url: '',
    clientOptions: {} as Record<string, unknown>,
    closed: 0,
    sessions: 0,
    opened: 0,
    lastSession: null as Record<string, unknown> | null,
    operationOptions: [] as Array<Record<string, unknown> | undefined>,
  };
  const db = createFakeMongoDb({}, (options) => state.operationOptions.push(options));
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  let healthy = true;

  const fire = (event: string, detail?: unknown): void => {
    for (const listener of listeners.get(event) ?? []) listener(detail);
  };

  class FakeMongoClient {
    readonly topology = { isConnected: () => true };
    constructor(url: string, options: Record<string, unknown> = {}) {
      state.url = url;
      state.clientOptions = options;
    }
    async connect(): Promise<unknown> {
      state.opened += 1;
      fire('open');
      return this;
    }
    db(): unknown {
      return {
        ...db,
        async command(command: Record<string, unknown>) {
          if ('ping' in command) {
            if (!healthy) throw new Error('mongo 探活失败（假驱动被切成不健康）');
            return { ok: 1 };
          }
          return db.command(command);
        },
      };
    }
    async close(): Promise<void> {
      state.closed += 1;
      fire('close');
    }
    startSession(): unknown {
      state.sessions += 1;
      const session = { marker: `session-${state.sessions}` };
      state.lastSession = session;
      return {
        withTransaction: async (fn: (active: Record<string, unknown>) => Promise<unknown>) => fn(session),
        endSession: async () => undefined,
      };
    }
    on(event: string, listener: (...args: unknown[]) => void): unknown {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return this;
    }
  }

  return {
    module: { MongoClient: FakeMongoClient },
    db,
    state,
    setHealthy: (value: boolean) => {
      healthy = value;
    },
    fire,
  };
}
