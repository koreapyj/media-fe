import type { Channel } from '../playlist/types';
import { nowNext } from '../epg/epg';
import { hrefFor } from '../router';
import { requestEpgToggle, epgIconSvg } from './epgGuide';

/** Min/max delay before the next programme-info refresh (clamps the boundary-derived timeout). */
const MIN_REFRESH_MS = 1_000;
const MAX_REFRESH_MS = 30 * 60_000;

/**
 * Build the player view: the shared Shaka UI container (created by TvPlayer) plus, shown on mobile
 * under the (16:9-constrained) video, a horizontal channel bar (EPG-header style) and an info panel
 * with the current programme name + description. Shaka draws the in-player chrome (content title).
 */
export function createPlayerView(
  channel: Channel,
  channels: Channel[],
  shakaContainer: HTMLElement,
  onWatch: (channel: Channel) => void,
): HTMLElement {
  const el = document.createElement('div');
  el.className = 'player-view';

  const wrap = document.createElement('div');
  wrap.className = 'video-wrap';
  wrap.appendChild(shakaContainer);
  el.appendChild(wrap);

  // Channel switcher between the video and the info panel (mobile-only, styled like the EPG X axis).
  el.appendChild(buildChannelBar(channels, channel, onWatch));

  // Programme info shown below the video on mobile (CSS-gated); fed the current programme.
  const info = document.createElement('div');
  info.className = 'player-info';
  info.innerHTML = `
    <div class="pi-channel"></div>
    <div class="pi-title"></div>
    <div class="pi-sub"></div>
    <div class="pi-desc"></div>`;
  (info.querySelector('.pi-channel') as HTMLElement).textContent =
    (channel.chno != null ? `${channel.chno}  ` : '') + channel.name;
  el.appendChild(info);

  // Mobile floating button (replaces the hidden control-bar EPG button) — opens the guide overlay.
  const fab = document.createElement('button');
  fab.className = 'epg-fab';
  fab.setAttribute('aria-label', 'Program guide');
  fab.appendChild(epgIconSvg());
  fab.addEventListener('click', () => requestEpgToggle());
  el.appendChild(fab);

  if (channel.tvgId) schedulePanelInfo(channel.tvgId, info);

  return el;
}

/** A horizontal channel switcher mirroring the EPG column headers (number + logo, then name). */
function buildChannelBar(
  channels: Channel[],
  current: Channel,
  onWatch: (channel: Channel) => void,
): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'player-chbar';

  for (const ch of channels) {
    const item = document.createElement('a');
    item.className = 'chbar-item';
    if (ch.xUrl === current.xUrl) item.classList.add('is-current');
    item.href = hrefFor({ kind: 'channel', xUrl: ch.xUrl });
    item.addEventListener('click', (e) => {
      e.preventDefault();
      onWatch(ch);
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
    item.append(line1, line2);
    bar.appendChild(item);
  }

  // Once laid out (mobile only — hidden on desktop), scroll the current channel into the centre.
  requestAnimationFrame(() => {
    if (!bar.isConnected) return;
    const cur = bar.querySelector('.chbar-item.is-current') as HTMLElement | null;
    if (cur) bar.scrollLeft = Math.max(0, cur.offsetLeft + cur.offsetWidth / 2 - bar.clientWidth / 2);
  });

  return bar;
}

/**
 * Keep the info panel's current programme (title / sub-title / description) up to date, re-arming at
 * each programme boundary. Self-stops when the view is detached (navigated away).
 */
function schedulePanelInfo(tvgId: string, info: HTMLElement): void {
  const titleEl = info.querySelector('.pi-title') as HTMLElement;
  const subEl = info.querySelector('.pi-sub') as HTMLElement;
  const descEl = info.querySelector('.pi-desc') as HTMLElement;
  let timer: number | undefined;

  const run = async (): Promise<void> => {
    let at: number;
    try {
      const { now, next } = await nowNext(tvgId);
      if (!info.isConnected) return;
      titleEl.textContent = now?.title ?? '';
      subEl.textContent = now?.subTitle ?? '';
      descEl.textContent = now?.desc ?? '';
      at = now ? now.stop : (next?.start ?? Date.now() + 60_000);
    } catch {
      if (!info.isConnected) return;
      at = Date.now() + 60_000;
    }
    const delay = Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, at - Date.now()));
    clearTimeout(timer);
    timer = window.setTimeout(run, delay);
  };

  // Defer the first run until the view is mounted (so the isConnected guard doesn't bail early).
  timer = window.setTimeout(run, 0);
}
