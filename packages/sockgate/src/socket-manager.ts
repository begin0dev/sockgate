import {
  ConnectionState,
  type SocketClientOptions,
  type HeartbeatContext,
  type SocketEventMap,
} from './types';
import type { EventEmitter } from './event-emitter';

export class SocketManager {
  #ws: WebSocket | null = null;
  #state: ConnectionState = ConnectionState.CLOSED;
  #intentionalClose = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #closeWatchdog: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  readonly #options: SocketClientOptions;
  readonly #emitter: EventEmitter<SocketEventMap>;
  #heartbeatCleanup: (() => void) | null = null;
  #heartbeatMessageListeners: ((event: MessageEvent) => void) | null = null;

  static readonly #closeWatchdogMs = 3_000;

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
      this.#startHeartbeat();
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
      this.#handleMessage(event);
    };

    if (this.#options.reconnect) {
      this.#bindBrowserEvents();
    }
  }

  close(code?: number, reason?: string): void {
    this.#intentionalClose = true;
    this.#clearRetryTimer();
    this.#clearHeartbeat();
    this.#unbindBrowserEvents();

    if (!this.#ws) {
      this.#setState(ConnectionState.CLOSED);
      return;
    }
    this.#setState(ConnectionState.CLOSING);

    const ws = this.#ws;
    if (ws.readyState === WebSocket.CONNECTING) {
      ws.addEventListener(
        'open',
        () => {
          try {
            ws.close(code, reason);
          } catch {
            // noop
          }
        },
        { once: true },
      );
    } else {
      try {
        ws.close(code, reason);
      } catch {
        // noop
      }
    }

    this.#closeWatchdog = setTimeout(() => {
      this.#closeWatchdog = null;
      this.#handleClose({ code: code ?? 1000, reason: reason ?? '', wasClean: false });
    }, SocketManager.#closeWatchdogMs);
  }

  #handleClose(payload: { code: number; reason: string; wasClean: boolean }): void {
    if (this.#state === ConnectionState.CLOSED) return;

    this.#clearCloseWatchdog();
    this.#clearHeartbeat();
    this.#emitter.emit('close', payload);
    this.#clearWs();
    this.#setState(ConnectionState.CLOSED);

    if (this.#intentionalClose) {
      this.#unbindBrowserEvents();
    } else {
      this.#scheduleReconnect();
    }
  }

  #handleMessage(event: MessageEvent): void {
    this.#heartbeatMessageListeners?.(event);
    this.#emitter.emit('message', event);
  }

  send(data: string | ArrayBuffer | Blob | ArrayBufferView): void {
    if (this.#state !== ConnectionState.OPEN || !this.#ws) {
      throw new Error('WebSocket is not open');
    }
    this.#ws.send(data as Parameters<WebSocket['send']>[0]);
  }

  #startHeartbeat(): void {
    if (!this.#options.heartbeat) return;

    const ctx: HeartbeatContext = {
      send: (data) => {
        if (this.#state === ConnectionState.OPEN && this.#ws) {
          try {
            this.#ws.send(data as Parameters<WebSocket['send']>[0]);
          } catch {
            // noop
          }
        }
      },
      onMessage: (handler) => {
        this.#heartbeatMessageListeners = handler;
        return () => (this.#heartbeatMessageListeners = null);
      },
      reconnect: () => {
        this.close(4000, 'heartbeat');
        setTimeout(() => {
          if (this.#state === ConnectionState.CLOSED) this.connect();
        }, 0);
      },
    };

    const cleanup = this.#options.heartbeat(ctx);
    this.#heartbeatCleanup = cleanup ?? null;
  }

  #clearHeartbeat(): void {
    this.#heartbeatCleanup?.();
    this.#heartbeatCleanup = null;
    this.#heartbeatMessageListeners = null;
  }

  #nextDelay(): number | null {
    const maxAttempts = this.#options.reconnect?.attempts ?? Infinity;
    if (this.#attempt >= maxAttempts) return null;

    const baseDelay = this.#options.reconnect?.delay ?? 1000;
    const maxDelay = this.#options.reconnect?.delayMax ?? 30000;
    const factor = this.#options.reconnect?.factor ?? 0.5;

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
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.#onVisibilityOrFocus);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', this.#onVisibilityOrFocus);
      window.addEventListener('online', this.#onVisibilityOrFocus);
    }
  }

  #unbindBrowserEvents(): void {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisibilityOrFocus);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', this.#onVisibilityOrFocus);
      window.removeEventListener('online', this.#onVisibilityOrFocus);
    }
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
