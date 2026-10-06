/**
 * `@actor/testkit`：测试工具（零依赖）。
 *
 * 目前有：**虚拟时钟**（把"等一小时"变成 0 真实毫秒，顺序确定）。
 * 计划中：探针（记录消息/回复）、故障注入（按次数失败/延迟/丢弃）。
 */

export { createVirtualClock, type Clock, type TimerHandle, type VirtualClock, type VirtualClockOptions } from './virtual-clock.ts';
