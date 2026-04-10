import { ConnectionState } from 'sockgate';

const COLOR: Record<string, string> = {
  [ConnectionState.OPEN]: 'bg-green-400',
  [ConnectionState.CONNECTING]: 'bg-yellow-400',
  [ConnectionState.CLOSING]: 'bg-orange-400',
  [ConnectionState.CLOSED]: 'bg-red-400',
};

export function StateBadge({ state }: { state: string }) {
  return (
    <span
      className={`inline-block px-2.5 py-0.5 rounded-full font-bold text-xs text-black ${COLOR[state] ?? 'bg-gray-500'}`}
    >
      {state}
    </span>
  );
}
