import type { AppDeps } from '@actor/app';

/**
 * 业务 Actor：普通类，**不继承任何框架基类**。
 * 框架负责实例化、注入依赖、spawn、监督与停止。
 */
export class Counter {
  deps: AppDeps;
  count = 0;

  constructor(deps: AppDeps) {
    this.deps = deps;
  }

  receive(msg: { type: 'add' | 'get'; by?: number }): number {
    if (msg.type === 'add') {
      this.count += msg.by ?? this.deps.config.get<number>('step');
    }
    return this.count;
  }
}
