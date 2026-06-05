/**
 * Build the player view: just the shared Shaka UI container (created by TvPlayer). All overlay chrome —
 * including the content title (the current programme, driven by TvPlayer into Shaka's `content_title`) —
 * is rendered by Shaka UI.
 */
export function createPlayerView(shakaContainer: HTMLElement): HTMLElement {
  const el = document.createElement('div');
  el.className = 'player-view';

  const wrap = document.createElement('div');
  wrap.className = 'video-wrap';
  wrap.appendChild(shakaContainer);
  el.appendChild(wrap);

  return el;
}
