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
