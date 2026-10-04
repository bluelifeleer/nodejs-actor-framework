/**
 * Type definitions for the client-facing WebSocket/TLS transport.
 *
 * No Node type packages are required: the few Node shapes used here are
 * declared structurally, which keeps `npm run typecheck` dependency-free.
 */

export interface UpgradeRequest {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
  /** Set by the server from what `verifyClient` returned. */
  auth?: { playerId: string; [key: string]: unknown } | null;
}

export interface WsTlsOptions {
  key?: string | Uint8Array;
  cert?: string | Uint8Array;
  ca?: string | Uint8Array | Array<string | Uint8Array>;
  passphrase?: string;
  rejectUnauthorized?: boolean;
}

export interface WebSocketServerOptions {
  host?: string;
  port?: number;
  path?: string;
  /** Frames larger than this are refused with close code 1009. */
  maxPayloadBytes?: number;
  /** Echoed back as `Sec-WebSocket-Protocol` when set. */
  subprotocol?: string | null;
  /** Return `true`, or an object that becomes `req.auth`, to accept the upgrade. */
  verifyClient?: (req: UpgradeRequest) => boolean | object | Promise<boolean | object>;
  /** `{ key, cert }` turns the server into `wss://`. Required off-loopback. */
  tls?: WsTlsOptions | null;
  /** Plain HTTP handler for non-upgrade requests (default: 426 Upgrade Required). */
  requestHandler?: (req: unknown, res: unknown) => void;
}

export interface WebSocketConnection {
  /** The authenticated player, set by the access layer. */
  playerId: string | null;
  readonly closed: boolean;
  readonly readyState: 'open' | 'closing' | 'closed';
  send(data: string | Uint8Array, options?: { binary?: boolean }): boolean;
  sendJson(obj: unknown): boolean;
  ping(payload?: string | Uint8Array): boolean;
  pong(payload?: string | Uint8Array): boolean;
  close(code?: number, reason?: string): void;
  destroy(): void;
  on(event: 'message', listener: (data: string | Uint8Array, isBinary: boolean) => void): this;
  on(event: 'close', listener: (code: number, reason: string) => void): this;
  on(event: 'closing', listener: (info: { code: number; reason: string }) => void): this;
  on(event: 'ping' | 'pong', listener: (payload: Uint8Array) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'protocolError', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
  off(event: string, listener: (...args: any[]) => void): this;
}

export class WebSocketServer {
  constructor(options?: WebSocketServerOptions);
  readonly secure: boolean;
  readonly boundPort: number | null;
  readonly connections: Set<WebSocketConnection>;
  listen(): Promise<number>;
  close(): Promise<void>;
  on(event: 'connection', listener: (socket: WebSocketConnection, req: UpgradeRequest) => void): this;
  on(event: 'clientRejected', listener: (info: { req: UpgradeRequest; error: Error }) => void): this;
  on(event: 'tlsClientError', listener: (err: Error) => void): this;
  on(event: 'listening', listener: (port: number) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}

export interface ClientConnection {
  readonly closed: boolean;
  readonly socket: unknown;
  send(data: string | Uint8Array, options?: { binary?: boolean }): boolean;
  sendJson(obj: unknown): boolean;
  ping(payload?: string | Uint8Array): boolean;
  pong(payload?: string | Uint8Array): boolean;
  close(code?: number, reason?: string): void;
  /** Next message; messages received before the call are buffered, not lost. */
  nextMessage(timeoutMs?: number): Promise<{ data: string | Uint8Array; isBinary: boolean }>;
  nextPing(timeoutMs?: number): Promise<Uint8Array>;
  nextPong(timeoutMs?: number): Promise<Uint8Array>;
  on(event: 'message', listener: (data: string | Uint8Array, isBinary: boolean) => void): this;
  on(event: 'close', listener: (code: number, reason: string) => void): this;
  on(event: 'ping' | 'pong', listener: (payload: Uint8Array) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
  once(event: string, listener: (...args: any[]) => void): this;
}

/** Client handshake. Certificate verification is on unless `tls` overrides it. */
export function connect(
  url: string,
  options?: { timeoutMs?: number; headers?: Record<string, string>; tls?: WsTlsOptions },
): Promise<ClientConnection>;

export function acceptKey(key: string): string;

export const OPCODE: {
  readonly CONTINUATION: 0x0;
  readonly TEXT: 0x1;
  readonly BINARY: 0x2;
  readonly CLOSE: 0x8;
  readonly PING: 0x9;
  readonly PONG: 0xa;
};
