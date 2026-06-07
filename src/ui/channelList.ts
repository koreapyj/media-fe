import type { Channel } from '../playlist/types';
import { nowNext } from '../epg/epg';
import { hrefFor } from '../router';

function timeRange(start: number, stop: number): string {
  const fmt = (t: number) =>
    new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${fmt(start)}–${fmt(stop)}`;
}

/** Render the channel grid. Anchors use data-link so the Router intercepts navigation. */
export function renderChannelList(channels: Channel[]): HTMLElement {
  const view = document.createElement('div');
  view.className = 'channel-list';
  view.innerHTML = `<header class="topbar"><h1>Channels</h1>
    <span class="count">${channels.length}</span></header>`;

  const grid = document.createElement('div');
  grid.className = 'grid';
  view.appendChild(grid);

  for (const ch of channels) {
    const a = document.createElement('a');
    a.className = 'card';
    a.dataset.link = '';
    a.href = hrefFor({ kind: 'channel', xUrl: ch.xUrl });

    const img = ch.logo || ch.thumb;
    a.innerHTML = `
      <div class="thumb">${
        img ? `<img loading="lazy" src="${img}" alt="">` : '<div class="noimg"></div>'
      }${ch.chno != null ? `<span class="chno">${ch.chno}</span>` : ''}</div>
      <div class="meta">
        <div class="name"></div>
        <div class="epg now">·</div>
        <div class="epg next"></div>
      </div>`;
    (a.querySelector('.name') as HTMLElement).textContent = ch.name;
    grid.appendChild(a);

    if (ch.tvgId) fillEpg(a, ch.tvgId);
  }

  return view;
}

/** Asynchronously fill the now/next lines for one card from IndexedDB. */
async function fillEpg(card: HTMLElement, tvgId: string): Promise<void> {
  try {
    const { now, next } = await nowNext(tvgId);
    const nowEl = card.querySelector('.now') as HTMLElement;
    const nextEl = card.querySelector('.next') as HTMLElement;
    if (now) nowEl.textContent = `Now: ${now.title}  ${timeRange(now.start, now.stop)}`;
    else nowEl.textContent = '';
    if (next) nextEl.textContent = `Next: ${next.title}`;
  } catch {
    /* no EPG for this channel */
  }
}
