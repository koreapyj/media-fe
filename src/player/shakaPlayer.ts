import shaka from 'shaka-player/dist/shaka-player.ui.js';
import type { Channel } from '../playlist/types';
import { LibassRenderer } from './libassRenderer';
import { ASS_MIME_TYPES, registerAssParser, setAssSink, type AssSink } from './assTextParser';
import { subtitleStyle } from './subtitleStyle';
import { registerBorderTypeMenu } from '../ui/borderTypeMenu';
import { registerEpgButton } from '../ui/epgGuide';
import { registerLiveButton } from '../ui/liveButton';
import { nowNext } from '../epg/epg';
import { loadJSON, saveJSON } from '../storage';

function isAssTrack(t: shaka.extern.TextTrack): boolean {
  const mime = (t.mimeType ?? '').toLowerCase();
  const codecs = (t.codecs ?? '').toLowerCase();
  return ASS_MIME_TYPES.includes(mime) || /ass|ssa/.test(mime) || /ass|ssa/.test(codecs);
}

/**
 * Owns the Shaka Player + Shaka UI overlay and the per-channel libass subtitle renderer.
 *
 * Controls (including the captions/subtitle selection menu) come from `shaka.ui.Overlay`. Subtitles
 * themselves are drawn by libass, not Shaka: the registered ASS parser side-channels segments into
 * the LibassRenderer while Shaka uses a StubTextDisplayer (no cues). Picking a track or toggling
 * captions in the UI flows through `selectTextTrack`/visibility, which we mirror onto libass.
 *
 * The video element and its container are created and owned here so they persist across channel
 * switches; the caller mounts `container` into the DOM.
 */
export class TvPlayer implements AssSink {
  readonly container: HTMLElement;
  private readonly video: HTMLVideoElement;
  private player: shaka.Player;
  private ui: shaka.ui.Overlay | null = null;
  private libass: LibassRenderer | null = null;

  /** init.ass URLs already fetched for the current program's header (deduped across live updates). */
  private fetchedHeaders = new Set<string>();
  /** boundary segment URI -> the init.ass URI declared after its `#EXT-X-DISCONTINUITY`. */
  private discontinuityBoundaries = new Map<string, string>();
  private unsubscribeStyle: (() => void) | null = null;
  /** Skip persisting subtitle-language changes during programmatic (restore) selection. */
  private suppressSubtitlePersist = false;
  /** Reschedule handle for updating Shaka's content title with the current programme. */
  private contentTitleTimer: number | undefined;
  /** Reused small canvas for frame-change detection while stepping frames. */
  private diffCanvas: HTMLCanvasElement | null = null;

  private constructor(container: HTMLElement, video: HTMLVideoElement) {
    this.container = container;
    this.video = video;
    this.player = new shaka.Player();
    // Our ASS parser returns no cues (libass draws the overlay), so Shaka UI's default text
    // displayer renders nothing — no need to override textDisplayFactory.
    // Keep a subtitle hiccup from ever killing video playback with an uncaught error.
    this.player.configure('manifest.hls.ignoreTextStreamFailures', true);
    this.setupSubtitlePipeline();
    this.player.addEventListener('error', (e) => {
      console.error('Shaka error', (e as CustomEvent).detail);
    });
    // Mirror UI caption changes onto libass (clear when off) and remember the user's selection.
    this.player.addEventListener('textchanged', () => {
      this.syncSubtitleState();
      this.persistSubtitleSelection();
    });
    this.player.addEventListener('texttrackvisibility', () => this.syncSubtitleState());
    // Wire Shaka UI "Subtitle size" (textDisplayer.fontScaleFactor) into our style store.
    this.player.addEventListener('configurationchanged', () => {
      const fs = this.player.getConfiguration().textDisplayer?.fontScaleFactor;
      if (typeof fs === 'number') subtitleStyle.setFontScale(fs);
    });
    // Apply any style override (font scale / border type) to the active libass renderer.
    this.unsubscribeStyle = subtitleStyle.subscribe((s) => this.libass?.setStyleOverrides(s));
    // Reflect the persisted "Subtitle size" so Shaka's menu shows it (no-op feedback via the guard).
    this.player.configure('textDisplayer.fontScaleFactor', subtitleStyle.get().fontScale);
    // In Picture-in-Picture the <video> moves to the PiP window but the libass canvas stays in the
    // page; flag the container so CSS can hide the stray subtitle overlay while in PiP.
    this.video.addEventListener('enterpictureinpicture', () => this.container.classList.add('pip'));
    this.video.addEventListener('leavepictureinpicture', () => this.container.classList.remove('pip'));
  }

