import './styles.css';
import 'shaka-player/dist/controls.css';
import { CONFIG_URL } from './config';
import { loadPlaylists, compareChno, type PlaylistSource } from './playlist/m3u';
import type { Channel } from './playlist/types';
import { ensureEpg, refreshEpg, onEpgUpdated } from './epg/epg';
import { Router, hrefFor, type Route } from './router';
import { renderChannelList } from './ui/channelList';
import { createPlayerView } from './ui/playerView';
import { createEpgOverlay, setEpgToggle } from './ui/epgGuide';
import { createChannelOsd, type ChannelOsd } from './ui/channelOsd';
import { TvPlayer } from './player/shakaPlayer';

class App {
  private channels: Channel[] = [];
  private byXUrl = new Map<string, Channel>();
  private tvPlayer: TvPlayer | null = null;
  private currentChannel: Channel | null = null;
  private epgOverlay: HTMLElement | null = null;
  private epgRefresh: (() => void) | null = null; // refresh fn of the open overlay, if any
  private epgUrls: string[] = []; // distinct XMLTV sources (one per playlist's url-tvg)
  private nav = 0; // generation token to ignore stale async navigations
  private readonly router: Router;
  private channelsByNumber: Channel[] = []; // channels with a number, ordered numerically
  private osd: ChannelOsd | null = null;

  constructor(private readonly root: HTMLElement) {
    this.router = new Router((r) => void this.onRoute(r));
  }

  async start(): Promise<void> {
    this.root.innerHTML = '<div class="loading">Loading playlist…</div>';
    try {
      const sources = await this.loadManifest();
      const { channels, epgUrls } = await loadPlaylists(sources);
      this.channels = channels;
      this.byXUrl = new Map(this.channels.map((c) => [c.xUrl, c]));
      this.channelsByNumber = this.channels
        .filter((c) => c.chno != null)
        .sort((a, b) => compareChno(a.chno, b.chno));
      this.osd = createChannelOsd(this.root, this.channels, (c) => void this.showChannel(c));
      this.installShortcuts();
      // Load/refresh each EPG source in the background (off-thread worker); the UI fills in as data lands.
      this.epgUrls = epgUrls;
      void ensureEpg(this.epgUrls);
      this.scheduleEpgRefresh();
      // When a feed finishes (re)loading, live-update the guide overlay if it's open.
      onEpgUpdated(() => this.epgRefresh?.());
      this.router.start();
    } catch (err) {
      this.fatal('Failed to load playlists: ' + (err as Error).message);
    }
  }

  /**
   * Fetch the JSON manifest listing the playlists (the only source — no fallback). Shape:
   * `{ "playlists": ["a.m3u", …], "overrides": { "a.m3u": { "availabilityWindow": 1800 } } }`.
   * `overrides` is keyed by the playlist URL and is optional; `availabilityWindow` is the
   * per-playlist live seek window in seconds. Malformed entries are dropped; empty is fatal.
   */
  private async loadManifest(): Promise<PlaylistSource[]> {
    const res = await fetch(CONFIG_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Failed to load config (${res.status}) from ${CONFIG_URL}`);
    const manifest = (await res.json()) as { playlists?: unknown; overrides?: unknown };
    const urls = Array.isArray(manifest.playlists)
      ? manifest.playlists.filter((u): u is string => typeof u === 'string' && u !== '')
      : [];
    if (!urls.length) throw new Error('Config lists no playlists');

    const overrides =
      manifest.overrides && typeof manifest.overrides === 'object'
        ? (manifest.overrides as Record<string, { availabilityWindow?: unknown }>)
        : {};
    return urls.map((url) => {
      const win = overrides[url]?.availabilityWindow;
      return {
        url,
        availabilityWindow:
          typeof win === 'number' && Number.isFinite(win) && win > 0 ? win : undefined,
      };
    });
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
        this.tvPlayer = await TvPlayer.create(this.root);
        setEpgToggle(() => this.toggleEpg());
      }
      if (gen !== this.nav) return;
      this.currentChannel = channel;
      // Reflect the channel in the URL. Skip when we got here from the router (URL already matches).
      const href = hrefFor({ kind: 'channel', xUrl: channel.xUrl });
      if (location.pathname !== href) history.pushState(null, '', href);
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

  /** Attach the global keyboard handler (browser vs installed-PWA key sets). */
  private installShortcuts(): void {
    // Capture phase so handled keys are consumed before focused Shaka controls also act on them
    // (e.g. the focused fullscreen button would otherwise re-toggle fullscreen on Enter).
    document.addEventListener('keydown', (e) => this.onKeyDown(e), true);
  }

  private onKeyDown(e: KeyboardEvent): void {
    // Active only while watching a channel; suspended while the guide overlay owns the keyboard.
    const tv = this.tvPlayer;
    if (!tv || !this.currentChannel || this.epgOverlay) return;

    const isDigit = (e.key >= '0' && e.key <= '9') || e.key === '.';
    const browser = window.matchMedia('(display-mode: browser),(display-mode: fullscreen)').matches;
    let handled = true;

    if (browser) {
      switch (e.key) {
        case 'm': tv.toggleMute(); break;
        case 'h': if (e.altKey) tv.toggleCaptions(); else handled = false; break;
        case 'c': if (e.ctrlKey) void tv.captureToClipboard(e.altKey); else handled = false; break;
        case 'd': void tv.stepFrame(-1); break;
        case 'f': void tv.stepFrame(1); break;
        case ' ': tv.togglePlay(); break;
        case 'Enter': tv.toggleFullscreen(); break;
        case 'Home': tv.goToLive(); break;
        case 'ArrowLeft': tv.seekBy(-5, true); break;
        case 'ArrowRight': tv.seekBy(5, false); break;
        case 'ArrowUp': this.tuneRelative(1); break;
        case 'ArrowDown': this.tuneRelative(-1); break;
        default: if (isDigit) this.osd?.pressKey(e.key); else handled = false;
      }
    } else {
      switch (e.key) {
        case 'Home': tv.goToLive(); break;
        case 'MediaSkipBackward': tv.seekBy(-5, true); break;
        case 'MediaSkipForward': tv.seekBy(5, false); break;
        case 'ChannelUp': this.tuneRelative(1); break;
        case 'ChannelDown': this.tuneRelative(-1); break;
        case 'ClosedCaptionToggle': tv.toggleCaptions(); break;
        case 'Info': this.osd?.pressKey('.'); break;
        default: if (isDigit) this.osd?.pressKey(e.key); else handled = false;
      }
    }

    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  /** Tune to the next/previous channel by number (wrapping around). */
  private tuneRelative(delta: 1 | -1): void {
    const ring = this.channelsByNumber;
    const n = ring.length;
    if (!n) return;
    const idx = this.currentChannel ? ring.indexOf(this.currentChannel) : -1;
    const next = idx === -1 ? (delta > 0 ? 0 : n - 1) : ((idx + delta) % n + n) % n;
    void this.showChannel(ring[next]);
  }

  /** Re-download the EPG at the top of each hour (off-thread; the open overlay live-updates on done). */
  private scheduleEpgRefresh(): void {
    const now = Date.now();
    const next = new Date(now);
    next.setHours(next.getHours() + 1, 0, 0, 0);
    window.setTimeout(() => {
      void refreshEpg(this.epgUrls);
      window.setInterval(() => void refreshEpg(this.epgUrls), 60 * 60 * 1000);
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
