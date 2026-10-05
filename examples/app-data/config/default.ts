import { defineConfig } from '@actor/app';

import { DATA_DIR } from '../src/paths.ts';

export default defineConfig({
  // 注意：这个默认值与 src/paths.ts 同源（APP_DATA_DIR），避免"配置说一个目录、内核写另一个"。
  dataDir: { type: 'string', default: DATA_DIR },
  // http 端口属于插件配置：plugins.http.port（可用 APP_PLUGINS__HTTP__PORT 覆盖）
});
