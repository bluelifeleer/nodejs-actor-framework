/** Client-facing access-layer helpers (WebSocket/TLS transport + token auth). */

export {
  WebSocketServer,
  connect,
  acceptKey,
  OPCODE,
} from './ws-server.ts';
export type {
  WebSocketConnection,
  ClientConnection,
  WebSocketServerOptions,
  WsTlsOptions,
  UpgradeRequest,
} from './ws-server.ts';

export { TokenAuthority, tokenFromRequest, timingSafeEqual } from './token.ts';
export type {
  TokenAuthorityOptions,
  IssuedToken,
  VerifiedToken,
} from './token.ts';
