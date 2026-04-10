import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from '../event-emitter';

interface TestEventMap {
  greet: string;
  count: number;
  empty: undefined;
}

describe('EventEmitter', () => {
  it('on: 리스너가 emit 된 데이터를 받는다', () => {
    const emitter = new EventEmitter<TestEventMap>();
    const listener = vi.fn();

    emitter.on('greet', listener);
    emitter.emit('greet', 'hello');

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith('hello');
  });

  it('on: unsubscribe 함수를 반환하며 호출 시 리스너가 제거된다', () => {
    const emitter = new EventEmitter<TestEventMap>();
    const listener = vi.fn();

    const unsub = emitter.on('greet', listener);
    unsub();
    emitter.emit('greet', 'hello');

    expect(listener).not.toHaveBeenCalled();
  });

  it('off: 특정 리스너만 제거된다', () => {
    const emitter = new EventEmitter<TestEventMap>();
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    emitter.on('greet', listenerA);
    emitter.on('greet', listenerB);
    emitter.off('greet', listenerA);
    emitter.emit('greet', 'hello');

    expect(listenerA).not.toHaveBeenCalled();
    expect(listenerB).toHaveBeenCalledOnce();
  });

  it('emit: 같은 이벤트의 모든 리스너가 호출된다', () => {
    const emitter = new EventEmitter<TestEventMap>();
    const listenerA = vi.fn();
    const listenerB = vi.fn();

    emitter.on('count', listenerA);
    emitter.on('count', listenerB);
    emitter.emit('count', 42);

    expect(listenerA).toHaveBeenCalledWith(42);
    expect(listenerB).toHaveBeenCalledWith(42);
  });

  it('emit: 다른 이벤트의 리스너는 호출되지 않는다', () => {
    const emitter = new EventEmitter<TestEventMap>();
    const greetListener = vi.fn();
    const countListener = vi.fn();

    emitter.on('greet', greetListener);
    emitter.on('count', countListener);
    emitter.emit('greet', 'hello');

    expect(greetListener).toHaveBeenCalledOnce();
    expect(countListener).not.toHaveBeenCalled();
  });

  it('removeAllListeners: 모든 이벤트의 리스너가 제거된다', () => {
    const emitter = new EventEmitter<TestEventMap>();
    const greetListener = vi.fn();
    const countListener = vi.fn();

    emitter.on('greet', greetListener);
    emitter.on('count', countListener);
    emitter.removeAllListeners();

    emitter.emit('greet', 'hello');
    emitter.emit('count', 1);

    expect(greetListener).not.toHaveBeenCalled();
    expect(countListener).not.toHaveBeenCalled();
  });

  it('undefined 타입 이벤트를 emit 할 수 있다', () => {
    const emitter = new EventEmitter<TestEventMap>();
    const listener = vi.fn();

    emitter.on('empty', listener);
    emitter.emit('empty', undefined);

    expect(listener).toHaveBeenCalledOnce();
  });
});
