import {
  ConnectionState,
  WorkerMessageType,
  type IManager,
  type SocketClientOptions,
  type SocketEventMap,
  type WorkerConnectPayload,
  type WorkerMessage,
} from '../types';
import type { EventEmitter } from '../event-emitter';

export class SharedWorkerManager implements IManager {
  readonly #emitter: EventEmitter<SocketEventMap>;
  readonly #options: SocketClientOptions;
  #state: ConnectionState = ConnectionState.CLOSED;
  #port: MessagePort | null = null;
  #intentionalClose = false;

  constructor(options: SocketClientOptions, emitter: EventEmitter<SocketEventMap>) {
    this.#options = options;
    this.#emitter = emitter;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  #openPort(): void {
    const worker = new SharedWorker(this.#options.sharedWorkerUrl!);
    this.#port = worker.port;
    this.#port.onmessage = (e: MessageEvent<WorkerMessage>) => {
      this.#handleWorkerMessage(e.data);
    };
    this.#port.start();
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

    const payload: WorkerConnectPayload = {
      url: this.#options.url,
      protocols: this.#options.protocols,
      reconnectionAttempts: this.#options.reconnectionAttempts,
      reconnectionDelay: this.#options.reconnectionDelay,
      reconnectionDelayMax: this.#options.reconnectionDelayMax,
      randomizationFactor: this.#options.randomizationFactor,
    };

    this.#port!.postMessage({
      type: WorkerMessageType.CONNECT,
      payload,
    } satisfies WorkerMessage);
  }

  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void {
    if (this.#state !== ConnectionState.OPEN || !this.#port) {
      throw new Error('WebSocket is not open');
    }
    this.#port.postMessage({
      type: WorkerMessageType.SEND,
      payload: data,
    } satisfies WorkerMessage);
  }

  close(_code?: number, _reason?: string): void {
    if (!this.#port) return;

    this.#intentionalClose = true;
    this.#unbindBrowserEvents();
    window.removeEventListener('beforeunload', this.#onBeforeUnload);

    this.#port.postMessage({
      type: WorkerMessageType.CLOSE,
    } satisfies WorkerMessage);

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

  #handleWorkerMessage(msg: WorkerMessage): void {
    switch (msg.type) {
      case WorkerMessageType.OPEN:
        this.#state = ConnectionState.OPEN;
        this.#emitter.emit('open', undefined);
        break;

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
