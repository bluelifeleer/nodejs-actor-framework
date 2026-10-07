import { randomUUID } from 'node:crypto';

import type { JsonStoreClient } from './json-store-adapter.ts';
import { defineController, HttpError, reply } from '@actor/web';

interface Note {
  id: string;
  title: string;
  at: string;
}

/** 取自装适配器的客户端（服务名 = 插件名 `store`）。 */
function storeOf(ctx: { get(name: string): unknown }): JsonStoreClient {
  const store = ctx.get('store') as JsonStoreClient | undefined;
  if (store === undefined) throw new Error('provider "store" 没有解析出来');
  return store;
}

/** 取可选的缓存（没挂 cache 实例就返回 undefined —— 这不是错误，只是没配）。 */
function cacheOf(ctx: { get(name: string): unknown }): { getJson<T>(key: string): Promise<T | null>; setJson(key: string, value: unknown, options?: { ttlMs?: number }): Promise<void>; del(...keys: string[]): Promise<number> } | undefined {
  try {
    return ctx.get('cache') as never;
  } catch {
    return undefined;
  }
}

const noteKey = (id: string): string => `note:${id}`;

export const notesController = {
  create: defineController({
    body: ['title'],
    input: { title: { type: 'string', min: 1 } },
    async handle(input, ctx): Promise<unknown> {
      const store = storeOf(ctx);
      const note: Note = { id: randomUUID(), title: String(input.title), at: new Date().toISOString() };
      await store.set(noteKey(note.id), note);
      // 有缓存就顺手写进去（读完即弃，30 秒过期）—— 演示"多数据库协作"
      await cacheOf(ctx)?.setJson(noteKey(note.id), note, { ttlMs: 30_000 });
      return reply.json(note, { status: 201 });
    },
  }),

  list: defineController({
    async handle(_input, ctx): Promise<unknown> {
      const store = storeOf(ctx);
      const keys = (await store.list()).filter((key) => key.startsWith('note:'));
      const notes = await Promise.all(keys.map((key) => store.get(key)));
      return { notes: notes.filter((note) => note !== null), store: store.raw.file };
    },
  }),

  get: defineController({
    input: { id: { type: 'string', min: 1 } },
    async handle(input, ctx): Promise<unknown> {
      const id = String(input.id);
      const cached = await cacheOf(ctx)?.getJson<Note>(noteKey(id));
      if (cached !== null && cached !== undefined) return { ...cached, fromCache: true };
      const note = (await storeOf(ctx).get(noteKey(id))) as Note | null;
      if (note === null) throw new HttpError(404, `note '${id}' not found`);
      return { ...note, fromCache: false };
    },
  }),

  remove: defineController({
    input: { id: { type: 'string', min: 1 } },
    async handle(input, ctx): Promise<unknown> {
      const id = String(input.id);
      const deleted = await storeOf(ctx).delete(noteKey(id));
      if (!deleted) throw new HttpError(404, `note '${id}' not found`);
      await cacheOf(ctx)?.del(noteKey(id));
      return { deleted: true };
    },
  }),
};
