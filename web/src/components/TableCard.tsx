import { memo } from 'react';
import { MtgCard } from 'mtg-crucible/react';
import type { CardState, PoolCard } from '@playmat/shared';
import {
  cardRotations,
  cardSearchText,
  displayDataFor,
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
  selected: boolean;
  /** World-space rotation all cards get when pref "face me" is on. */
  faceAngleOverride: number | null;
  ownerColor: string;
}

function menuItemsFor(card: CardState, pool: PoolCard | undefined) {
  const items: { label: string; action: () => void }[] = [];
  const g = card.guid;
  items.push({ label: card.tapped ? 'Untap' : 'Tap', action: () => actions.tapCards([g], !card.tapped) });
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

export const TableCard = memo(function TableCard({
  card,
  pool,
  seatOfController,
  dragPos,
  remoteDrag,
  selected,
  faceAngleOverride,
  ownerColor,
}: TableCardProps) {
  const pos = dragPos ?? remoteDrag ?? { x: card.x, y: card.y };
  const baseAngle = faceAngleOverride ?? seatAngle(seatOfController);
  const angle = baseAngle + (card.tapped ? 90 : 0) + (pool ? zRotation(pool, card.rotIndex) : 0);
  const face = pool ? faceAt(pool, card.rotIndex) : null;
  const customDisplay = useCustomDisplay(pool);
  const pt = card.faceDown
    ? null
    : effectivePT(face, card.counters) ??
      (pool?.custom && typeof pool.custom.power === 'string' && typeof pool.custom.toughness === 'string'
        ? effectivePT(
            { name: '', img: '', power: pool.custom.power as string, toughness: pool.custom.toughness as string },
            card.counters
          )
        : null);
  const display =
    pool?.custom && !card.faceDown ? customDisplay : pool ? displayDataFor(pool, card.rotIndex, card.faceDown) : null;

  return (
    <div
      className={`tcard${dragPos ? ' dragging' : ''}${remoteDrag ? ' remote-drag' : ''}${selected ? ' selected' : ''}`}
      data-guid={card.guid}
      style={{
        width: CARD_W,
        height: CARD_H,
        transform: `translate(${pos.x - CARD_W / 2}px, ${pos.y - CARD_H / 2}px) rotate(${angle}deg)`,
        zIndex: dragPos || remoteDrag ? 30 : 10,
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
            extraMenuItems={withMenuClose(menuItemsFor(card, pool))}
          />
        ) : (
          <div style={{ width: '100%', height: '100%', background: '#333' }} />
        )}
      </div>
      <div className="owner-ring" style={{ borderColor: ownerColor }} />
      {Object.keys(card.counters).length > 0 && (
        <div className="counter-badges">
          {Object.entries(card.counters).map(([label, n]) => (
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
