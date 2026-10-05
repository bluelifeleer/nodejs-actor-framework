import { defineConfig } from '@actor/app';

/**
 * 用户可配置：schema 即默认值来源，也是校验规则与类型来源。
 * 环境变量覆盖约定：step → APP_STEP，greeting → APP_GREETING。
 */
export default defineConfig({
  step: { type: 'number', default: 1, min: 1, description: '每次 add 的默认步长' },
  greeting: { type: 'string', default: 'hello', description: '启动问候语' },
  token: { type: 'string', default: '', secret: true, description: '示例机密项（日志中打码）' },
});
