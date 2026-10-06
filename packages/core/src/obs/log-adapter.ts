// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

/**
 * 日志适配（M5 第 4 步）：把 pino / winston / console 这类**对象日志器**接到内核的日志接缝上。
 *
 * 内核的日志接口刻意是**一个函数**：`createSystem({ logger: (event, meta) => void })`。
 * 好处是零依赖、零约定；代价是用户得自己写桥接——这个适配器就是那座桥。
 *
 * 级别怎么定：默认按事件名猜（`*_failed` / `*_error` / `*_conflict` / `*_rejected` 走 warn，
 * 其余走 info）。猜错了不用改内核：传 `level(event, meta)` 自己决定。
 */

/** 默认级别规则（可覆盖）。 */
function defaultLevel(event) {
  return /(^|_)(error|failed|failure|conflict|rejected|refused|unsupported|timeout)($|_)/.test(String(event))
    ? 'warn'
    : 'info';
}

/**
 * @param target 任何带 debug/info/warn/error 方法的对象（pino、winston、console 都行）
 * @param options.level 自定义级别判定；options.message 自定义消息文本
 * @returns `(event, meta) => void`，直接传给 `createSystem({ logger })`
 */
function createLogAdapter(target, options = {}) {
  if (target === null || typeof target !== 'object') {
    throw new TypeError('createLogAdapter(target) 需要一个对象日志器（pino/winston/console…）');
  }
  const levelFor = typeof options.level === 'function' ? options.level : (event) => defaultLevel(event);
  const format = typeof options.message === 'function' ? options.message : (event, meta) => `${event} ${meta === undefined ? '' : JSON.stringify(meta)}`.trim();

  return (event, meta) => {
    const level = levelFor(event, meta);
    const method =
      typeof target[level] === 'function'
        ? target[level].bind(target)
        : typeof target.info === 'function'
          ? target.info.bind(target)
          : null;
    if (method === null) return; // 目标什么都没有：静默（不能因为日志把内核搞崩）
    try {
      method(format(event, meta));
    } catch {
      /* 坏日志器不能影响 Actor */
    }
  };
}

module.exports = { createLogAdapter, defaultLevel };
