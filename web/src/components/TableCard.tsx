import { memo } from 'react';
import { MtgCard } from 'mtg-crucible/react';
import type { CardState, PoolCard } from '@playmat/shared';
import {
  cardRotations,
  cardSearchText,
  displayDataFor,
  useSleeveUrl,
  effectivePT,
  faceAt,
  hasRotationStates,
  useCustomDisplay,
  zRotation,
} from '../cards';
import { CARD_H, CARD_W, seatAngle } from '../view';
import { useUI } from '../uiStore';
import * as actions from '../actions';
import { useGame } from '../store';
import { withMenuClose } from './CardView';

export interface TableCardProps {
  card: CardState;
  pool: PoolCard | undefined;
  seatOfController: number;
  /** Local in-flight drag position (world coords), overrides card.x/y. */
  dragPos: { x: number; y: number } | null;
  remoteDrag: { x: number; y: number } | null;
  /** Size of the current selection when this card is in it, else 0. >1 swaps
   * the context menu for the group menu. */
  selCount: number;
  /** World-space rotation all cards get when pref "face me" is on. */
  faceAngleOverride: number | null;
  ownerColor: string;
}

function menuItemsFor(card: CardState, pool: PoolCard | undefined) {
  const items: { label: string; action: () => void }[] = [];
  const g = card.guid;
  items.push({ label: card.tapped ? 'Untap' : 'Tap', action: () => actions.tapCards([g], !card.tapped) });
  if (card.faceDown) {
    // Local-only look at a face-down card, so checking your own morph doesn't
    // force a table-wide reveal. Deliberately NOT gated on ownership — same
    // honor system as every other verb here.
    items.push({ label: 'Peek (only you see it)', action: () => useUI.getState().openModal({ kind: 'card', guid: g }) });
    items.push({
      label: card.manifest ? 'Un-manifest (no P/T)' : 'Manifest (2/2 creature)',
      action: () => actions.setManifest(g, !card.manifest),
    });
  }
  if (pool && hasRotationStates(pool)) {
    const n = cardRotations(pool).length;
    items.push({ label: 'Turn / transform', action: () => actions.setRotIndex(g, (card.rotIndex + 1) % n) });
  }
  items.push({
    label: card.faceDown ? 'Turn face up' : 'Turn face down',
    action: () => actions.setFaceDown(g, !card.faceDown),
  });
  items.push({
    label: '+1/+1 counter',
    action: () => actions.setCounter(g, '+1/+1', (card.counters['+1/+1'] ?? 0) + 1),
  });
  items.push({
    label: '−1/−1 counter',
    action: () => actions.setCounter(g, '-1/-1', (card.counters['-1/-1'] ?? 0) + 1),
  });
  items.push({
    label: 'Set +1/+1 counters…',
    action: () => {
      const n = askCount('How many +1/+1 counters?', card.counters['+1/+1'] ?? 0);
      if (n != null) actions.setCounter(g, '+1/+1', n);
    },
  });
  items.push({
    label: 'Counter…',
    action: () => {
      const label = prompt('Counter name (e.g. loyalty, charge):', 'charge');
      if (!label) return;
      const value = Number(prompt(`How many "${label}" counters?`, String((card.counters[label] ?? 0) + 1)));
      if (Number.isFinite(value)) actions.setCounter(g, label, value);
    },
  });
  items.push({ label: 'Copy as token', action: () => actions.copyCardAsToken(g, { x: card.x + 40, y: card.y + 20 }) });
  items.push({ label: 'To hand', action: () => actions.moveCard(g, { zone: 'hand' }) });
  items.push({ label: 'To graveyard', action: () => actions.moveCard(g, { zone: 'graveyard' }) });
  items.push({ label: 'To exile', action: () => actions.moveCard(g, { zone: 'exile' }) });
  items.push({ label: 'To library (top)', action: () => actions.moveCard(g, { zone: 'library', libPos: 'top' }) });
  items.push({ label: 'To library (bottom)', action: () => actions.moveCard(g, { zone: 'library', libPos: 'bottom' }) });
  items.push({ label: 'To command zone', action: () => actions.moveCard(g, { zone: 'command' }) });
  if (pool?.isToken) items.push({ label: 'Remove token', action: () => actions.removeToken(g) });
  return items;
}

