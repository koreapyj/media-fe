import shaka from 'shaka-player/dist/shaka-player.ui.js';
import type { Channel } from '../playlist/types';
import type { Programme } from '../epg/xmltv';
import { programmesInRange } from '../epg/epg';
import { hrefFor } from '../router';

/** Material Symbols "calendar / guide" path (viewBox 0 -960 960 960) for the control-bar button. */
const ICON_PATH =
  'M200-80q-33 0-56.5-23.5T120-160v-560q0-33 23.5-56.5T200-800h40v-80h80v80h320v-80h80v80h40q33 0 56.5 ' +
  '23.5T840-720v560q0 33-23.5 56.5T760-80H200Zm0-80h560v-400H200v400Zm0-480h560v-80H200v80Zm0 0v-80 80Zm280 ' +
  '240q-17 0-28.5-11.5T440-440q0-17 11.5-28.5T480-480q17 0 28.5 11.5T520-440q0 17-11.5 28.5T480-400Zm-160 ' +
  '0q-17 0-28.5-11.5T280-440q0-17 11.5-28.5T320-480q17 0 28.5 11.5T360-440q0 17-11.5 28.5T320-400Zm320 ' +
  '0q-17 0-28.5-11.5T600-440q0-17 11.5-28.5T640-480q17 0 28.5 11.5T680-440q0 17-11.5 28.5T640-400ZM480-240q-17 ' +
  '0-28.5-11.5T440-280q0-17 11.5-28.5T480-320q17 0 28.5 11.5T520-280q0 17-11.5 28.5T480-240Zm-160 0q-17 ' +
  '0-28.5-11.5T280-280q0-17 11.5-28.5T320-320q17 0 28.5 11.5T360-280q0 17-11.5 28.5T320-240Zm320 0q-17 ' +
  '0-28.5-11.5T600-280q0-17 11.5-28.5T640-320q17 0 28.5 11.5T680-280q0 17-11.5 28.5T640-240Z';

// --- Layout constants ---
const PX_PER_MIN = 4; // → 240 px per hour
const GUIDE_HOURS = 24; // visible/scrollable span ahead of the current hour
const HEAD_H = 52; // channel-header row height (px)
const HOUR_MS = 3_600_000;

// ---------------------------------------------------------------------------
// Control-bar button: toggles the overlay via a module-level hook set by the App.
// ---------------------------------------------------------------------------

let toggleHandler: (() => void) | null = null;

/** Bind (or clear) the handler the control-bar button invokes. */
export function setEpgToggle(fn: (() => void) | null): void {
  toggleHandler = fn;
}

/** Invoke the bound EPG toggle (used by the mobile floating button). */
export function requestEpgToggle(): void {
  toggleHandler?.();
}

/** Build Shaka's icon markup (svg.shaka-ui-icon) for a raw SVG path. */
function iconSvg(path: string): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.classList.add('shaka-ui-icon');
  svg.setAttribute('viewBox', '0 -960 960 960');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', path);
  svg.appendChild(p);
  return svg;
}

/** A fresh copy of the EPG (calendar) icon SVG, for reuse outside Shaka's control bar. */
export function epgIconSvg(): SVGSVGElement {
  return iconSvg(ICON_PATH);
}

class EpgButton extends shaka.ui.Element {
  constructor(parent: HTMLElement, controls: shaka.ui.Controls) {
    super(parent, controls);
    const button = document.createElement('button');
    button.classList.add('shaka-tooltip', 'shaka-epg-button');
    button.setAttribute('aria-label', 'Program guide');
    button.appendChild(iconSvg(ICON_PATH));

    // Label shows when the button is surfaced in the overflow menu.
    const label = document.createElement('label');
    label.classList.add('shaka-overflow-button-label', 'shaka-overflow-menu-only');
    const span = document.createElement('span');
    span.textContent = 'Guide';
    label.appendChild(span);
    button.appendChild(label);

    this.parent!.appendChild(button);
    this.eventManager!.listen(button, 'click', () => {
      if (this.controls?.isOpaque()) toggleHandler?.();
    });
  }
}

let registered = false;

/** Register the 'epg-guide' control-bar button (idempotent). Call before creating the Overlay. */
export function registerEpgButton(): void {
  if (registered) return;
  registered = true;
  const factory: shaka.extern.IUIElement.Factory = {
    create: (root, controls) => new EpgButton(root, controls),
  };
  shaka.ui.Controls.registerElement('epg-guide', factory);
}

// ---------------------------------------------------------------------------
// The overlay grid.
// ---------------------------------------------------------------------------

export interface EpgOverlayHandlers {
  /** Tune to a channel in place (no routing). */
  onWatch: (channel: Channel) => void;
  /** Close the overlay (App owns removal). */
  onClose: () => void;
}

export interface EpgOverlay {
  element: HTMLElement;
  /** Re-pull data and reconcile the grid in place (called when an EPG refresh lands). */
  refresh: () => void;
}

/** One rendered programme block and the programme it currently shows. */
interface RenderedBlock {
  el: HTMLElement;
  prog: Programme;
}

