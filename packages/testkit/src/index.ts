/**
 * `@actor/testkit`：测试工具（零依赖）。
 *
 * - **虚拟时钟**：把"等一小时"变成 0 真实毫秒，顺序确定；
 * - **探针**：记录 Actor 收到/回复/抛错（断言可观察行为，而不是内部字段）；
 * - **故障注入**：按次数让 Actor 失败/变慢/丢消息（把"生产里偶发"的情况变成显式声明）；
 * - **HTTP 客户端**：真请求 + 状态码断言（起真服务测跨层契约，不做 mock）。
 */

export { createVirtualClock, type Clock, type TimerHandle, type VirtualClock, type VirtualClockOptions } from './virtual-clock.ts';
export { createProbe, type Probe, type ProbeCall } from './probe.ts';
export { createFaultInjector, type Faults, type FaultRule, type FaultMatch } from './faults.ts';
export { createHttpClient, type HttpClient, type HttpResponse } from './http-client.ts';
