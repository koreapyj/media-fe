import './styles.css';
import 'shaka-player/dist/controls.css';
import { PLAYLIST_URL, EPG_URL_OVERRIDE } from './config';
import { loadPlaylist } from './playlist/m3u';
import type { Channel } from './playlist/types';
import { ensureEpg } from './epg/epg';
import { Router, hrefFor, type Route } from './router';
import { renderChannelList } from './ui/channelList';
import { createPlayerView } from './ui/playerView';
import { TvPlayer } from './player/shakaPlayer';

class App {
  private channels: Channel[] = [];
  private byXUrl = new Map<string, Channel>();
  private tvPlayer: TvPlayer | null = null;
  private nav = 0; // generation token to ignore stale async navigations
  private readonly router: Router;

  constructor(private readonly root: HTMLElement) {
    this.router = new Router((r) => void this.onRoute(r));
  }

  async start(): Promise<void> {
    this.root.innerHTML = '<div class="loading">Loading playlist…</div>';
    try {
      const playlist = await loadPlaylist(PLAYLIST_URL);
      this.channels = playlist.channels;
      this.byXUrl = new Map(this.channels.map((c) => [c.xUrl, c]));
      // Load/refresh EPG in the background; the UI fills in as data lands.
      void ensureEpg(EPG_URL_OVERRIDE ?? playlist.epgUrl);
      this.router.start();
    } catch (err) {
      this.fatal('Failed to load playlist: ' + (err as Error).message);
    }
  }

  private async onRoute(route: Route): Promise<void> {
    const gen = ++this.nav;
    if (route.kind === 'list') {
      if (this.tvPlayer) await this.tvPlayer.unload();
      if (gen !== this.nav) return;
      this.mount(renderChannelList(this.channels));
      return;
    }

    const channel = this.byXUrl.get(route.xUrl);
    if (!channel) {
      this.notFound(route.xUrl);
      return;
    }

    try {
      if (!this.tvPlayer) this.tvPlayer = await TvPlayer.create();
      if (gen !== this.nav) return;
      this.mount(createPlayerView(channel, this.tvPlayer.container));
      await this.tvPlayer.playChannel(channel);
    } catch (err) {
      if (gen === this.nav) console.error('Playback failed', err);
    }
  }

  private mount(el: HTMLElement): void {
    this.root.replaceChildren(el);
  }

  private notFound(xUrl: string): void {
    const el = document.createElement('div');
    el.className = 'message';
    el.innerHTML = `<p>Channel not found: <code></code></p>
      <a data-link href="${hrefFor({ kind: 'list' })}">← Back to channels</a>`;
    (el.querySelector('code') as HTMLElement).textContent = xUrl;
    this.mount(el);
  }

  private fatal(message: string): void {
    const el = document.createElement('div');
    el.className = 'message error';
    el.textContent = message;
    this.mount(el);
  }
}

const root = document.getElementById('app');
if (root) void new App(root).start();
