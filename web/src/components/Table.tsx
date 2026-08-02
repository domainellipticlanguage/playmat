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
  const [showLog, setShowLog] = useState(false);
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

  /**
   * Navigate home to the lobby. Pushes a history entry, so the browser's back
   * arrow returns to the table — the session stays saved for the return trip.
   */
  const goHome = () => {
    stopSession();
    useGame.getState().setSession(null);
    history.pushState(null, '', location.pathname);
  };

  /** Leave for real: also forget the saved session, so back won't auto-rejoin. */
  const leaveTable = () => {
    persisted.patch({ lastSession: undefined });
    goHome();
  };

  const nextSeatPlayer = () => {
    const seated = [...players].sort((a, b) => a.seat - b.seat);
    if (!seated.length) return null;
    const idx = seated.findIndex((p) => p.playerId === room?.turnPlayerId);
    return seated[(idx + 1) % seated.length];
  };

  const ui = useUI.getState();

  /** Open a topbar dropdown, anchored under the button that was clicked. */
  const dropdown =
    (items: NonNullable<Parameters<typeof ui.openCtxMenu>[0]>['items']) => (e: React.MouseEvent) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      ui.openCtxMenu({ x: r.left, y: r.bottom + 6, items });
    };

  const sep = { sep: true, label: '' };
  const tokenItem = {
    label: 'Create token…',
    action: () => ui.openModal({ kind: 'tokens', at: centerDropSpot() }),
  };
  const diceItems = [
    { label: 'Roll a d6', action: () => actions.rollDie(6) },
    { label: 'Roll a d20', action: () => actions.rollDie(20) },
    {
      label: 'Roll a dN…',
      action: () => {
        const n = Number(prompt('Roll a die with how many sides?', '10'));
        if (n > 1) actions.rollDie(n);
      },
    },
    { label: 'Flip a coin', action: () => actions.flipCoin() },
  ];
  const gameItems = [
    { label: 'Mulligan — hand back, draw 7', action: () => actions.mulligan() },
    {
      label: 'Pass the turn marker',
      action: () => {
        const next = nextSeatPlayer();
        if (next) actions.passTurn(next.playerId);
      },
    },
    sep,
    { label: iHaveDeck ? 'Re-import deck…' : 'Import deck…', action: () => ui.openModal({ kind: 'import' }) },
    sep,
    {
      label: 'New game…',
      action: () =>
        ui.openModal({
          kind: 'confirm',
          title: 'New game?',
          body: 'Every card returns to its owner’s library and everyone shuffles up. Life totals reset.',
          onConfirm: () => actions.resetGame(),
        }),
    },
  ];

  return (
    <div className="table-root">
      <div className="topbar">
        <div className="room-info">
          <img
            src="/favicon.svg"
            alt="Playmat"
            className="home-logo"
            title="Back to lobby"
            onClick={goHome}
          />
          <span className="code" title="Click to copy invite link" onClick={copyInvite}>
            {session.roomCode} {copied && <span style={{ fontSize: 11 }}>copied!</span>}
          </span>
          <span className={`status ${connStatus}`}>
            {connStatus === 'connected' ? '● live' : connStatus === 'reconnecting' ? '◌ reconnecting…' : connStatus}
          </span>
          {(room?.turn ?? 0) > 0 && (
            <span
              className="turn-count"
              title={`Turn ${room!.turn} — ${players.find((p) => p.playerId === room?.turnPlayerId)?.name ?? 'unclaimed'}`}
            >
              Turn {room!.turn}
            </span>
          )}
          {spectator && <span className="status" style={{ color: 'var(--warn)' }}>spectating</span>}
        </div>
        {!spectator && (
          <>
            {!iHaveDeck && (
              <button className="small primary" onClick={() => ui.openModal({ kind: 'import' })}>
                Import deck
              </button>
            )}
            <button className="small" disabled={!iHaveDeck} onClick={() => actions.drawCards(1)} title="Draw (D)">
              Draw
            </button>
            <button className="small" disabled={!iHaveDeck} onClick={() => actions.untapAll()} title="Untap all (U)">
              Untap
            </button>
            <button className="small" disabled={!iHaveDeck} onClick={() => actions.takeTurn()} title="Untap, upkeep, draw">
              Take turn ▸
            </button>
            <button className="small bar-wide" onClick={() => ui.openModal({ kind: 'tokens', at: centerDropSpot() })}>
              Token
            </button>
            <button className="small bar-wide" onClick={dropdown(diceItems)}>
              🎲 Dice ▾
            </button>
            <button className="small bar-wide" onClick={dropdown(gameItems)}>
              Game ▾
            </button>
            <button
              className="small bar-narrow"
              title="Tokens, dice, and game actions"
              onClick={dropdown([tokenItem, sep, ...diceItems, sep, ...gameItems])}
            >
              ☰ More
            </button>
          </>
        )}
        <span className="spacer" />
        <button className="small" onClick={() => setShowLog((v) => !v)}>Log</button>
        <button className="small" onClick={() => ui.openModal({ kind: 'prefs' })} title="Preferences">⚙</button>
        <button className="small" onClick={leaveTable} title="Leave table (your seat stays reserved)">
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
