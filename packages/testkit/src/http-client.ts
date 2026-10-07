/**
 * HTTP 测试客户端：把"发请求 + 解析 + 断言状态码"收敛成几行，少写样板。
 *
 * 刻意**不**做 mock：起真服务（`@actor/app` + `@actor/web` 的 http 插件，端口 0）再打真请求，
 * 这样测的是跨层契约（路由、校验、错误映射、状态码），而不是"我以为的接口"。
 */

export interface HttpResponse<T = unknown> {
  status: number;
  ok: boolean;
  headers: Headers;
  /** 解析后的 JSON（非 JSON 响应为 null）。 */
  body: T;
  /** 原始文本（排查用）。 */
  text: string;
}

export interface HttpClient {
  request<T = unknown>(
    method: string,
    path: string,
    options?: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<HttpResponse<T>>;
  get<T = unknown>(path: string, options?: { headers?: Record<string, string> }): Promise<HttpResponse<T>>;
  post<T = unknown>(path: string, body?: unknown): Promise<HttpResponse<T>>;
  patch<T = unknown>(path: string, body?: unknown): Promise<HttpResponse<T>>;
  del<T = unknown>(path: string): Promise<HttpResponse<T>>;
  /** 只取 body（大多数断言用它）。 */
  json<T = unknown>(method: string, path: string, options?: { body?: unknown }): Promise<T>;
  /** 断言状态码；不匹配就抛出**带响应体**的错误（否则排查只能靠猜）。 */
  expect(status: number, response: HttpResponse): HttpResponse;
}

export function createHttpClient(baseUrl: string, defaults: { timeoutMs?: number } = {}): HttpClient {
  const base = String(baseUrl).replace(/\/+$/, '');
  const timeoutMsDefault = defaults.timeoutMs ?? 10_000;

  // 实现按 unknown body 写（运行时不关心泛型），在边界上断言成接口的泛型签名
  const request = (async (method: string, path: string, options: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}) => {
    const timeoutMs = options.timeoutMs ?? timeoutMsDefault;
    const response = await fetch(`${base}${path.startsWith('/') ? path : `/${path}`}`, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.headers ?? {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let body: unknown = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    return { status: response.status, ok: response.ok, headers: response.headers, body, text };
  }) as HttpClient['request'];

  const api: HttpClient = {
    request,
    get: (path, options = {}) => request('GET', path, options),
    post: (path, body) => request('POST', path, body === undefined ? {} : { body }),
    patch: (path, body) => request('PATCH', path, body === undefined ? {} : { body }),
    del: (path) => request('DELETE', path),
    json: async (method, path, options = {}) => (await request(method, path, options)).body as never,
    expect(status, response) {
      if (response.status !== status) {
        throw new Error(
          `期望 HTTP ${status}，实际 ${response.status} ${response.ok ? '' : '(失败)'}：${response.text.slice(0, 500)}`,
        );
      }
      return response;
    },
  };
  return api;
}
