/** Client-facing access-layer helpers (WebSocket/TLS transport + token auth). */

export {
  WebSocketServer,
  connect,
  acceptKey,
  OPCODE,
} from './ws-server';
export type {
  WebSocketConnection,
  ClientConnection,
  WebSocketServerOptions,
  WsTlsOptions,
  UpgradeRequest,
} from './ws-server';

export { TokenAuthority, tokenFromRequest, timingSafeEqual } from './token';
export type {
  TokenAuthorityOptions,
  IssuedToken,
  VerifiedToken,
} from './token';
