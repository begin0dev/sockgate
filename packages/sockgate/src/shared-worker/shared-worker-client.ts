import {
  ConnectionState,
  WorkerMessageType,
  type ISocketClient,
  type SharedWorkerClientOptions,
  type SocketEventMap,
  type SubscribeData,
  type WorkerMessage,
} from '../types';
import { EventEmitter } from '../event-emitter';

export class SharedWorkerClient implements ISocketClient {
  readonly #emitter: EventEmitter<SocketEventMap>;
  readonly #options: SharedWorkerClientOptions;
  readonly #subscriptions: Map<
    string,
    { subscribeData: SubscribeData; unsubscribeData: SubscribeData }
  > = new Map();
  #state: ConnectionState = ConnectionState.CLOSED;
  #port: MessagePort | null = null;
  #intentionalClose = false;

  constructor(options: SharedWorkerClientOptions) {
    this.#options = options;
    this.#emitter = new EventEmitter<SocketEventMap>();
  }

  get state(): ConnectionState {
    return this.#state;
  }

  connect(): void {
    if (this.#state !== ConnectionState.CLOSED) return;

    this.#intentionalClose = false;

    if (!this.#port) {
      this.#openPort();
      window.addEventListener('beforeunload', this.#onBeforeUnload);
    }

    if (this.#options.autoReconnect !== false) {
      this.#bindBrowserEvents();
    }
  }

  close(_code?: number, _reason?: string): void {
    if (!this.#port) return;

    this.#intentionalClose = true;
    this.#unbindBrowserEvents();
    window.removeEventListener('beforeunload', this.#onBeforeUnload);

    this.#port.postMessage({ type: WorkerMessageType.DETACH } satisfies WorkerMessage);

    this.#port.onmessage = null;
    try {
      this.#port.close();
    } catch {
      // noop
    }
    this.#port = null;

    const from = this.#state;
    this.#state = ConnectionState.CLOSED;
    if (from !== ConnectionState.CLOSED) {
      this.#emitter.emit('stateChange', { from, to: ConnectionState.CLOSED });
    }
  }

  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void {
    if (this.#state !== ConnectionState.OPEN || !this.#port) {
      throw new Error('WebSocket is not open');
    }
    this.#port.postMessage({ type: WorkerMessageType.SEND, payload: data } satisfies WorkerMessage);
  }

  subscribe(topic: string, subscribeData: SubscribeData, unsubscribeData: SubscribeData): void {
    if (!this.#port) throw new Error('Not connected');
    this.#subscriptions.set(topic, { subscribeData, unsubscribeData });
    this.#port.postMessage({
      type: WorkerMessageType.SUBSCRIBE,
      payload: { topic, subscribeData, unsubscribeData },
    } satisfies WorkerMessage);
  }

  unsubscribe(topic: string): void {
    if (!this.#port) throw new Error('Not connected');
    this.#subscriptions.delete(topic);
    this.#port.postMessage({
      type: WorkerMessageType.UNSUBSCRIBE,
      payload: { topic },
    } satisfies WorkerMessage);
  }

  on<K extends keyof SocketEventMap>(
    event: K,
    listener: (data: SocketEventMap[K]) => void,
  ): () => void {
    return this.#emitter.on(event, listener);
  }

  off<K extends keyof SocketEventMap>(event: K, listener: (data: SocketEventMap[K]) => void): void {
    this.#emitter.off(event, listener);
  }

  #detachPort(): void {
    if (!this.#port) return;
    this.#port.onmessage = null;
    try {
      this.#port.close();
    } catch {
      // noop
    }
    this.#port = null;
    window.removeEventListener('beforeunload', this.#onBeforeUnload);
  }

  #openPort(): void {
    const worker = this.#options.sharedWorkerFactory
      ? this.#options.sharedWorkerFactory()
      : new SharedWorker(this.#options.sharedWorkerUrl!, { type: 'module' });

    this.#port = worker.port;
    this.#port.onmessage = (e: MessageEvent<WorkerMessage>) => {
      this.#handleWorkerMessage(e.data);
    };
    this.#port.start();
  }

  #handleWorkerMessage(msg: WorkerMessage): void {
    switch (msg.type) {
      case WorkerMessageType.OPEN: {
        // 포트 재연결(close → connect) 시 WorkerCore의 subscription set에 이 포트를 다시 추가한다.
        // WorkerCore SUBSCRIBE 핸들러는 idempotent: 이미 다른 포트가 구독 중이면 서버에 중복 전송하지 않음.
        for (const [topic, { subscribeData, unsubscribeData }] of this.#subscriptions) {
          this.#port?.postMessage({
            type: WorkerMessageType.SUBSCRIBE,
            payload: { topic, subscribeData, unsubscribeData },
          } satisfies WorkerMessage);
        }
        const from = this.#state;
        this.#state = ConnectionState.OPEN;
        if (from !== ConnectionState.OPEN) {
          this.#emitter.emit('stateChange', { from, to: ConnectionState.OPEN });
        }
        this.#emitter.emit('open', undefined);
        break;
      }

      case WorkerMessageType.CLOSE_EVENT:
        this.#state = ConnectionState.CLOSED;
        this.#emitter.emit('close', msg.payload);
        break;

      case WorkerMessageType.MESSAGE:
        this.#emitter.emit('message', new MessageEvent('message', { data: msg.payload.data }));
        break;

      case WorkerMessageType.ERROR:
        this.#emitter.emit('error', new Event(msg.payload?.type ?? 'error'));
        break;

      case WorkerMessageType.STATE_CHANGE:
        this.#state = msg.payload.to;
        this.#emitter.emit('stateChange', msg.payload);
        break;

      case WorkerMessageType.RECONNECTING:
        this.#emitter.emit('reconnecting', msg.payload);
        break;

      case WorkerMessageType.RECONNECT_FAILED:
        this.#state = ConnectionState.CLOSED;
        this.#emitter.emit('reconnectFailed', undefined);
        this.#detachPort();
        break;

      case WorkerMessageType.KEEPALIVE:
        break;
    }
  }

  #onVisibilityOrFocus = (): void => {
    if (document.visibilityState === 'hidden') return;
    if (this.#state === ConnectionState.CLOSED && !this.#intentionalClose) {
      this.connect();
    }
  };

  #bindBrowserEvents(): void {
    document.addEventListener('visibilitychange', this.#onVisibilityOrFocus);
    window.addEventListener('focus', this.#onVisibilityOrFocus);
    window.addEventListener('online', this.#onVisibilityOrFocus);
  }

  #unbindBrowserEvents(): void {
    document.removeEventListener('visibilitychange', this.#onVisibilityOrFocus);
    window.removeEventListener('focus', this.#onVisibilityOrFocus);
    window.removeEventListener('online', this.#onVisibilityOrFocus);
  }

  #onBeforeUnload = (): void => {
    this.close();
  };
}