/** Prompt for a whole, non-negative count; null if cancelled or nonsense. */
function askCount(question: string, current: number): number | null {
  const raw = prompt(question, String(current));
  if (raw == null || raw.trim() === '') return null;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * The selection at click time, so the menu never acts on a stale render:
 * falls back to just this card if the selection moved on without it.
 */
function liveGroup(guid: string): string[] {
  const sel = useGame.getState().selection;
  return sel.includes(guid) && sel.length > 1 ? sel : [guid];
}

/** Menu when the right-clicked card is part of a multi-card selection:
 * every action applies to the whole selection (Archidekt behavior). */
function groupMenuItemsFor(card: CardState, pool: PoolCard | undefined, n: number) {
  // One withUndo batch per menu pick, so "Undo" reverts the whole group.
  const each = (undoLabel: string, f: (c: CardState) => void) => {
    actions.withUndo(undoLabel, () => {
      const s = useGame.getState();
      for (const g of liveGroup(card.guid)) {
        const c = s.cards[g];
        if (c) f(c);
      }
    });
  };
  const items: { label: string; action: () => void }[] = [
    { label: `Tap ${n} selected`, action: () => actions.tapCards(liveGroup(card.guid), true) },
    { label: `Untap ${n} selected`, action: () => actions.tapCards(liveGroup(card.guid), false) },
    {
      label: card.faceDown ? `Turn ${n} face up` : `Turn ${n} face down`,
      action: () => each(`flip ${n} cards`, (c) => actions.setFaceDown(c.guid, !card.faceDown)),
    },
    {
      label: '+1/+1 counter on each',
      action: () =>
        each(`counters on ${n} cards`, (c) => actions.setCounter(c.guid, '+1/+1', (c.counters['+1/+1'] ?? 0) + 1)),
    },
    {
      label: '−1/−1 counter on each',
      action: () =>
        each(`counters on ${n} cards`, (c) => actions.setCounter(c.guid, '-1/-1', (c.counters['-1/-1'] ?? 0) + 1)),
    },
    {
      label: 'Set +1/+1 counters on each…',
      action: () => {
        const count = askCount(`How many +1/+1 counters on each of the ${n} cards?`, card.counters['+1/+1'] ?? 0);
        if (count != null) each(`counters on ${n} cards`, (c) => actions.setCounter(c.guid, '+1/+1', count));
      },
    },
    {
      label: 'Counter on each…',
      action: () => {
        const label = prompt('Counter name (e.g. loyalty, charge):', 'charge');
        if (!label) return;
        const value = Number(prompt(`How many "${label}" counters on each?`, String((card.counters[label] ?? 0) + 1)));
        if (Number.isFinite(value)) each(`counters on ${n} cards`, (c) => actions.setCounter(c.guid, label, value));
      },
    },
    {
      label: `Copy ${n} as tokens`,
      action: () => each(`copy ${n} cards`, (c) => actions.copyCardAsToken(c.guid, { x: c.x + 40, y: c.y + 20 })),
    },
    { label: `Move ${n} to hand`, action: () => each(`move ${n} cards`, (c) => actions.moveCard(c.guid, { zone: 'hand' })) },
    {
      label: `Move ${n} to graveyard`,
      action: () => each(`move ${n} cards`, (c) => actions.moveCard(c.guid, { zone: 'graveyard' })),
    },
    { label: `Move ${n} to exile`, action: () => each(`move ${n} cards`, (c) => actions.moveCard(c.guid, { zone: 'exile' })) },
    {
      label: `Move ${n} to library (top)`,
      action: () => each(`move ${n} cards`, (c) => actions.moveCard(c.guid, { zone: 'library', libPos: 'top' })),
    },
    {
      label: `Move ${n} to library (bottom)`,
      action: () => each(`move ${n} cards`, (c) => actions.moveCard(c.guid, { zone: 'library', libPos: 'bottom' })),
    },
    {
      label: `Move ${n} to command zone`,
      action: () => each(`move ${n} cards`, (c) => actions.moveCard(c.guid, { zone: 'command' })),
    },
  ];
  if (pool?.isToken) {
    items.push({
      label: 'Remove selected tokens',
      action: () => {
        const s = useGame.getState();
        each('remove tokens', (c) => {
          if (s.pool[c.guid]?.isToken) actions.removeToken(c.guid);
        });
      },
    });
  }
  return items;
}

export const TableCard = memo(function TableCard({
  card,
  pool,
  seatOfController,
  dragPos,
  remoteDrag,
  selCount,
  faceAngleOverride,
  ownerColor,
}: TableCardProps) {
  const pos = dragPos ?? remoteDrag ?? { x: card.x, y: card.y };
  const baseAngle = faceAngleOverride ?? seatAngle(seatOfController);
  const angle = baseAngle + (card.tapped ? 90 : 0) + (pool ? zRotation(pool, card.rotIndex) : 0);
  const face = pool ? faceAt(pool, card.rotIndex) : null;
  const customDisplay = useCustomDisplay(pool);
  const pt = card.faceDown
    ? card.manifest
      ? effectivePT({ name: '', img: '', power: '2', toughness: '2' }, card.counters)
      : null
    : effectivePT(face, card.counters) ??
      (pool?.custom && typeof pool.custom.power === 'string' && typeof pool.custom.toughness === 'string'
        ? effectivePT(
            { name: '', img: '', power: pool.custom.power as string, toughness: pool.custom.toughness as string },
            card.counters
          )
        : null);
  const back = useSleeveUrl(card.ownerId);
  const display =
    pool?.custom && !card.faceDown
      ? customDisplay
      : pool
        ? displayDataFor(pool, card.rotIndex, card.faceDown, back)
        : null;

  return (
    <div
      className={`tcard${dragPos ? ' dragging' : ''}${remoteDrag ? ' remote-drag' : ''}${selCount > 0 ? ' selected' : ''}`}
      data-guid={card.guid}
      style={{
        width: CARD_W,
        height: CARD_H,
        transform: `translate(${pos.x - CARD_W / 2}px, ${pos.y - CARD_H / 2}px) rotate(${angle}deg)`,
        // Stacking: per-card z, and an in-flight drag rides above everything
        // while keeping a multi-drag group's internal order.
        zIndex: 10 + (card.z ?? 0) + (dragPos || remoteDrag ? 100000 : 0),
      }}
      onMouseEnter={() =>
        pool && !card.faceDown &&
        useUI.getState().setHover({ pool, rotIndex: card.rotIndex, counters: card.counters })
      }
      onMouseLeave={() => useUI.getState().setHover(null)}
    >
      <div className="cardframe" style={{ width: '100%', height: '100%' }}>
        {display ? (
          <MtgCard
            card={display}
            cardText={pool && !card.faceDown ? cardSearchText(pool, card.rotIndex) : undefined}
            style={{ width: '100%', height: '100%' }}
            rotateWidgetStyle={{ display: 'none' }}
            hideMenuItems="all"
            extraMenuItems={withMenuClose(
              selCount > 1 ? groupMenuItemsFor(card, pool, selCount) : menuItemsFor(card, pool)
            )}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', background: '#333' }} />
        )}
      </div>
      <div className="owner-ring" style={{ borderColor: ownerColor }} />
      {Object.keys(card.counters).some((k) => k !== 'tax') && (
        <div className="counter-badges">
          {/* Commander tax rides along on the card but isn't a counter on the permanent. */}
          {Object.entries(card.counters).filter(([label]) => label !== 'tax').map(([label, n]) => (
            <span key={label} className="counter-badge">
              {label === '+1/+1' || label === '-1/-1' ? `${n > 0 ? '' : ''}${label} ×${n}` : `${label}: ${n}`}
            </span>
          ))}
        </div>
      )}
      {pt && <span className="pt-badge">{pt.p}/{pt.t}</span>}
    </div>
  );
});
