type Listener<T> = (data: T) => void;

export class EventEmitter<TMap extends Record<string, any>> {
  #listeners: {
    [K in keyof TMap]?: Set<Listener<TMap[K]>>;
  } = {};

  on<K extends keyof TMap>(event: K, listener: Listener<TMap[K]>): () => void {
    if (!this.#listeners[event]) {
      this.#listeners[event] = new Set();
    }
    this.#listeners[event]?.add(listener);
    return () => this.off(event, listener);
  }

  off<K extends keyof TMap>(event: K, listener: Listener<TMap[K]>): void {
    this.#listeners[event]?.delete(listener);
  }

  emit<K extends keyof TMap>(event: K, data: TMap[K]): void {
    this.#listeners[event]?.forEach((listener) => listener(data));
  }

  removeAllListeners(): void {
    for (const key in this.#listeners) {
      delete this.#listeners[key];
    }
  }
}
