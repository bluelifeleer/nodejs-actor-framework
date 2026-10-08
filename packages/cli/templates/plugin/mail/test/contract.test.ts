import { runMailTransportContract } from '@actor/mail';

import { __PLUGIN_CAMEL__Transport } from '../src/index.ts';

/**
 * 框架**已发布**的邮件传输契约套件：`npm test` 即自证合规。
 *
 * 这里用**假的 HTTP 端点**（注入 `fetch`），所以离线也能跑：
 * 契约检查的是"形状"（id/accepted/rejected、verify/close 幂等），不是真的把信发出去。
 */
const realFetch = globalThis.fetch;

// 契约套件只关心"send 的返回形状"：给一个最小可用的假端点。
globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}')) as { to?: Array<{ address?: string }> };
  const accepted = (body.to ?? []).map((item) => item.address ?? '').filter((address) => address !== '');
  return new Response(JSON.stringify({ id: 'fake-1', accepted }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

try {
  runMailTransportContract({
    name: '__PLUGIN_NAME__',
    make: () => __PLUGIN_CAMEL__Transport({ endpoint: 'https://mail.example.test/send', apiKey: 'test' }),
  });
} finally {
  // 契约套件注册的是 test()，真正执行在进程退出前 —— 所以这里不能立刻还原，交给进程结束
  void realFetch;
}
