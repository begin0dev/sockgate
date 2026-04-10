import { useState } from 'react';
import { useSocket } from '../hooks/use-socket';
import { LogPanel } from './log-panel';
import { StateBadge } from './state-badge';

const CHANNELS = ['ticker', 'trades'] as const;
const SYMBOLS = ['AAPL', 'TSLA', 'NVDA'] as const;

type Channel = (typeof CHANNELS)[number];
type Symbol = (typeof SYMBOLS)[number];

interface SocketScenarioProps {
  title: string;
  description: React.ReactNode;
}

export function SocketScenario({ title, description }: SocketScenarioProps) {
  const { state, logs, subscribe, unsubscribe, connect, close, clearLogs } = useSocket();
  const [subscribed, setSubscribed] = useState<Set<string>>(new Set());

  const isClosed = state === 'CLOSED';

  const subscriptionKey = (channel: Channel, symbol: Symbol) => `${channel}:${symbol}`;

  const handleSubscribe = (channel: Channel, symbol: Symbol) => {
    const key = subscriptionKey(channel, symbol);
    subscribe(
      key,
      JSON.stringify({ type: 'subscribe', payload: { channel, symbol } }),
      JSON.stringify({ type: 'unsubscribe', payload: { channel, symbol } }),
    );
    setSubscribed((prev) => new Set(prev).add(key));
  };

  const handleUnsubscribe = (channel: Channel, symbol: Symbol) => {
    const key = subscriptionKey(channel, symbol);
    unsubscribe(key);
    setSubscribed((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };

  return (
    <section>
      <h2 className="text-lg font-semibold mb-2">{title}</h2>
      <p className="text-sm text-gray-400 mb-3 leading-relaxed">{description}</p>
      <div className="flex items-center justify-between mb-4">
        <div>
          State: <StateBadge state={state} />
        </div>
        <div className="flex gap-2">
          {isClosed ?
            <button
              onClick={connect}
              className="px-3.5 py-1.5 rounded-md bg-green-600 hover:bg-green-700 text-white text-sm font-medium cursor-pointer border-none"
            >
              Connect
            </button>
          : <button
              onClick={close}
              disabled={isClosed}
              className="px-3.5 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium cursor-pointer border-none disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Close
            </button>
          }
        </div>
      </div>

      <div className="space-y-3 mb-4">
        {CHANNELS.map((channel) => (
          <div key={channel} className="bg-gray-900 rounded-lg p-3">
            <p className="text-xs text-gray-400 font-medium uppercase tracking-wider mb-2">
              {channel}
            </p>
            <div className="flex flex-wrap gap-2">
              {SYMBOLS.map((symbol) => {
                const key = subscriptionKey(channel, symbol);
                const isSubscribed = subscribed.has(key);
                return (
                  <div key={symbol} className="flex items-center gap-1">
                    <button
                      onClick={() =>
                        isSubscribed
                          ? handleUnsubscribe(channel, symbol)
                          : handleSubscribe(channel, symbol)
                      }
                      className={`px-3 py-1 rounded-md text-white text-sm font-medium cursor-pointer border-none transition-colors ${
                        isSubscribed
                          ? 'bg-yellow-600 hover:bg-yellow-700'
                          : 'bg-indigo-500 hover:bg-indigo-600'
                      }`}
                    >
                      {isSubscribed ? `Unsubscribe ${symbol}` : `Subscribe ${symbol}`}
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <LogPanel logs={logs} onClear={clearLogs} />
    </section>
  );
}
