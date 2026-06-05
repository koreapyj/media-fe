import type { Channel } from '../playlist/types';
import { nowNext } from '../epg/epg';
import { APP_BASE } from '../base';

/**
 * Build the player view: the shared Shaka UI container (created by TvPlayer) plus a lightweight
 * top overlay with a back link and the channel title. Player/subtitle controls come from Shaka UI.
 */
export function createPlayerView(channel: Channel, shakaContainer: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.className = 'player-view';

  const wrap = document.createElement('div');
  wrap.className = 'video-wrap';
  wrap.appendChild(shakaContainer);
  el.appendChild(wrap);

  const overlay = document.createElement('div');
  overlay.className = 'player-topbar';
  overlay.innerHTML = `
    <a class="back" data-link href="${APP_BASE}">← Channels</a>
    <div class="now-playing">
      <div class="title"></div>
      <div class="epg-now"></div>
    </div>`;
  (overlay.querySelector('.title') as HTMLElement).textContent =
    (channel.chno != null ? `${channel.chno}  ` : '') + channel.name;
  el.appendChild(overlay);

  if (channel.tvgId) {
    nowNext(channel.tvgId)
      .then(({ now }) => {
        if (now) (overlay.querySelector('.epg-now') as HTMLElement).textContent = now.title;
      })
      .catch(() => {});
  }

  return el;
}
