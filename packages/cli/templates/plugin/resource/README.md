# __PLUGIN_NAME__

一个**受管资源适配器**（框架不认识的"数据库"也能被管住：连接/探活/保活/事件/drain/关闭）。

```bash
npm install
npm test        # 跑框架**已发布**的连接管理契约套件，自证合规
```

装到应用里：

```ts
import adapter from '__PLUGIN_NAME__';
import { resourceAdapter } from '@actor/resource';

defineApp({ modules, plugins: [resourceAdapter(adapter, { name: 'mydb', connection: { url: '...' } })] });
```

契约套件检查：连上/事件、未连接与已关闭时**快速失败**、`close` 幂等、连接失败不假装 ready、
drain（在途归零 + 超时如实上报）、健康失败 → `degraded` → 恢复。
