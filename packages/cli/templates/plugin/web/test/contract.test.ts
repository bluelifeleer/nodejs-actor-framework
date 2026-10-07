import { runWebPluginContract } from '@actor/web';

import plugin from '../src/index.ts';

// 框架**已发布**的契约套件：它自己会注册若干 test，跑 `npm test` 即自证合规。
runWebPluginContract({ name: '__PLUGIN_NAME__', define: () => plugin });
