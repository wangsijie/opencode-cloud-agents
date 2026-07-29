import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import './markdown.css';
import 'katex/dist/katex.min.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Missing #root container');
}

async function boot() {
  // VITE_MOCK runs the SPA against in-memory fixtures — no Worker, no
  // container, no D1. The DEV guard makes the mock chunk unreachable in a
  // production build even if the variable leaks into a build environment.
  if (import.meta.env.DEV && import.meta.env.VITE_MOCK) {
    const { installMocks } = await import('./mock');
    installMocks();
  }
  createRoot(container!).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}

void boot();
