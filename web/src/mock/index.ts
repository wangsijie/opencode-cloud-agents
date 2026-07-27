/**
 * Container-free dev mode.
 *
 * `pnpm dev:mock` sets VITE_MOCK=1; main.tsx then calls `installMocks()`
 * before the first render. Every `/api` request is answered from in-memory
 * fixtures and the event stream is simulated — no wrangler, no Docker, no D1.
 * All mutations live in memory and reset on reload.
 */
import { setApiFetch, setSessionEventSource } from '../api';
import { createMockEventSource } from './events';
import { MOCK_SENTINEL } from './fixtures/util';
import { handleMockFetch } from './router';
import { startAmbientScripts } from './store';

export function installMocks(): void {
  setApiFetch(handleMockFetch);
  setSessionEventSource(createMockEventSource);
  startAmbientScripts();
  console.info(
    `[mock] OpenCode Hub running against in-memory fixtures (${MOCK_SENTINEL}); all changes reset on reload`
  );
}
