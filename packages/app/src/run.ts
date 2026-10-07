/**
 * `runApp()`：把每个 `main.ts` 都要写一遍的样板收敛成一次调用。
 *
 * 实测 8 个示例的 main.ts 各写了一遍同样的东西：createApp → 注册 SIGTERM/SIGINT → start → 打印地址。
 * 这段样板有一处**容易写错**：信号处理器必须**在任何 await 之前**注册，否则启动窗口内收到 SIGTERM
 * 会走 Node 默认行为（直接退出，不做优雅停）。把顺序固定在这里比在 8 个文件里各写一遍可靠。
 */
import type { Application } from './assembly.ts';
import { createApp } from './assembly.ts';

export interface RunAppOptions {
  /** 配置目录（一般是 `new URL('./config', import.meta.url).pathname`）。 */
  configDir?: string;
  /** 透传给 createApp 的内核选项（例如日志/持久化）——类型与 createApp 对齐，不写 unknown。 */
  kernel?: Record<string, unknown>;
  /** 环境变量覆盖（透传）。 */
  env?: Record<string, string | undefined>;
  /** 优雅停的超时（默认 10s）。 */
  stopTimeoutMs?: number;
  /** 监听哪些信号（默认 SIGTERM + SIGINT；测试里可以换成别的或留空）。 */
  signals?: readonly NodeJS.Signals[];
  /** 进程退出（默认 process.exit）——**可注入**，这样信号路径能在测试里断言。 */
  exit?: (code: number) => void;
  /** 日志（默认写 stdout）。 */
  log?: (message: string) => void;
  /**
   * **启动前**要做的事（例如"迁移门"：有未应用迁移就拒绝启动）。
   *
   * 它在**信号处理器注册之后**执行 —— 这一点很重要：如果把这类 await 放在 runApp **之前**，
   * 启动窗口内收到 SIGTERM 就会走 Node 默认行为（直接退出、不做优雅停），也就是把性质弄丢了。
   */
  beforeStart?: (app: Application) => void | Promise<void>;
  /** 启动完成后回调（例如打印监听地址：示例里用的是 web 插件的 http 句柄）。 */
  onStarted?: (app: Application) => void | Promise<void>;
}

/**
 * 创建并启动应用，接好优雅停。返回**已启动**的 application（调用方可以继续用，例如拿 http 句柄）。
 */
export async function runApp(spec: unknown, options: RunAppOptions = {}): Promise<Application> {
  const log = options.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const stopTimeoutMs = options.stopTimeoutMs ?? 10_000;

  const application = createApp(spec as Parameters<typeof createApp>[0], {
    ...(options.configDir === undefined ? {} : { configDir: options.configDir }),
    ...(options.kernel === undefined ? {} : { kernel: options.kernel }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  // ⚠️ 顺序要紧：信号处理器在**第一个 await 之前**注册（启动窗口内也要能优雅停）
  let stopping = false;
  for (const signal of options.signals ?? (['SIGTERM', 'SIGINT'] as const)) {
    process.on(signal, () => {
      if (stopping) return; // 重复信号只处理一次
      stopping = true;
      void application
        .stop({ timeoutMs: stopTimeoutMs })
        .then(() => {
          log('[runApp] stopped gracefully');
          exit(0);
        })
        .catch((err: unknown) => {
          process.stderr.write(`[runApp] stop failed: ${String(err)}\n`);
          exit(1);
        });
    });
  }

  await options.beforeStart?.(application);
  await application.start();
  await options.onStarted?.(application);
  return application;
}
