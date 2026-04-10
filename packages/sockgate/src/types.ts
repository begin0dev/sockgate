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

/**
 * heartbeat 콜백에 주입되는 소켓 컨텍스트.
 *
 * - `send`      : 서버로 데이터 전송 (ping 등)
 * - `onMessage` : 서버로부터 메시지 수신 구독, unsubscribe 함수 반환
 * - `reconnect` : 현재 연결을 끊고 재연결 (pong 타임아웃 등)
 */
export interface HeartbeatContext {
  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void;
  onMessage(handler: (event: MessageEvent) => void): () => void;
  reconnect(): void;
}

/**
 * heartbeat 콜백 타입.
 *
 * 소켓이 열릴 때 호출되며, cleanup 함수를 반환하면 소켓이 닫힐 때 자동 호출된다.
 *
 * 함수는 소켓을 실제로 소유하는 컨텍스트에서 호출되므로 자유롭게 클로저를 써도 된다.
 * postMessage 경계를 넘지 않는다.
 *
 * @example
 * ```ts
 * heartbeat: (ctx) => {
 *   let pingId: string | null = null;
 *   let pongTimer: ReturnType<typeof setTimeout> | null = null;
 *
 *   const interval = setInterval(() => {
 *     const id = crypto.randomUUID();
 *     pingId = id;
 *     ctx.send(JSON.stringify({ type: 'ping', id }));
 *     pongTimer = setTimeout(() => ctx.reconnect(), 5_000);
 *   }, 10_000);
 *
 *   const unsub = ctx.onMessage((event) => {
 *     const msg = JSON.parse(String(event.data));
 *     if (msg?.type === 'pong' && msg?.requestId === pingId) {
 *       clearTimeout(pongTimer!);
 *       pongTimer = null;
 *     }
 *   });
 *
 *   return () => { clearInterval(interval); clearTimeout(pongTimer!); unsub(); };
 * }
 * ```
 */
export type HeartbeatFn = (ctx: HeartbeatContext) => (() => void) | void;

/**
 * 실제로 WebSocket을 소유하는 쪽(메인 스레드 SocketClient 또는
 */
export interface SocketClientOptions {
  url: string;
  protocols?: string | string[];
  reconnect?: {
    attempts?: number;
    delay?: number;
    delayMax?: number;
    factor?: number;
  };
  heartbeat?: HeartbeatFn;
}

/**
 * 메인 스레드의 SharedWorkerClient 설정.
 * 연결 설정(url 등)은 워커 엔트리의 SocketClient가 소유하므로 여기 없다.
 */
export interface SharedWorkerClientOptions {
  sharedWorkerFactory?: () => SharedWorker;
  sharedWorkerUrl?: string;
  /** 브라우저 이벤트 기반 포트 재부착. 기본 true */
  autoReconnect?: boolean;
}

/**
 * SocketClient와 SharedWorkerClient의 공통 인터페이스.
 * React 레이어 등에서 어떤 구현체든 동일하게 다룰 수 있도록.
 */
export interface ISocketClient {
  connect(): void;
  close(code?: number, reason?: string): void;
  send(data: SubscribeData): void;
  /**
   * 토픽을 구독한다.
   *
   * - `SocketClient`: `send(subscribeData)`를 즉시 호출하고 `unsubscribeData`를 내부에 저장한다.
   * - `SharedWorkerClient`: 같은 토픽의 첫 번째 탭일 때만 `subscribeData`를 서버에 전송한다 (레퍼런스 카운팅).
   *
   * @param topic 구독을 식별하는 키. `unsubscribe()` 시 동일한 값을 사용한다.
   * @param subscribeData 서버에 보낼 구독 메시지.
   * @param unsubscribeData 서버에 보낼 구독 해제 메시지.
   */
  subscribe(topic: string, subscribeData: SubscribeData, unsubscribeData: SubscribeData): void;
  /**
   * 토픽 구독을 해제한다.
   *
   * - `SocketClient`: `subscribe()` 시 저장한 `unsubscribeData`를 `send()`로 전송한다.
   * - `SharedWorkerClient`: 마지막 탭일 때만 서버에 `unsubscribeData`를 전송한다 (레퍼런스 카운팅).
   *
   * @param topic `subscribe()` 시 사용한 것과 동일한 토픽 키.
   */
  unsubscribe(topic: string): void;
  on<K extends keyof SocketEventMap>(
    event: K,
    listener: (data: SocketEventMap[K]) => void,
  ): () => void;
  off<K extends keyof SocketEventMap>(event: K, listener: (data: SocketEventMap[K]) => void): void;
  readonly state: ConnectionState;
}

// ─── Worker ↔ Port 프로토콜 ─────────────────────────────────────────────────

export const WorkerMessageType = {
  // Client → Worker
  SEND: 'SEND',
  DETACH: 'DETACH',
  /**
   * 토픽 구독 요청.
   * payload: { topic: string; subscribeData: SubscribeData; unsubscribeData: SubscribeData }
   * 같은 토픽의 첫 번째 구독자일 때만 서버에 subscribeData를 전송한다.
   */
  SUBSCRIBE: 'SUBSCRIBE',
  /**
   * 토픽 구독 해제 요청.
   * payload: { topic: string }
   * 마지막 구독자가 해제할 때만 서버에 저장된 unsubscribeData를 전송한다.
   */
  UNSUBSCRIBE: 'UNSUBSCRIBE',
  // Worker → Client
  STATE_CHANGE: 'STATE_CHANGE',
  MESSAGE: 'MESSAGE',
  ERROR: 'ERROR',
  OPEN: 'OPEN',
  CLOSE_EVENT: 'CLOSE_EVENT',
  RECONNECTING: 'RECONNECTING',
  RECONNECT_FAILED: 'RECONNECT_FAILED',
  /** 포트 생존 확인용 (WebSocket 하트비트와 무관) */
  KEEPALIVE: 'KEEPALIVE',
} as const;

export type SubscribeData = string | ArrayBuffer | Blob | ArrayBufferView;

export type WorkerMessageType = (typeof WorkerMessageType)[keyof typeof WorkerMessageType];

export interface WorkerMessage {
  type: WorkerMessageType;
  payload?: any;
}
