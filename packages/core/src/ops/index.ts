// @ts-nocheck —— M0.1：本文件尚未补齐类型标注（见 docs/design/next-steps.md §3）。
// 该标记是迁移期的显式声明，不是隐藏错误：逐文件补完标注后删除本行，
// 届时它会自动进入 npm run typecheck 的严格检查。
'use strict';

/**
 * WebSocket/TLS transport + token auth for the framework's access layer.
 * Both modules are dependency-free and only loaded when you use them.
 */

const ws = require('./ws-server.ts');
const token = require('./token.ts');

module.exports = {
  WebSocketServer: ws.WebSocketServer,
  WebSocketConnection: ws.WebSocketConnection,
  connect: ws.connect,
  TokenAuthority: token.TokenAuthority,
  tokenFromRequest: token.tokenFromRequest,
};
