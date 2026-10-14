import React, { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

// Dev-only perf hook for scripts/perf-bench.mjs: React commit time + count,
// and the stores/actions so the bench can stage a busy table.
const perf = { commits: 0, ms: 0 };
if (import.meta.env.DEV) {
  void Promise.all([import('./store'), import('./uiStore'), import('./actions')]).then(([s, u, a]) => {
    (window as unknown as { __playmat: unknown }).__playmat = { perf, useGame: s.useGame, useUI: u.useUI, actions: a };
  });
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Profiler
      id="app"
      onRender={(_id, _phase, actual) => {
        perf.commits++;
        perf.ms += actual;
      }}
    >
      <App />
    </Profiler>
  </React.StrictMode>
);
