import type { SocketClientOptions, ISocketClient, SocketEventMap, SubscribeData } from './types';
import { EventEmitter } from './event-emitter';
import { SocketManager } from './socket-manager';

export class SocketClient implements ISocketClient {
  readonly #emitter: EventEmitter<SocketEventMap>;
  readonly #manager: SocketManager;
  readonly #subscriptions: Map<
    string,
    { subscribeData: SubscribeData; unsubscribeData: SubscribeData }
  > = new Map();

  constructor(options: SocketClientOptions) {
    this.#emitter = new EventEmitter<SocketEventMap>();
    this.#manager = new SocketManager(options, this.#emitter);
    this.#emitter.on('open', () => {
      for (const { subscribeData } of this.#subscriptions.values()) {
        this.#manager.send(subscribeData);
      }
    });
  }

  connect(): void {
    this.#manager.connect();
  }

  close(code?: number, reason?: string): void {
    this.#manager.close(code, reason);
  }

  send(data: SubscribeData): void {
    this.#manager.send(data);
  }

  subscribe(topic: string, subscribeData: SubscribeData, unsubscribeData: SubscribeData): void {
    this.#subscriptions.set(topic, { subscribeData, unsubscribeData });
    this.#manager.send(subscribeData);
  }

  unsubscribe(topic: string): void {
    const entry = this.#subscriptions.get(topic);
    if (!entry) return;
    this.#subscriptions.delete(topic);
    this.#manager.send(entry.unsubscribeData);
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

  get state() {
    return this.#manager.state;
  }
}
