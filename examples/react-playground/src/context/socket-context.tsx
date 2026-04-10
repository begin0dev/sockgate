import { createContext, useContext, useEffect } from 'react';
import type { ISocketClient } from 'sockgate';

const SocketContext = createContext<ISocketClient | null>(null);

interface SocketProviderProps {
  client: ISocketClient;
  children: React.ReactNode;
}

export function SocketProvider({ client, children }: SocketProviderProps) {
  useEffect(() => {
    client.connect();
    return () => client.close();
  }, [client]);

  return <SocketContext.Provider value={client}>{children}</SocketContext.Provider>;
}

export function useSocketClient() {
  const client = useContext(SocketContext);
  if (!client) throw new Error('useSocketClient must be used within <SocketProvider>');
  return client;
}
