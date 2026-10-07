import { runManagedResourceContract, supervise } from '@actor/resource';

import adapter from '../src/index.ts';

// 框架**已发布**的连接管理契约套件：跑 `npm test` 即自证合规。
runManagedResourceContract({
  name: '__PLUGIN_NAME__',
  make: ({ onEvent, drainTimeoutMs }) =>
    supervise(adapter, {
      connection: { kind: '__PLUGIN_NAME__', url: 'probe:' },
      onEvent,
      ...(drainTimeoutMs === undefined ? {} : { drainTimeoutMs }),
    }),
});
