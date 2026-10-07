import path from 'node:path';

import { createFileRepository } from '@actor/data';

import { noteSchema } from '../schema/note.schema.ts';

/**
 * 仓储装配（service 层）：把"用哪种存储、数据放哪"收在一个文件里。
 *
 * 换成 SQL 只改这一行：`createSqlRepository({ runner, table: noteSchema.collection, ... })`。
 * 控制器只认 `Repository<Note>` 接口，所以换存储不需要动控制器。
 */
export function createNotesRepository(dataDir: string) {
  return createFileRepository({ dir: path.join(dataDir, noteSchema.collection) });
}
