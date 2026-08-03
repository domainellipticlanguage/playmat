import { useEffect, useState } from 'react';
import { useGame } from './store';
import { Lobby } from './components/Lobby';
import { About } from './components/About';
import { Table } from './components/Table';
import { startSession, stopSession } from './connection';
import { persisted } from './session';

export function App() {
  const session = useGame((s) => s.session);
  const [restoring, setRestoring] = useState(true);

  // #about is the only other "page". Hash routing keeps the back arrow and
  // bookmarks working without pulling in a router for one static view.
  const [showAbout, setShowAbout] = useState(location.hash === '#about');
  useEffect(() => {
    const onHash = () => {
      setShowAbout(location.hash === '#about');
      // Leaving via an href="#" link strands a bare trailing '#'; tidy it.
      if (!location.hash) history.replaceState(null, '', location.pathname + location.search);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // Auto-rejoin the last room if the tab reloads mid-game (R-6).
  //
  // Only a URL that names a room resumes a table. The bare root is always the
  // lobby: a saved session used to drag you straight back to your old table,
  // which left no way to reach the lobby short of clearing storage.
  useEffect(() => {
    const last = persisted.get().lastSession;
    const wantsRoom = new URLSearchParams(location.search).get('room');
    if (wantsRoom && last && wantsRoom.toUpperCase() === last.roomCode) {
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

  // Being in a room always shows the code in the URL, so the address bar is a
  // shareable invite and a reload lands back at the same table. Entering a
  // room PUSHES a history entry, so the browser's back arrow returns to the
  // lobby. An un-joined ?room= is left alone so an invite link still prefills
  // the lobby.
  useEffect(() => {
    if (!session) return;
    const params = new URLSearchParams(location.search);
    if (params.get('room') === session.roomCode) return;
    params.set('room', session.roomCode);
    history.pushState(null, '', `${location.pathname}?${params}`);
  }, [session?.roomCode]);

  // Back/forward arrows: the URL is the source of truth. Landing on a ?room=
  // that matches the saved session re-enters the table; landing on a bare URL
  // (or a room we can't resume) shows the lobby.
  useEffect(() => {
    const onPop = () => {
      const wantsRoom = new URLSearchParams(location.search).get('room')?.toUpperCase();
      const current = useGame.getState().session;
      if (current && current.roomCode === wantsRoom) return;
      if (current) {
        stopSession();
        useGame.getState().setSession(null);
      }
      const last = persisted.get().lastSession;
      if (wantsRoom && last && wantsRoom === last.roomCode) {
        void startSession(last).catch(() => {
          persisted.patch({ lastSession: undefined });
          useGame.getState().setSession(null);
        });
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  if (restoring) {
    return (
      <div className="lobby">
        <h1>Playmat</h1>
        <div className="tagline">rejoining your table…</div>
      </div>
    );
  }
  if (!session && showAbout) return <About />;
  return session ? <Table /> : <Lobby />;
}
