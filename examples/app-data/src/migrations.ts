import path from 'node:path';

import { createFileRepository, type Migration } from '@actor/data';

import { DATA_DIR } from './paths.ts';

/**
 * 示例迁移：迁移改**结构**（目录、索引、列），必须幂等（中断后会被重跑）。
 * 注意版本只增不改：要改语义就加一个新迁移，不要改老的。
 */
export function migrations(dataDir: string = DATA_DIR): Migration[] {
  return [
    {
      version: 1,
      description: '建立数据目录布局',
      async up({ log }) {
        const dirs = ['notes', 'summaries', 'dedupe', 'projection', 'orders'];
        for (const name of dirs) {
          const { mkdir } = await import('node:fs/promises');
          await mkdir(path.join(dataDir, name), { recursive: true });
        }
        log('数据目录已就绪', { dataDir, dirs });
      },
      async down({ log }) {
        log('回滚：数据目录保留（删目录属于危险操作，示例里不自动做）');
      },
    },
    {
      version: 2,
      description: '按实体文件重建 notes 仓储索引（索引只是缓存）',
      async up({ log }) {
        const notes = createFileRepository<Record<string, unknown>>({ dir: path.join(dataDir, 'notes') });
        const { entities } = await notes.rebuildIndex();
        log(`notes 索引已重建（${entities} 条实体）`);
      },
    },
  ];
}
