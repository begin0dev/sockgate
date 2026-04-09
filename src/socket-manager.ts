import {
  ConnectionState,
  type IManager,
  type SocketClientOptions,
  type SocketEventMap,
} from './types';
import type { EventEmitter } from './event-emitter';

export class SocketManager implements IManager {
  #ws: WebSocket | null = null;
  #state: ConnectionState = ConnectionState.CLOSED;
  #intentionalClose = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #closeWatchdog: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  readonly #options: SocketClientOptions;
  readonly #emitter: EventEmitter<SocketEventMap>;
  static readonly #closeWatchdogMs = 3000;

  constructor(options: SocketClientOptions, emitter: EventEmitter<SocketEventMap>) {
    this.#options = options;
    this.#emitter = emitter;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  connect(): void {
    if (this.#state === ConnectionState.CONNECTING || this.#state === ConnectionState.OPEN) {
      return;
    }

    this.#intentionalClose = false;
    this.#clearCloseWatchdog();
    this.#clearWs();
    this.#setState(ConnectionState.CONNECTING);

    this.#ws = new WebSocket(this.#options.url, this.#options.protocols);

    this.#ws.onopen = () => {
      this.#attempt = 0;
      this.#setState(ConnectionState.OPEN);
      this.#emitter.emit('open', undefined);
    };

    this.#ws.onclose = (event) => {
      this.#handleClose({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
    };

    this.#ws.onerror = (event) => {
      this.#emitter.emit('error', event);
    };

    this.#ws.onmessage = (event) => {
      this.#emitter.emit('message', event);
    };

    if (this.#options.autoReconnect !== false) {
      this.#bindBrowserEvents();
    }
  }

  close(code?: number, reason?: string): void {
    this.#intentionalClose = true;
    this.#clearRetryTimer();
    this.#unbindBrowserEvents();

    if (!this.#ws) {
      this.#setState(ConnectionState.CLOSED);
      return;
    }
    this.#setState(ConnectionState.CLOSING);
    try {
      this.#ws.close(code, reason);
    } catch {
      // noop — 어차피 아래 handleClose로 정리
    }

    this.#closeWatchdog = setTimeout(() => {
      this.#closeWatchdog = null;
      this.#handleClose({ code: code ?? 1000, reason: reason ?? '', wasClean: false });
    }, SocketManager.#closeWatchdogMs);
  }

  #handleClose(payload: { code: number; reason: string; wasClean: boolean }): void {
    if (this.#state === ConnectionState.CLOSED) return;

    this.#clearCloseWatchdog();
    this.#emitter.emit('close', payload);
    this.#clearWs();
    this.#setState(ConnectionState.CLOSED);

    if (this.#intentionalClose) {
      this.#unbindBrowserEvents();
    } else {
      this.#scheduleReconnect();
    }
  }

  send(data: string | ArrayBuffer | Blob): void {
    if (this.#state !== ConnectionState.OPEN || !this.#ws) {
      throw new Error('WebSocket is not open');
    }
    this.#ws.send(data);
  }

  #nextDelay(): number | null {
    const maxAttempts = this.#options.reconnectionAttempts ?? Infinity;
    if (this.#attempt >= maxAttempts) return null;

    const baseDelay = this.#options.reconnectionDelay ?? 1000;
    const maxDelay = this.#options.reconnectionDelayMax ?? 30000;
    const factor = this.#options.randomizationFactor ?? 0.5;

    const exponential = baseDelay * Math.pow(2, this.#attempt);
    const capped = Math.min(exponential, maxDelay);
    const noise = 1 - factor + Math.random() * factor;

    this.#attempt++;
    return Math.round(capped * noise);
  }

  #scheduleReconnect(): void {
    const delay = this.#nextDelay();

    if (delay === null) {
      this.#setState(ConnectionState.CLOSED);
      this.#emitter.emit('reconnectFailed', undefined);
      return;
    }

    this.#emitter.emit('reconnecting', { attempt: this.#attempt, delay });

    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.connect();
    }, delay);
  }

  #onVisibilityOrFocus = (): void => {
    if (document.visibilityState === 'hidden') return;

    if (this.#state === ConnectionState.CLOSED && !this.#intentionalClose) {
      this.#clearRetryTimer();
      this.#attempt = 0;
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

  #setState(newState: ConnectionState): void {
    if (this.#state === newState) return;
    const from = this.#state;
    this.#state = newState;
    this.#emitter.emit('stateChange', { from, to: newState });
  }

  #clearWs(): void {
    if (!this.#ws) return;
    this.#ws.onopen = null;
    this.#ws.onclose = null;
    this.#ws.onerror = null;
    this.#ws.onmessage = null;
    this.#ws = null;
  }

  #clearRetryTimer(): void {
    clearTimeout(this.#retryTimer ?? undefined);
    this.#retryTimer = null;
  }

  #clearCloseWatchdog(): void {
    clearTimeout(this.#closeWatchdog ?? undefined);
    this.#closeWatchdog = null;
  }
}