  /** Create the player, its video/container, and the Shaka UI overlay. */
  static async create(): Promise<TvPlayer> {
    shaka.polyfill.installAll();
    registerAssParser();
    registerBorderTypeMenu();
    registerEpgButton();
    registerLiveButton();

    const container = document.createElement('div');
    container.className = 'tv-shaka';
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    container.appendChild(video);

    const tv = new TvPlayer(container, video);
    await tv.player.attach(video);

    tv.ui = new shaka.ui.Overlay(tv.player, container, video);
    tv.ui.configure({
      // Shaka's built-in top title slot; TvPlayer feeds it the current programme title.
      topControlPanelElements: ['content_title', 'spacer'],
      controlPanelElements: [
        'play_pause',
        'mute',
        'volume',
        'live',
        'spacer',
        'epg-guide',
        'language',
        'captions',
        'quality',
        'overflow_menu',
        'fullscreen',
      ],
      "enableTooltips": true,
      "enableKeyboardPlaybackControls": false,
      "singleClickForPlayAndPause": false,
      "doubleClickForFullscreen": false,
      overflowMenuButtons: [
        "statistics",
        'libass-border-type',
        "picture_in_picture",
        "remote",
      ],
    });
    return tv;
  }

  /** Load a channel's stream and wire up its ASS captions. */
  async playChannel(channel: Channel): Promise<void> {
    this.teardownSubtitles();
    this.libass = new LibassRenderer(this.video);
    this.libass.setStyleOverrides(subtitleStyle.get()); // seed current size/border overrides
    setAssSink(this); // TvPlayer mediates discontinuity handling before forwarding to libass

    // Restore the saved subtitle selection without persisting our own (programmatic) choice.
    this.suppressSubtitlePersist = true;
    await this.player.load(channel.streamUrl);
    this.applySubtitleSelection();
    this.suppressSubtitlePersist = false;

    this.startContentTitle(channel);
  }

  /**
   * Feed Shaka's `content_title` element the current programme title, re-arming at each programme
   * boundary (programme end, next start, or a fallback). Falls back to the channel name when there's
   * no EPG. Supersedes any prior channel's updater.
   */
  private startContentTitle(channel: Channel): void {
    clearTimeout(this.contentTitleTimer);
    const el = this.container.querySelector('.shaka-content-title') as HTMLElement | null;
    if (!el) return;
    const setText = (t: string): void => {
      el.textContent = t;
      this.video.title = t; // also surfaces to OS media session / casting
    };
    if (!channel.tvgId) {
      setText(channel.name);
      return;
    }
    const run = async (): Promise<void> => {
      let at: number;
      try {
        const { now, next } = await nowNext(channel.tvgId);
        setText(now?.title ?? channel.name);
        at = now ? now.stop : (next?.start ?? Date.now() + 60_000);
      } catch {
        setText(channel.name);
        at = Date.now() + 60_000;
      }
      const delay = Math.min(30 * 60_000, Math.max(1_000, at - Date.now()));
      clearTimeout(this.contentTitleTimer);
      this.contentTitleTimer = window.setTimeout(run, delay);
    };
    void run();
  }

  // --- Player actions (driven by keyboard shortcuts) ---

  toggleMute(): void {
    this.video.muted = !this.video.muted;
  }

  togglePlay(): void {
    if (this.video.paused) void this.video.play();
    else this.video.pause();
  }

  /**
   * Pause and step one frame (dir = +1 forward / -1 back). Frame rate isn't reliably known, so nudge
   * `currentTime` by a small delta and re-check the rendered frame, repeating until it actually changes
   * (capped). On a fully static scene the pixels won't change, so the cap bounds how far we move.
   */
  async stepFrame(dir: 1 | -1): Promise<void> {
    this.video.pause();
    const step = dir / 60;
    // Nudge currentTime directly (the browser bounds it to the seekable range — don't pre-clamp, which
    // can no-op or jump backward against a live seek range). Capped so static content can't loop forever.
    for (let i = 0; i < 30; i++) {
      const before = this.frameFingerprint();
      this.video.currentTime += step;
      await new Promise<void>((resolve) =>
        this.video.addEventListener('seeked', () => resolve(), { once: true }),
      );
      if (this.frameFingerprint() !== before) break;
    }
  }

