import { useEffect, useState } from 'react';
import { useGame } from '../store';
import { useUI } from '../uiStore';
import * as actions from '../actions';
import { stopSession } from '../connection';
import { persisted } from '../session';
import { Battlefield } from './Battlefield';
import { Hand } from './Hand';
import { PlayerHud } from './PlayerHud';
import { ModalHost } from './Modals';
import { ContextMenuHost } from './ContextMenu';
import { DiceOverlay, HoverPreview, LogPanel } from './Panels';
import { TABLE, liveView, screenToWorld } from '../view';

function centerDropSpot() {
  const w = screenToWorld(liveView.current, window.innerWidth / 2, window.innerHeight / 2);
  return { x: Math.min(Math.max(w.x, 100), TABLE - 100), y: Math.min(Math.max(w.y, 100), TABLE - 100) };
}

export function Table() {
  const session = useGame((s) => s.session);
  const players = useGame((s) => s.players);
  const connStatus = useGame((s) => s.connStatus);
  const room = useGame((s) => s.room);
  const pool = useGame((s) => s.pool);
  const [showLog, setShowLog] = useState(true);
  const [copied, setCopied] = useState(false);

  const me = session?.playerId;
  const spectator = session?.seat === null;
  const iHaveDeck = Object.values(pool).some((p) => p.ownerId === me && !p.isToken);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (useUI.getState().modal.kind !== 'none') return;
      if (spectator) return;
      if (e.key === 'd' || e.key === 'D') actions.drawCards(1);
      else if (e.key === 'u' || e.key === 'U') actions.untapAll();
      else if (e.key === 't' || e.key === 'T') {
        const sel = useGame.getState().selection;
        if (sel.length) {
          const first = useGame.getState().cards[sel[0]];
          actions.tapCards(sel, !(first?.tapped ?? false));
        }
      } else if (e.key === 'Escape') useGame.getState().setSelection([]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [spectator]);

  if (!session) return null;

  const copyInvite = () => {
    void navigator.clipboard.writeText(`${location.origin}${location.pathname}?room=${session.roomCode}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const nextSeatPlayer = () => {
    const seated = [...players].sort((a, b) => a.seat - b.seat);
    if (!seated.length) return null;
    const idx = seated.findIndex((p) => p.playerId === room?.turnPlayerId);
    return seated[(idx + 1) % seated.length];
  };

  const ui = useUI.getState();

  return (
    <div className="table-root">
      <div className="topbar">
        <img src="/favicon.svg" alt="" style={{ height: 24, marginRight: -4 }} />
        <span className="code" title="Click to copy invite link" onClick={copyInvite}>
          {session.roomCode} {copied && <span style={{ fontSize: 11 }}>copied!</span>}
        </span>
        <span className={`status ${connStatus}`}>
          {connStatus === 'connected' ? '● live' : connStatus === 'reconnecting' ? '◌ reconnecting…' : connStatus}
        </span>
        {spectator && <span className="status" style={{ color: 'var(--warn)' }}>spectating</span>}
        <span className="spacer" />
        {!spectator && (
          <>
            <button className="small" onClick={() => ui.openModal({ kind: 'import' })}>
              {iHaveDeck ? 'Re-import deck' : 'Import deck'}
            </button>
            <button className="small" disabled={!iHaveDeck} onClick={() => actions.drawCards(1)} title="Draw (D)">
              Draw
            </button>
            <button
              className="small"
              disabled={!iHaveDeck}
              onClick={() => actions.mulligan()}
              title="Shuffle your hand back and draw 7 (bottom cards yourself, London-style)"
            >
              Mulligan
            </button>
            <button className="small" disabled={!iHaveDeck} onClick={() => actions.untapAll()} title="Untap all (U)">
              Untap all
            </button>
            <button className="small" disabled={!iHaveDeck} onClick={() => actions.takeTurn()} title="Untap, upkeep, draw">
              Take turn ▸
            </button>
            <button
              className="small"
              onClick={() => {
                const next = nextSeatPlayer();
                if (next) actions.passTurn(next.playerId);
              }}
              title="Pass the (decorative) turn marker"
            >
              Pass turn
            </button>
            <button className="small" onClick={() => ui.openModal({ kind: 'tokens', at: centerDropSpot() })}>
              Token
            </button>
            <button className="small" onClick={() => actions.rollDie(6)}>d6</button>
            <button className="small" onClick={() => actions.rollDie(20)}>d20</button>
            <button
              className="small"
              onClick={() => {
                const n = Number(prompt('Roll a die with how many sides?', '10'));
                if (n > 1) actions.rollDie(n);
              }}
            >
              dN
            </button>
            <button className="small" onClick={() => actions.flipCoin()}>coin</button>
            <button
              className="small danger"
              onClick={() =>
                ui.openModal({
                  kind: 'confirm',
                  title: 'New game?',
                  body: 'Every card returns to its owner’s library and everyone shuffles up. Life totals reset.',
                  onConfirm: () => actions.resetGame(),
                })
              }
            >
              New game
            </button>
          </>
        )}
        <button className="small" onClick={() => setShowLog((v) => !v)}>Log</button>
        <button className="small" onClick={() => ui.openModal({ kind: 'prefs' })}>⚙</button>
        <button
          className="small"
          onClick={() => {
            stopSession();
            persisted.patch({ lastSession: undefined });
            useGame.getState().setSession(null);
            history.replaceState(null, '', location.pathname);
          }}
          title="Leave table (your seat stays reserved)"
        >
          Leave
        </button>
      </div>
      <div className="table-main">
        <Battlefield />
        {players.map((p) => (
          <PlayerHud key={p.playerId} player={p} />
        ))}
        {!spectator && <Hand />}
        {showLog && <LogPanel onClose={() => setShowLog(false)} />}
        <HoverPreview />
        <DiceOverlay />
      </div>
      <ModalHost />
      <ContextMenuHost />
    </div>
  );
}
