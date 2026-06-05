/**
 * Persisted store for user subtitle-style overrides applied to libass.
 *
 * - `fontScale` mirrors Shaka UI's "Subtitle size" (`textDisplayer.fontScaleFactor`).
 * - `borderType` is driven by our custom border-type menu.
 *
 * State is loaded from (and saved to) localStorage so it survives reloads/channel switches.
 */
import { loadJSON, saveJSON } from '../storage';

export type BorderType = 'default' | 'outline' | 'shadow' | 'opaquebox';

export interface SubtitleStyleState {
  fontScale: number;
  borderType: BorderType;
}

type Listener = (state: SubtitleStyleState) => void;

const STORAGE_KEY = 'subtitleStyle';
const BORDER_TYPES: BorderType[] = ['default', 'outline', 'shadow', 'opaquebox'];

function loadState(): SubtitleStyleState {
  const saved = loadJSON<Partial<SubtitleStyleState>>(STORAGE_KEY, {});
  const fontScale =
    typeof saved.fontScale === 'number' && Number.isFinite(saved.fontScale) && saved.fontScale > 0
      ? saved.fontScale
      : 1;
  const borderType =
    saved.borderType && BORDER_TYPES.includes(saved.borderType) ? saved.borderType : 'default';
  return { fontScale, borderType };
}

const state: SubtitleStyleState = loadState();
const listeners = new Set<Listener>();

function notify(): void {
  saveJSON(STORAGE_KEY, state);
  for (const cb of listeners) cb({ ...state });
}

export const subtitleStyle = {
  get(): SubtitleStyleState {
    return { ...state };
  },
  setFontScale(scale: number): void {
    if (!Number.isFinite(scale) || scale === state.fontScale) return;
    state.fontScale = scale;
    notify();
  },
  setBorderType(type: BorderType): void {
    if (type === state.borderType) return;
    state.borderType = type;
    notify();
  },
  subscribe(cb: Listener): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  },
};