  /** A dataURL of the current frame, used to detect when the frame changes. */
  private frameFingerprint(): string {
    const v = this.video;
    if (!v.videoWidth) return '';
    const c = (this.diffCanvas ??= document.createElement('canvas'));
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext('2d');
    if (!ctx) return '';
    try {
      ctx.drawImage(v, 0, 0);
      return c.toDataURL();
    } catch {
      return '';
    }
  }

  /** Seek by `seconds` (clamped to the seekable range); optionally pause first. */
  seekBy(seconds: number, pause: boolean): void {
    if (pause) this.video.pause();
    this.seekTo(this.video.currentTime + seconds);
  }

  private seekTo(time: number): void {
    const { start, end } = this.player.seekRange();
    this.video.currentTime = Math.max(start, Math.min(end, time));
  }

  goToLive(): void {
    if (this.player.isLive()) this.player.goToLive();
  }

  toggleFullscreen(): void {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void this.container.requestFullscreen();
  }

  /** Toggle the first closed-caption track on/off (mirrors the captions button). */
  toggleCaptions(): void {
    const tracks = this.player.getTextTracks();
    if (tracks.some((t) => t.active)) {
      this.player.selectTextTrack(null);
      return;
    }
    const cc = tracks.find(isAssTrack) ?? tracks[0];
    if (cc) this.player.selectTextTrack(cc);
  }

  /**
   * Copy the current frame to the clipboard as PNG. Unless `videoOnly`, composites the libass subtitle
   * overlay on top when captions are active. Requires a secure context + Clipboard API.
   */
  async captureToClipboard(videoOnly: boolean): Promise<void> {
    const v = this.video;
    if (!v.videoWidth || !v.videoHeight) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    try {
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      const subsActive = this.player.getTextTracks().some((t) => t.active);
      if (!videoOnly && subsActive) {
        const sub = this.container.querySelector(
          '.libassjs-canvas-parent canvas',
        ) as HTMLCanvasElement | null;
        if (sub?.width) ctx.drawImage(sub, 0, 0, canvas.width, canvas.height);
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
      );
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } catch (err) {
      console.warn('Frame capture failed', err);
    }
  }

  /** Select the persisted subtitle language ('off' / a language), else default to the ASS track. */
  private applySubtitleSelection(): void {
    const pref = loadJSON<string | null>('subtitleLang', null);
    if (pref === 'off') {
      this.player.selectTextTrack(null);
      return;
    }
    const tracks = this.player.getTextTracks();
    const byLang = pref ? tracks.find((t) => t.language === pref) : undefined;
    const track = byLang ?? tracks.find(isAssTrack) ?? tracks[0];
    if (track) this.player.selectTextTrack(track);
  }

  /** Remember the current subtitle selection (active track language, or 'off'). */
  private persistSubtitleSelection(): void {
    if (this.suppressSubtitlePersist) return;
    const active = this.player.getTextTracks().find((t) => t.active);
    saveJSON('subtitleLang', active ? active.language : 'off');
  }

  // --- AssSink (called by the registered text parser) ---

  /** init.ass header from our own fetch path; only used when set directly via loadHeader. */
  setHeader(headerText: string): void {
    this.libass?.setHeader(headerText);
  }

  /** A media segment's ASS. On a discontinuity boundary, reset libass and reload that program's header. */
  appendSegment(text: string, segmentStartSec: number, segmentEndSec: number, uri: string): void {
    const initUri = this.discontinuityBoundaries.get(uri);
    if (initUri) {
      this.discontinuityBoundaries.delete(uri);
      this.libass?.reset();
      void this.loadHeader(initUri, /* force= */ true);
    }
    this.libass?.appendSegment(text, segmentStartSec, segmentEndSec);
  }

  /** Keep the libass overlay consistent with the UI's caption selection (clear when turned off). */
  private syncSubtitleState(): void {
    if (!this.libass) return;
    const hasActiveText = this.player.getTextTracks().some((t) => t.active);
    if (!hasActiveText) this.libass.clear();
  }

  /** Stop playback and tear down captions (e.g. when returning to the channel list). */
  async unload(): Promise<void> {
    clearTimeout(this.contentTitleTimer);
    this.teardownSubtitles();
    await this.player.unload();
  }

  private teardownSubtitles(): void {
    setAssSink(null);
    this.fetchedHeaders.clear();
    this.discontinuityBoundaries.clear();
    if (this.libass) {
      this.libass.dispose();
      this.libass = null;
    }
  }

