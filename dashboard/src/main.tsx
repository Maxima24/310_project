import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
// Tokens first: every rule in app.css resolves against them.
import './styles/tokens.css';
import './styles/app.css';

/**
 * One QueryClient for the app. TanStack Query owns all server state; the socket layer
 * writes into this same cache, so there is exactly one copy of each entity.
 */
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The socket delivers changes, so aggressive refocus refetching would mostly
      // produce redundant requests. Individual queries opt into polling where the data
      // genuinely ages (agent last-seen times).
      refetchOnWindowFocus: false,
      staleTime: 10_000,
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