/** A channel column and its rendered blocks keyed by programme start (epoch ms). */
interface ColumnState {
  ch: Channel;
  colBody: HTMLElement;
  byStart: Map<number, RenderedBlock>;
}

function startOfHour(ms: number): number {
  const d = new Date(ms);
  d.setMinutes(0, 0, 0);
  return d.getTime();
}

const clockFmt = (ms: number) =>
  new Date(ms).toLocaleString([], {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Two-digit hour for the time-axis legend (no minutes). */
const hh = (ms: number) => String(new Date(ms).getHours()).padStart(2, '0');

/** y-offset (px) of an epoch time within the grid body, relative to gridStart. */
const yOf = (ms: number, gridStart: number) => ((ms - gridStart) / 60_000) * PX_PER_MIN;

/**
 * Build the program-guide overlay: channels as columns, programmes as duration-sized blocks on a
 * vertical time axis, current programme highlighted with a now-line. Columns are filled
 * asynchronously from IndexedDB. A self-stopping 1-minute tick keeps the clock, now-line and
 * "now" highlight current; it ends when the overlay is detached.
 */
export function createEpgOverlay(
  channels: Channel[],
  current: Channel | null,
  handlers: EpgOverlayHandlers,
): EpgOverlay {
  const gridStart = startOfHour(Date.now());
  const gridEnd = gridStart + GUIDE_HOURS * HOUR_MS;
  const bodyH = yOf(gridEnd, gridStart);

  const overlay = document.createElement('div');
  overlay.className = 'epg-overlay';

  const header = document.createElement('div');
  header.className = 'epg-header';
  const clock = document.createElement('div');
  clock.className = 'epg-clock';
  const close = document.createElement('button');
  close.className = 'epg-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '✕';
  close.addEventListener('click', () => handlers.onClose());
  header.append(clock, close);

  const scroll = document.createElement('div');
  scroll.className = 'epg-scroll';
  const grid = document.createElement('div');
  grid.className = 'epg-grid';
  grid.style.minHeight = `${HEAD_H + bodyH}px`;

  // Time axis (sticky left): corner + hour labels.
  const axis = document.createElement('div');
  axis.className = 'epg-axis';
  const corner = document.createElement('div');
  corner.className = 'epg-corner';
  axis.appendChild(corner);
  for (let t = gridStart; t <= gridEnd; t += HOUR_MS) {
    const label = document.createElement('div');
    label.className = 'epg-hour';
    label.style.top = `${HEAD_H + yOf(t, gridStart)}px`;
    label.textContent = hh(t);
    axis.appendChild(label);
  }

  const cols = document.createElement('div');
  cols.className = 'epg-channels';

  // Channel columns + their rendered blocks (keyed by start) for now-highlight and reconcile.
  const columns: ColumnState[] = [];

  for (const ch of channels) {
    const col = document.createElement('div');
    col.className = 'epg-col';

    // Header is a link to the channel; clicking tunes in place (no permalink change).
    const head = document.createElement('a');
    head.className = 'epg-col-head';
    head.href = hrefFor({ kind: 'channel', xUrl: ch.xUrl });
    head.addEventListener('click', (e) => {
      e.preventDefault();
      handlers.onWatch(ch);
      handlers.onClose();
    });

    const line1 = document.createElement('div');
    line1.className = 'epg-head-1';
    if (ch.chno != null) {
      const chno = document.createElement('span');
      chno.className = 'epg-chno';
      chno.textContent = ch.chno;
      line1.appendChild(chno);
    }
    if (ch.logo) {
      const img = document.createElement('img');
      img.className = 'epg-head-img';
      img.loading = 'lazy';
      img.src = ch.logo;
      img.alt = '';
      line1.appendChild(img);
    }
    const line2 = document.createElement('div');
    line2.className = 'epg-head-2';
    line2.textContent = ch.name;
    head.append(line1, line2);

    const colBody = document.createElement('div');
    colBody.className = 'epg-col-body';
    colBody.style.height = `${bodyH}px`;

    col.append(head, colBody);
    cols.appendChild(col);

    const colState: ColumnState = { ch, colBody, byStart: new Map() };
    columns.push(colState);
    void loadColumn(colState);
  }

  // Now-line spanning the channel area.
  const nowLine = document.createElement('div');
  nowLine.className = 'epg-nowline';

  grid.append(axis, cols, nowLine);
  scroll.appendChild(grid);
  overlay.append(header, scroll);

  // --- live updates ---
  const refreshNow = (): void => {
    const now = Date.now();
    clock.textContent = clockFmt(now);
    const y = HEAD_H + yOf(now, gridStart);
    nowLine.style.top = `${y}px`;
    nowLine.style.display = now >= gridStart && now <= gridEnd ? '' : 'none';
    for (const col of columns)
      for (const rec of col.byStart.values())
        rec.el.classList.toggle('is-now', rec.prog.start <= now && now < rec.prog.stop);
  };

  let timer: number | undefined;
  const tick = (): void => {
    if (!overlay.isConnected) {
      clearTimeout(timer);
      return;
    }
    refreshNow();
    timer = window.setTimeout(tick, 60_000);
  };
  refreshNow();
  timer = window.setTimeout(tick, 60_000);

  // Esc closes the detail popup if open, else the overlay.
  const onKey = (e: KeyboardEvent): void => {
    if (!overlay.isConnected) {
      document.removeEventListener('keydown', onKey);
      return;
    }
    if (e.key !== 'Escape') return;
    const detail = overlay.querySelector('.epg-detail');
    if (detail) detail.remove();
    else handlers.onClose();
  };
  document.addEventListener('keydown', onKey);

  /** Position + fill a block's content from its current programme. */
  function applyBlock(r: RenderedBlock): void {
    const p = r.prog;
    const top = Math.max(0, yOf(p.start, gridStart));
    const bottom = Math.min(bodyH, yOf(p.stop, gridStart));
    r.el.style.top = `${top}px`;
    r.el.style.height = `${Math.max(bottom - top, 0)}px`;
    (r.el.querySelector('.epg-min') as HTMLElement).textContent = String(
      new Date(p.start).getMinutes(),
    ).padStart(2, '0');
    (r.el.querySelector('.epg-ptitle') as HTMLElement).textContent = p.title;
    (r.el.querySelector('.epg-psub') as HTMLElement).textContent = p.subTitle ?? '';
  }

  function createBlock(ch: Channel, prog: Programme): RenderedBlock {
    const el = document.createElement('div');
    el.className = 'epg-prog';
    el.innerHTML =
      '<span class="epg-min"></span><span class="epg-ptitle"></span><span class="epg-psub"></span>';
    const record: RenderedBlock = { el, prog };
    el.addEventListener('click', () => openDetail(record.prog, ch));
    applyBlock(record);
    return record;
  }

  /** Patch a column's DOM to match `progs`: add new, update changed, remove gone (keyed by start). */
  function reconcileColumn(col: ColumnState, progs: Programme[]): void {
    const seen = new Set<number>();
    for (const p of progs) {
      seen.add(p.start);
      const existing = col.byStart.get(p.start);
      if (existing) {
        if (
          existing.prog.title !== p.title ||
          existing.prog.subTitle !== p.subTitle ||
          existing.prog.stop !== p.stop
        ) {
          existing.prog = p;
          applyBlock(existing);
        }
      } else {
        const rec = createBlock(col.ch, p);
        col.byStart.set(p.start, rec);
        col.colBody.appendChild(rec.el);
      }
    }
    for (const [start, rec] of col.byStart) {
      if (!seen.has(start)) {
        rec.el.remove();
        col.byStart.delete(start);
      }
    }
    refreshNow();
  }

  async function loadColumn(col: ColumnState): Promise<void> {
    const progs = await programmesInRange(col.ch.tvgId, gridStart, gridEnd);
    if (!overlay.isConnected) return;
    reconcileColumn(col, progs);
  }

  /** Re-pull every column and reconcile in place (no full redraw) — used on EPG refresh. */
  function refresh(): void {
    if (!overlay.isConnected) return;
    for (const col of columns) void loadColumn(col);
  }

  function openDetail(p: Programme, ch: Channel): void {
    overlay.querySelector('.epg-detail')?.remove();
    const modal = document.createElement('div');
    modal.className = 'epg-detail';
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    const card = document.createElement('div');
    card.className = 'epg-detail-card';

    const x = document.createElement('button');
    x.className = 'epg-detail-close';
    x.setAttribute('aria-label', 'Close');
    x.textContent = '✕';
    x.addEventListener('click', () => modal.remove());

    const time = document.createElement('div');
    time.className = 'epg-detail-time';
    time.textContent = `${ch.name} · ${hhmm(p.start)} – ${hhmm(p.stop)}`;
    const h = document.createElement('h3');
    h.textContent = p.title;
    card.append(x, time, h);

    if (p.subTitle) {
      const sub = document.createElement('div');
      sub.className = 'epg-detail-sub';
      sub.textContent = p.subTitle;
      card.appendChild(sub);
    }
    if (p.desc) {
      const desc = document.createElement('p');
      desc.className = 'epg-detail-desc';
      desc.textContent = p.desc;
      card.appendChild(desc);
    }

    modal.appendChild(card);
    overlay.appendChild(modal);
  }

  // Once laid out, scroll horizontally so the current channel's column is centered (clamped).
  const currentIdx = current ? channels.findIndex((c) => c.xUrl === current.xUrl) : -1;
  if (currentIdx >= 0) {
    requestAnimationFrame(() => {
      if (!overlay.isConnected) return;
      const colEl = columns[currentIdx]?.colBody.parentElement as HTMLElement | null;
      if (!colEl) return;
      scroll.scrollLeft = Math.max(0, colEl.offsetLeft + colEl.offsetWidth / 2 - scroll.clientWidth / 2);
    });
  }

  return { element: overlay, refresh };
}
