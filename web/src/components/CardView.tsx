/**
 * The one way a card is displayed anywhere outside the battlefield — hand,
 * piles, modals, previews, drag ghosts — so every card render goes through
 * crucible's MtgCard. This also means custom tokens show their real crucible
 * face everywhere instead of falling back to a card back. TableCard keeps its
 * own MtgCard wiring for battlefield menus and rotation.
 *
 * With no `rotations` in the display data and all menu items hidden, MtgCard's
 * own click/context-menu behavior stays inert and events bubble, so parents
 * keep their click handlers and custom context menus.
 */
import { MtgCard, type MtgCardMenuItem } from 'mtg-crucible/react';
import type { PoolCard } from '@playmat/shared';
import { cardSearchText, displayDataFor, useCustomDisplay } from '../cards';
import { CARD_W, liveView } from '../view';

const NO_CARD: PoolCard = { guid: '', ownerId: '' };

/**
 * Crucible's card menu closes itself after its BUILT-IN items, but runs
 * extraMenuItems' actions with the menu left open — its only other close path
 * is a document-level pointerdown (crucible ≥0.4.16). Dispatch one after the
 * action so picking an item dismisses the menu like you'd expect. (Worth
 * fixing upstream too.)
 */
export function withMenuClose(items: MtgCardMenuItem[]): MtgCardMenuItem[] {
  return items.map((m) => ({
    ...m,
    action: () => {
      m.action();
      document.dispatchEvent(new PointerEvent('pointerdown'));
    },
  }));
}

export interface CardViewProps {
  /** Pool entry to display; omit (or pass null) for a plain card back. */
  pool?: PoolCard | null;
  rotIndex?: number;
  faceDown?: boolean;
  /** Swap Scryfall /normal/ images for /large/ (hover preview). */
  large?: boolean;
  /** Right-click menu (crucible's own), e.g. the opening hand's keep/bottom/exile. */
  menuItems?: MtgCardMenuItem[];
  className?: string;
  style?: React.CSSProperties;
}

export function CardView({
  pool,
  rotIndex = 0,
  faceDown = false,
  large = false,
  menuItems,
  className,
  style,
}: CardViewProps) {
  const p = pool ?? NO_CARD;
  const customDisplay = useCustomDisplay(p);
  let display =
    p.custom && !faceDown
      ? // Card back while crucible is still drawing the custom face; the hook
        // holds the previous face across prop changes, so live edits (token
        // preview) never flash back to it.
        customDisplay ?? displayDataFor(p, rotIndex, true)
      : displayDataFor(p, rotIndex, faceDown);
  if (large) display = { ...display, frontFaceImageUrl: display.frontFaceImageUrl.replace('/normal/', '/large/') };
  return (
    <MtgCard
      card={display}
      cardText={faceDown ? undefined : cardSearchText(p, rotIndex)}
      className={className}
      style={style}
      hideMenuItems="all"
      extraMenuItems={menuItems && withMenuClose(menuItems)}
    />
  );
}

/**
 * Pointer-following ghost for drags out of the hand or a pile, sized to the
 * battlefield's current zoom so the card lands at the size it was dragged.
 *
 * `position: fixed` must ride the style prop: MtgCard sets an inline
 * `position: relative` on its root, and only the style spread wins over it —
 * a CSS class cannot.
 */
export function DragGhost({
  pool,
  rotIndex = 0,
  faceDown = false,
  x,
  y,
  w,
}: {
  pool?: PoolCard | null;
  rotIndex?: number;
  faceDown?: boolean;
  x: number;
  y: number;
  /** Override width — e.g. hand-card size while hovering the hand strip. */
  w?: number;
}) {
  const width = w ?? Math.max(56, Math.min(240, CARD_W * liveView.current.k));
  const h = (width * 7) / 5;
  return (
    <CardView
      className="card-ghost"
      pool={pool}
      rotIndex={rotIndex}
      faceDown={faceDown}
      style={{ position: 'fixed', width, left: x - width / 2, top: y - h / 2, transition: 'width 120ms ease' }}
    />
  );
}
