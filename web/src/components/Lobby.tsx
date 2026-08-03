import { useState } from 'react';
import { normalizeRoomCode } from '@playmat/shared';
import { createRoom, joinRoom, startSession } from '../connection';
import { persisted } from '../session';

/** Be lenient: a pasted invite URL (or anything with ?room=) yields its code. */
function extractRoomCode(text: string): string {
  const m = text.match(/[?&]room=([A-Za-z0-9]+)/i);
  return m ? m[1] : text;
}

export function Lobby() {
  const stored = persisted.get();
  const [name, setName] = useState(stored.name ?? '');
  const [code, setCode] = useState(new URLSearchParams(location.search).get('room') ?? '');
  /** Arrived via invite link — joining is the point, so Join leads. */
  const [invited] = useState(() => !!new URLSearchParams(location.search).get('room'));
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
      // The URL sync lives in App, keyed off the session — one source of truth.
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
        {/* Join is the primary action whenever there's a code to join (typed
            or from an invite link); Create leads only on a bare visit. The
            row order is fixed at mount so nothing jumps around mid-typing. */}
        {(() => {
          const joinable = normalizeRoomCode(code).length >= 4;
          const codeInput = (
            <input
              placeholder="Code or link"
              value={code}
              maxLength={80}
              style={{ width: invited ? 110 : 170, textTransform: 'uppercase', letterSpacing: 2 }}
              onChange={(e) => setCode(extractRoomCode(e.target.value))}
              onKeyDown={(e) => e.key === 'Enter' && joinable && go('join')}
            />
          );
          const joinBtn = (
            <button
              className={joinable ? 'primary' : ''}
              disabled={busy || !name.trim() || !joinable}
              onClick={() => go('join')}
            >
              Join
            </button>
          );
          const createBtn = (
            <button
              className={joinable ? '' : 'primary'}
              disabled={busy || !name.trim()}
              onClick={() => go('create')}
            >
              Create a room
            </button>
          );
          return invited ? (
            <div className="row">
              {codeInput}
              {joinBtn}
              <span className="subtle">or</span>
              {createBtn}
            </div>
          ) : (
            <div className="row">
              {createBtn}
              <span className="subtle">or</span>
              {codeInput}
              {joinBtn}
            </div>
          );
        })()}
        {error && <div className="error">{error}</div>}
        <div className="subtle">
          No accounts. Rooms hold up to four seats; extra joiners spectate. You'll import a deck once
          you're at the table.
        </div>
      </div>
      <a className="lobby-link" href="#about">
        About
      </a>
    </div>
  );
}
