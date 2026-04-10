import { useMemo } from 'react';
import SharedWorkerCtor from '../shared-worker?sharedworker';
import { SharedWorkerClient } from 'sockgate';
import { SocketProvider } from '../context/socket-context';
import { SocketScenario } from '../components/socket-scenario';

export function SharedWorkerTab() {
  const client = useMemo(
    () =>
      new SharedWorkerClient({
        sharedWorkerFactory: () => new SharedWorkerCtor(),
      }),
    [],
  );

  return (
    <SocketProvider client={client}>
      <SocketScenario
        title="2. SharedWorker (다중 탭)"
        description={
          <>
            {'이 탭을 여러 개 열어보세요. 모든 탭이 '}
            <strong className="text-gray-200">하나의 WebSocket 연결</strong>을 공유합니다.
          </>
        }
      />
    </SocketProvider>
  );
}
