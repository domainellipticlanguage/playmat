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
import { MtgCard } from 'mtg-crucible/react';
import type { PoolCard } from '@playmat/shared';
import { displayDataFor, faceAt, useCustomDisplay } from '../cards';

const NO_CARD: PoolCard = { guid: '', ownerId: '' };

export interface CardViewProps {
  /** Pool entry to display; omit (or pass null) for a plain card back. */
  pool?: PoolCard | null;
  rotIndex?: number;
  faceDown?: boolean;
  /** Swap Scryfall /normal/ images for /large/ (hover preview). */
  large?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

export function CardView({ pool, rotIndex = 0, faceDown = false, large = false, className, style }: CardViewProps) {
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
  const face = faceDown ? null : faceAt(p, rotIndex);
  return <MtgCard card={display} cardText={face?.oracle} className={className} style={style} hideMenuItems="all" />;
}
