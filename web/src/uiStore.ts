/**
 * Purely local UI state (never synced): hover preview, open modals, drag in
 * progress, context menu.
 */
import { create } from 'zustand';
import type { PoolCard } from '@playmat/shared';

export interface HoverInfo {
  pool: PoolCard;
  rotIndex: number;
  counters?: Record<string, number>;
}

export type ModalState =
  | { kind: 'none' }
  | { kind: 'peek'; count: number; mode: 'scry' | 'surveil' | 'peek' }
  | { kind: 'search' }
  | { kind: 'tokens'; at: { x: number; y: number } }
  | { kind: 'zone'; zone: 'graveyard' | 'exile' | 'command'; zoneOwnerId: string }
  | { kind: 'confirm'; title: string; body: string; onConfirm: () => void }
  | { kind: 'import' }
  | { kind: 'prefs' }
  | { kind: 'revealed'; playerId: string };

export interface CtxMenuState {
  x: number;
  y: number;
  items: { label: string; action?: () => void; sep?: boolean }[];
}

interface UIStore {
  hover: HoverInfo | null;
  modal: ModalState;
  ctxMenu: CtxMenuState | null;
  /** guid being dragged locally (battlefield or from hand). */
  dragging: string | null;
  lastRoll: { die?: number; result: number | string; text: string; key: number } | null;
  setHover(h: HoverInfo | null): void;
  openModal(m: ModalState): void;
  closeModal(): void;
  openCtxMenu(m: CtxMenuState | null): void;
  setDragging(guid: string | null): void;
  showRoll(r: { die?: number; result: number | string; text: string }): void;
}

export const useUI = create<UIStore>((set) => ({
  hover: null,
  modal: { kind: 'none' },
  ctxMenu: null,
  dragging: null,
  lastRoll: null,
  setHover: (hover) => set({ hover }),
  openModal: (modal) => set({ modal }),
  closeModal: () => set({ modal: { kind: 'none' } }),
  openCtxMenu: (ctxMenu) => set({ ctxMenu }),
  setDragging: (dragging) => set({ dragging }),
  showRoll: (r) => set({ lastRoll: { ...r, key: Date.now() } }),
}));
