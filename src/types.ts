export const ConnectionState = {
  CONNECTING: 'CONNECTING',
  OPEN: 'OPEN',
  CLOSING: 'CLOSING',
  CLOSED: 'CLOSED',
} as const;

export type ConnectionState = (typeof ConnectionState)[keyof typeof ConnectionState];

export interface SocketEventMap {
  open: undefined;
  close: { code: number; reason: string; wasClean: boolean };
  message: MessageEvent;
  error: Event;
  stateChange: { from: ConnectionState; to: ConnectionState };
  reconnecting: { attempt: number; delay: number };
  reconnectFailed: undefined;
}

export interface IManager {
  connect(): void;
  close(code?: number, reason?: string): void;
  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void;
  readonly state: ConnectionState;
}

export interface SocketClientOptions {
  url: string;
  protocols?: string | string[];
  autoReconnect?: boolean;
  reconnectionAttempts?: number;
  reconnectionDelay?: number;
  reconnectionDelayMax?: number;
  randomizationFactor?: number;
  useSharedWorker?: boolean;
  sharedWorkerUrl?: string;
}

export interface WorkerConnectPayload {
  url: string;
  protocols?: string | string[];
  reconnectionAttempts?: number;
  reconnectionDelay?: number;
  reconnectionDelayMax?: number;
  randomizationFactor?: number;
}

export const WorkerMessageType = {
  // Client → Worker
  CONNECT: 'CONNECT',
  SEND: 'SEND',
  CLOSE: 'CLOSE',
  // Worker → Client
  STATE_CHANGE: 'STATE_CHANGE',
  MESSAGE: 'MESSAGE',
  ERROR: 'ERROR',
  OPEN: 'OPEN',
  CLOSE_EVENT: 'CLOSE_EVENT',
  RECONNECTING: 'RECONNECTING',
  RECONNECT_FAILED: 'RECONNECT_FAILED',
  /** Worker가 주기적으로 broadcast — dead 포트 감지용 */
  PING: 'PING',
} as const;

export type WorkerMessageType = (typeof WorkerMessageType)[keyof typeof WorkerMessageType];

export interface WorkerMessage {
  type: WorkerMessageType;
  payload?: any;
}
