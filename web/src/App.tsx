import { useEffect, useState } from 'react';
import { useGame } from './store';
import { Lobby } from './components/Lobby';
import { Table } from './components/Table';
import { startSession, stopSession } from './connection';
import { persisted } from './session';

export function App() {
  const session = useGame((s) => s.session);
  const [restoring, setRestoring] = useState(true);

  // Auto-rejoin the last room if the tab reloads mid-game (R-6).
  useEffect(() => {
    const last = persisted.get().lastSession;
    const params = new URLSearchParams(location.search);
    const wantsRoom = params.get('room');
    if (last && (!wantsRoom || wantsRoom.toUpperCase() === last.roomCode)) {
      startSession(last)
        .catch(() => {
          persisted.patch({ lastSession: undefined });
          useGame.getState().setSession(null);
        })
        .finally(() => setRestoring(false));
    } else {
      setRestoring(false);
    }
    return () => stopSession();
  }, []);

  if (restoring) {
    return (
      <div className="lobby">
        <h1>Playmat</h1>
        <div className="tagline">rejoining your table…</div>
      </div>
    );
  }
  return session ? <Table /> : <Lobby />;
}
