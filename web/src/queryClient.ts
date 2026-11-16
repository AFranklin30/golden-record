import { QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError } from './api';
import { sessionKey } from './features/session/session';

export function createQueryClient() {
  const client = new QueryClient({
    queryCache: new QueryCache({
      onError(error, query) {
        if (!(error instanceof ApiError) || error.kind !== 'unauthorized') return;
        if (query.queryKey[0] === sessionKey[0]) return;
        void client.invalidateQueries({ queryKey: sessionKey });
      },
    }),
    defaultOptions: {
      queries: {
        retry(failureCount, error) {
          if (error instanceof ApiError && error.kind !== 'server' && error.kind !== 'network') return false;
          return failureCount < 2;
        },
      },
    },
  });
  return client;
}
