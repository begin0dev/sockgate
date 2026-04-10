import { useState } from 'react';
import { Socket } from './scenarios/socket';
import { SharedWorkerTab } from './scenarios/shared-worker-tab';

const SCENARIOS = [
  { label: 'Socket', component: <Socket /> },
  { label: 'SharedWorker', component: <SharedWorkerTab /> },
];

export default function App() {
  const [active, setActive] = useState(0);

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold mb-1">sockgate playground</h1>
      <p className="text-sm text-gray-400 mb-6">
        {'서버: '}
        <span className="font-mono text-xs bg-gray-800 px-1.5 py-0.5 rounded">
          ws://localhost:3001
        </span>{' '}
        {'— 루트에서 '}
        <code className="font-mono text-xs bg-gray-800 px-1.5 py-0.5 rounded">
          pnpm dev:server
        </code>
        로 먼저 켜주세요.
      </p>

      <div className="flex gap-2 mb-6 flex-wrap">
        {SCENARIOS.map((s, i) => (
          <button
            key={s.label}
            onClick={() => setActive(i)}
            className={`px-4 py-1.5 rounded-lg border-none cursor-pointer text-white text-sm transition-colors ${
              active === i
                ? 'bg-indigo-500'
                : 'bg-gray-700 font-normal hover:bg-gray-600'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="bg-gray-800 rounded-xl p-6 border border-gray-700">
        {SCENARIOS[active].component}
      </div>
    </div>
  );
}
