/**
 * In-memory store for user subtitle-style overrides applied to libass.
 *
 * - `fontScale` mirrors Shaka UI's "Subtitle size" (`textDisplayer.fontScaleFactor`).
 * - `borderType` is driven by our custom border-type menu.
 *
 * Not persisted yet; `load`/`save` are the single seam to add localStorage later.
 */
export type BorderType = 'default' | 'outline' | 'shadow' | 'opaquebox';

export interface SubtitleStyleState {
  fontScale: number;
  borderType: BorderType;
}

type Listener = (state: SubtitleStyleState) => void;

const state: SubtitleStyleState = { fontScale: 1, borderType: 'default' };
const listeners = new Set<Listener>();

function notify(): void {
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
