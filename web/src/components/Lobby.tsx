import { useState } from 'react';
import { normalizeRoomCode } from '@playmat/shared';
import { createRoom, joinRoom, startSession } from '../connection';
import { persisted } from '../session';

export function Lobby() {
  const stored = persisted.get();
  const [name, setName] = useState(stored.name ?? '');
  const [code, setCode] = useState(new URLSearchParams(location.search).get('room') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async (mode: 'create' | 'join') => {
    setBusy(true);
    setError(null);
    try {
      const displayName = name.trim() || 'Player';
      const resp =
        mode === 'create'
          ? await createRoom(displayName)
          : await joinRoom(normalizeRoomCode(code), displayName);
      await startSession({
        roomCode: resp.roomCode,
        playerId: resp.playerId,
        seat: resp.seat,
        token: resp.token,
        rejoinKey: resp.rejoinKey,
        name: displayName,
      });
      history.replaceState(null, '', `?room=${resp.roomCode}`);
    } catch (err) {
      setError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lobby">
      <h1>
        <img src="/logo.svg" alt="Playmat" style={{ width: 'min(400px, 80vw)', display: 'block' }} />
      </h1>
      <div className="tagline">a shared kitchen table for paper-style Magic</div>
      <div className="card">
        <div className="row">
          <input
            placeholder="Your display name"
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="row">
          <button className="primary" disabled={busy || !name.trim()} onClick={() => go('create')}>
            Create a room
          </button>
          <span className="subtle">or</span>
          <input
            placeholder="Room code"
            value={code}
            maxLength={8}
            style={{ width: 110, textTransform: 'uppercase', letterSpacing: 2 }}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && code && go('join')}
          />
          <button disabled={busy || !name.trim() || normalizeRoomCode(code).length < 4} onClick={() => go('join')}>
            Join
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="subtle">
          No accounts. Rooms hold up to four seats; extra joiners spectate. You'll import a deck once
          you're at the table.
        </div>
      </div>
    </div>
  );
}
