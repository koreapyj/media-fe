import shaka from 'shaka-player/dist/shaka-player.ui.js';
import { subtitleStyle, type BorderType } from '../player/subtitleStyle';

/** Material Symbols "closed caption" path (viewBox 0 -960 960 960), used for the menu button icon. */
const ICON_PATH =
  'M200-160q-33 0-56.5-23.5T120-240v-480q0-33 23.5-56.5T200-800h560q33 0 56.5 23.5T840-720v480q0 33-23.5 ' +
  '56.5T760-160H200Zm80-200h120q17 0 28.5-11.5T440-400v-20q0-9-6-15t-15-6h-18q-9 0-15 6t-6 15h-80v-120h80q0 ' +
  '9 6 15t15 6h18q9 0 15-6t6-15v-20q0-17-11.5-28.5T400-600H280q-17 0-28.5 11.5T240-560v160q0 17 11.5 ' +
  '28.5T280-360Zm400-240H560q-17 0-28.5 11.5T520-560v160q0 17 11.5 28.5T560-360h120q17 0 28.5-11.5T720-400v-20q0-9-6-15t-15-6h-18q-9 ' +
  '0-15 6t-6 15h-80v-120h80q0 9 6 15t15 6h18q9 0 15-6t6-15v-20q0-17-11.5-28.5T680-600Z';

const OPTIONS: Array<{ value: BorderType; label: string }> = [
  { value: 'default', label: 'Default' },
  { value: 'outline', label: 'Outline' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'opaquebox', label: 'Opaque Box' },
];

/**
 * Custom Shaka UI overflow-menu control for the libass subtitle border style. Mirrors the look of
 * Shaka's caption-style menus (e.g. "Subtitle size") but writes to our subtitleStyle store, which
 * TvPlayer applies to libass.
 */
class BorderTypeMenu extends shaka.ui.SettingsMenu {
  private readonly unsubscribe: () => void;

  constructor(parent: HTMLElement, controls: shaka.ui.Controls) {
    super(parent, controls, ICON_PATH);
    this.menu.classList.add('tv-border-menu');

    for (const opt of OPTIONS) {
      const button = document.createElement('button');
      button.classList.add('tv-border-option');
      const span = document.createElement('span');
      span.textContent = opt.label;
      button.appendChild(span);
      button.addEventListener('click', () => subtitleStyle.setBorderType(opt.value));
      this.menu.appendChild(button);
    }

    const player = this.player!;
    for (const evt of ['loading', 'unloading', 'trackschanged', 'texttrackvisibility']) {
      player.addEventListener(evt, () => this.checkAvailability());
    }
    this.unsubscribe = subtitleStyle.subscribe(() => this.updateSelection());

    this.updateLocalizedStrings();
    this.updateSelection();
    this.checkAvailability();
  }

  private updateSelection(): void {
    const current = subtitleStyle.get().borderType;
    let label = '';
    const buttons = this.menu.querySelectorAll<HTMLButtonElement>('.tv-border-option');
    buttons.forEach((button, i) => {
      const chosen = OPTIONS[i].value === current;
      button.classList.toggle('tv-chosen', chosen);
      button.setAttribute('aria-checked', String(chosen));
      if (chosen) label = OPTIONS[i].label;
    });
    this.currentSelection.textContent = label;
  }

  /** Show only when an ASS text track is active (matches Shaka's caption-menu availability). */
  checkAvailability(): void {
    const active = (this.player?.getTextTracks() ?? []).some((t) => t.active);
    this.button.style.display = active ? '' : 'none';
  }

  updateLocalizedStrings(): void {
    this.button.ariaLabel = 'Subtitle border';
    this.nameSpan.textContent = 'Border';
    this.backSpan.textContent = 'Border';
  }

  override release(): void {
    this.unsubscribe();
    super.release();
  }
}

let registered = false;

/** Register the border-type control under 'libass-border-type' (idempotent). Call before Overlay. */
export function registerBorderTypeMenu(): void {
  if (registered) return;
  registered = true;
  const factory: shaka.extern.IUIElement.Factory = {
    create: (root, controls) => new BorderTypeMenu(root, controls),
  };
  shaka.ui.OverflowMenu.registerElement('libass-border-type', factory);
  shaka.ui.Controls.registerElement('libass-border-type', factory);
}
