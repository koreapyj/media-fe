import './styles.css';
import 'shaka-player/dist/controls.css';
import { PLAYLIST_URL, EPG_URL_OVERRIDE } from './config';
import { loadPlaylist } from './playlist/m3u';
import type { Channel } from './playlist/types';
import { ensureEpg, refreshEpg, onEpgUpdated } from './epg/epg';
import { Router, hrefFor, type Route } from './router';
import { renderChannelList } from './ui/channelList';
import { createPlayerView } from './ui/playerView';
import { createEpgOverlay, setEpgToggle } from './ui/epgGuide';
import { TvPlayer } from './player/shakaPlayer';

class App {
  private channels: Channel[] = [];
  private byXUrl = new Map<string, Channel>();
  private tvPlayer: TvPlayer | null = null;
  private currentChannel: Channel | null = null;
  private epgOverlay: HTMLElement | null = null;
  private epgRefresh: (() => void) | null = null; // refresh fn of the open overlay, if any
  private epgUrl: string | undefined;
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
      // Load/refresh EPG in the background (off-thread worker); the UI fills in as data lands.
      this.epgUrl = EPG_URL_OVERRIDE ?? playlist.epgUrl;
      void ensureEpg(this.epgUrl);
      this.scheduleEpgRefresh();
      // When a (re)load finishes, live-update the guide overlay if it's open.
      onEpgUpdated(() => this.epgRefresh?.());
      this.router.start();
    } catch (err) {
      this.fatal('Failed to load playlist: ' + (err as Error).message);
    }
  }

  private async onRoute(route: Route): Promise<void> {
    if (route.kind === 'list') {
      const gen = ++this.nav;
      this.closeEpg();
      if (this.tvPlayer) await this.tvPlayer.unload();
      if (gen !== this.nav) return;
      this.mount(renderChannelList(this.channels));
      return;
    }

    const channel = this.byXUrl.get(route.xUrl);
    if (!channel) {
      ++this.nav;
      this.notFound(route.xUrl);
      return;
    }
    await this.showChannel(channel);
  }

  /** Mount the player view for a channel and start playback (no routing — also used by the guide). */
  private async showChannel(channel: Channel): Promise<void> {
    const gen = ++this.nav;
    try {
      if (!this.tvPlayer) {
        this.tvPlayer = await TvPlayer.create();
        setEpgToggle(() => this.toggleEpg());
      }
      if (gen !== this.nav) return;
      this.currentChannel = channel;
      this.closeEpg();
      this.mount(
        createPlayerView(channel, this.channels, this.tvPlayer.container, (ch) =>
          void this.showChannel(ch),
        ),
      );
      await this.tvPlayer.playChannel(channel);
    } catch (err) {
      if (gen === this.nav) console.error('Playback failed', err);
    }
  }

  /** Re-download the EPG at the top of each hour (off-thread; the open overlay live-updates on done). */
  private scheduleEpgRefresh(): void {
    const now = Date.now();
    const next = new Date(now);
    next.setHours(next.getHours() + 1, 0, 0, 0);
    window.setTimeout(() => {
      void refreshEpg(this.epgUrl);
      window.setInterval(() => void refreshEpg(this.epgUrl), 60 * 60 * 1000);
    }, next.getTime() - now);
  }

  /** Toggle the program-guide overlay over the current player (invoked by the control-bar button). */
  private toggleEpg(): void {
    if (this.epgOverlay) {
      this.closeEpg();
      return;
    }
    const { element, refresh } = createEpgOverlay(this.channels, this.currentChannel, {
      onWatch: (ch) => void this.showChannel(ch),
      onClose: () => this.closeEpg(),
    });
    this.epgOverlay = element;
    this.epgRefresh = refresh;
    this.root.appendChild(element);
  }

  private closeEpg(): void {
    this.epgOverlay?.remove();
    this.epgOverlay = null;
    this.epgRefresh = null;
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