  /**
   * Make Shaka stream the raw ASS subtitle rendition correctly and route it to our parser, via one
   * networking response filter:
   *
   * - SEGMENT `.ass` responses: force `content-type: text/x-ssa` (a MIME we registered). Shaka has no
   *   `.ass` extension map and would otherwise default to text/vtt, so our parser would never run.
   * - MANIFEST = the ASS subtitle media playlist: strip its `#EXT-X-MAP:URI="init.ass"` line. Shaka
   *   treats any rendition with an init segment as fMP4 and tries to parse the raw `.ass` bytes as
   *   MP4 — which fails and nulls the text stream (Error 4015 + a null segmentIndex crash). Without
   *   EXT-X-MAP, Shaka streams the `.ass` files as raw text (like WebVTT segments). We fetch the
   *   init.ass ourselves to feed libass the header/styles (PlayResX/Y, fonts) it needs.
   */
  private setupSubtitlePipeline(): void {
    const net = this.player.getNetworkingEngine();
    if (!net) return;
    const RequestType = shaka.net.NetworkingEngine.RequestType;
    net.registerResponseFilter((type, response) => {
      if (type === RequestType.SEGMENT) {
        const path = (response.uri || response.originalUri || '').split('?')[0].toLowerCase();
        if (path.endsWith('.ass')) response.headers['content-type'] = 'text/x-ssa';
        return;
      }
      if (type === RequestType.MANIFEST) this.rewriteAssPlaylist(response);
    });
  }

  /**
   * For an ASS subtitle media playlist: strip `#EXT-X-MAP` (so Shaka streams raw `.ass`, see above),
   * load the current program's init.ass header, and record discontinuity boundaries. We track the
   * `#EXT-X-MAP` in effect for each segment and flag the segment that follows each inline
   * `#EXT-X-DISCONTINUITY` as a boundary, mapped to its (possibly same-named, new-content) init.ass.
   * `#EXT-X-DISCONTINUITY` is left intact for Shaka's timeline.
   */
  private rewriteAssPlaylist(response: shaka.extern.Response): void {
    const bytes =
      response.data instanceof ArrayBuffer
        ? new Uint8Array(response.data)
        : new Uint8Array(response.data.buffer, response.data.byteOffset, response.data.byteLength);
    const text = new TextDecoder().decode(bytes);
    if (!/#EXT-X-MAP:URI="[^"]+\.ass"/i.test(text)) return; // not an ASS subtitle playlist

    let currentMapUri: string | null = null;
    let pendingDiscontinuity = false;
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      if (line.startsWith('#')) {
        const map = line.match(/^#EXT-X-MAP:URI="([^"]+)"/i);
        if (map) currentMapUri = new URL(map[1], response.uri).href;
        else if (/^#EXT-X-DISCONTINUITY\b/i.test(line) && !/-SEQUENCE/i.test(line))
          pendingDiscontinuity = true;
        continue;
      }
      // Segment line.
      const segUri = new URL(line, response.uri).href;
      if (pendingDiscontinuity && currentMapUri) {
        this.discontinuityBoundaries.set(segUri, currentMapUri);
        pendingDiscontinuity = false;
      } else if (currentMapUri) {
        // Current program's header — fetch once (deduped across live playlist refreshes).
        void this.loadHeader(currentMapUri, /* force= */ false);
      }
    }

    const stripped = text.replace(/^#EXT-X-MAP:.*(?:\r?\n)?/gim, '');
    response.data = new TextEncoder().encode(stripped).buffer;
  }

  /**
   * Fetch an init.ass header (styles) and hand it to libass. `force` re-fetches even if previously
   * loaded (a discontinuity may reuse the same filename with new content); non-forced loads are
   * deduped so the current program's header isn't re-fetched on every live playlist refresh.
   */
  private async loadHeader(uri: string, force: boolean): Promise<void> {
    if (!force && this.fetchedHeaders.has(uri)) return;
    this.fetchedHeaders.add(uri);
    try {
      const res = await fetch(uri, { cache: 'no-store' });
      if (res.ok) this.libass?.setHeader(await res.text());
    } catch (err) {
      console.warn('Failed to load ASS init header', uri, err);
    }
  }

  async destroy(): Promise<void> {
    clearTimeout(this.contentTitleTimer);
    this.unsubscribeStyle?.();
    this.unsubscribeStyle = null;
    this.teardownSubtitles();
    if (this.ui) await this.ui.destroy();
    await this.player.destroy();
  }
}
