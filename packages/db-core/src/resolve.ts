/**
 * 驱动解析：通用实现已搬到 `@actor/resource`（从应用根解析 + 缺失时给安装提示）。
 * 这里原样 re-export，既有导入路径不变。
 */
export { createAppRequire, loadDriverModule, type DriverResolver } from '@actor/resource';
