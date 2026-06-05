import SubtitlesOctopus from 'libass-wasm';
import { asset } from '../base';
import { parseDialogueLines, type AssEvent } from './assDocument';
import type { SubtitleStyleState } from './subtitleStyle';

/** Japanese ARIB subtitle face shipped with the app (always present in dist/fonts/). */
const ARIB_FONT_URL = asset('fonts/wlcmaru2004aribu.woff2');
const ARIB_FONT_NAME = 'wadalabchumarugo2004arib';

/** Placeholder duration (ms) for an open-ended caption until its real end (next start) is known. */
const OPEN_DURATION_MS = 3_600_000;

/** A libass style as returned by getStyles (fields + its track index). */
type LibassStyle = { Name: string; _index: number } & Record<string, unknown>;

/** Replace the alpha (low byte) of a libass colour (0xRRGGBBAA; 0=opaque, 0xFF=transparent). */
function withAlpha(colour: number, alpha: number): number {
  return ((((colour >>> 0) & 0xffffff00) | (alpha & 0xff)) >>> 0);
}

interface OpenEvent {
  index: number;
  startMs: number;
}

/**
 * Renders ASS subtitles over a <video> via libass-wasm (SubtitlesOctopus). The single subtitle SINK.
 *
 * Events are appended incrementally with createEvent (which does ass_alloc_event on the existing track)
 * — no per-segment library/fontconfig rebuild as setTrack would trigger. A Dialogue with an empty End
 * is created open-ended (large placeholder duration) and patched via setEvent when a later-start caption
 * arrives. On a stream discontinuity the caller invokes reset(), and a freshly fetched header recreates
 * the instance. The instance is created lazily once a real init.ass header is set; events that arrive
 * earlier (or between reset() and the next setHeader) are buffered and flushed when it becomes ready.
 */
export class LibassRenderer {
  private octopus: SubtitlesOctopus | null = null;
  private header: string | null = null;
  private headerReady = false;
  private ready = false; // octopus created AND styles resolved
  private creating = false;
  private disposed = false;

  private buffered: AssEvent[] = [];
  private openEvents: OpenEvent[] = [];
  private eventCount = 0; // mirrors track->n_events (append-only between resets)
  private styleIndexByName = new Map<string, number>();
  /** Authored styles (index 0 = the header's real Default), used as the base for user overrides. */
  private baseStyles: LibassStyle[] = [];
  /** Current user style overrides (font scale + border type); persists across reset(). */
  private overrides: SubtitleStyleState = { fontScale: 1, borderType: 'default' };

  constructor(
    private readonly video: HTMLVideoElement,
    private timeOffset = 0,
  ) {}

  /** Set the ASS header (init.ass: [Script Info]/[V4+ Styles]); (re)creates the libass instance. */
  setHeader(headerText: string): void {
    if (this.disposed) return;
    let header = headerText.replace(/\r\n/g, '\n').trimEnd();
    if (!/\[Events\]/i.test(header)) header += '\n\n[Events]\n';
    this.header = header;
    this.headerReady = true;
    void this.ensureOctopus();
  }

  /** Add the Dialogue lines of one media segment, rebased to its presentation time. */
  appendSegment(text: string, segmentStartSec: number, _segmentEndSec: number): void {
    if (this.disposed) return;
    const events = parseDialogueLines(text, segmentStartSec);
    if (!this.ready) {
      this.buffered.push(...events);
      void this.ensureOctopus();
      return;
    }
    this.addEvents(events);
  }

  /** Append events to libass, closing prior open captions when a later start arrives. */
  private addEvents(events: AssEvent[]): void {
    if (!this.octopus) return;
    for (const ev of events) {
      // Close open captions that started strictly earlier (equal start = same multi-line caption).
      for (let i = this.openEvents.length - 1; i >= 0; i--) {
        const open = this.openEvents[i];
        if (open.startMs < ev.startMs) {
          this.octopus.setEvent({ Duration: ev.startMs - open.startMs }, open.index);
          this.openEvents.splice(i, 1);
        }
      }
      const open = ev.endMs == null;
      this.octopus.createEvent({
        Start: ev.startMs,
        Duration: open ? OPEN_DURATION_MS : ev.endMs! - ev.startMs,
        Layer: ev.layer,
        Style: this.styleIndexByName.get(ev.style),
        Name: ev.name,
        MarginL: ev.marginL,
        MarginR: ev.marginR,
        MarginV: ev.marginV,
        Effect: ev.effect,
        Text: ev.text.replace(/\{\\(3a&Hff&|bord3)\}/g,''),
        ReadOrder: this.eventCount,
      });
      if (open) this.openEvents.push({ index: this.eventCount, startMs: ev.startMs });
      this.eventCount++;
    }
  }

  /** Clear the overlay (e.g. captions toggled off in the UI) without tearing down the instance. */
  clear(): void {
    if (this.disposed || !this.octopus) return;
    this.openEvents = [];
    this.buffered = [];
    this.octopus.setTrack(`${this.header ?? ''}\n[Events]\n`);
    this.eventCount = 0;
  }

  /** Tear down the instance on a discontinuity; a fresh setHeader() recreates it. */
  reset(): void {
    if (this.disposed) return;
    this.openEvents = [];
    this.buffered = [];
    this.eventCount = 0;
    this.ready = false;
    this.headerReady = false;
    this.styleIndexByName.clear();
    this.baseStyles = []; // overrides are kept and re-applied after the next resolveStyles
    if (this.octopus) {
      try {
        this.octopus.dispose();
      } catch {
        /* ignore */
      }
      this.octopus = null;
    }
  }

  setTimeOffset(seconds: number): void {
    this.timeOffset = seconds;
    if (this.octopus) this.octopus.timeOffset = seconds;
  }

  /** Create the instance once a header is available, resolve styles, then flush buffered events. */
  private async ensureOctopus(): Promise<void> {
    if (this.octopus || this.creating || this.disposed || !this.headerReady || !this.header) return;
    this.creating = true;
    const octopus = new SubtitlesOctopus({
      video: this.video,
      subContent: this.header,
      workerUrl: asset('libass/subtitles-octopus-worker.js'),
      legacyWorkerUrl: asset('libass/subtitles-octopus-worker-legacy.js'),
      fallbackFont: ARIB_FONT_URL,
      availableFonts: { [ARIB_FONT_NAME]: ARIB_FONT_URL },
      timeOffset: this.timeOffset,
      onError: (e) => console.error('SubtitlesOctopus error', e),
    });
    this.octopus = octopus;

    await this.resolveStyles(octopus);
    this.creating = false;
    if (this.disposed || this.octopus !== octopus) return;

    this.ready = true;
    if (this.buffered.length) {
      const pending = this.buffered;
      this.buffered = [];
      this.addEvents(pending);
    }
  }

  /**
   * Resolve style name -> libass index, and neutralise libass's synthetic "Default".
   *
   * libass always injects a built-in "Default" style (FontSize 18) at index 0; the header's real
   * styles are appended after it. An event whose Style resolves to 0 (a fallback) would therefore
   * render at half the authored size. We (a) retry getStyles until the header's styles have actually
   * been parsed (avoids a race with the worker building the track), (b) build a name->index map, and
   * (c) overwrite index 0 with the header's same-named style so even a fallback renders correctly.
   */
  private async resolveStyles(octopus: SubtitlesOctopus): Promise<void> {
    const get = () =>
      new Promise<LibassStyle[]>((res) =>
        octopus.getStyles((s) => res(s as LibassStyle[]), () => res([])),
      );

    let styles: LibassStyle[] = [];
    for (let attempt = 0; attempt < 40; attempt++) {
      if (this.disposed || this.octopus !== octopus) return;
      styles = await get();
      // libass's synthetic Default is index 0; >= 2 means the header's styles are parsed.
      if (styles.length >= 2) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    if (this.disposed || this.octopus !== octopus) return;

    for (const s of styles) this.styleIndexByName.set(s.Name, s._index);

    // libass's synthetic Default (FontSize 18) sits at index 0; use the header's same-named style as
    // index 0's base so even an event that falls back to index 0 renders at the authored style.
    const synthetic = styles.find((s) => s._index === 0);
    const real = [...styles].reverse().find(
      (s) => s.Name === (synthetic?.Name ?? 'Default') && s._index !== 0,
    );
    this.baseStyles = styles.map((s) => (s._index === 0 && real ? { ...real, _index: 0 } : s));

    // Push the authored base + any active user overrides into libass.
    this.applyStyleOverrides();
  }

  /** Set user style overrides (font scale + border type); applied now if ready, else on next resolve. */
  setStyleOverrides(overrides: SubtitleStyleState): void {
    this.overrides = overrides;
    if (this.ready) this.applyStyleOverrides();
  }

  /** Recompute every style from its authored base + the current overrides and push via setStyle. */
  private applyStyleOverrides(): void {
    if (this.disposed || !this.octopus || !this.baseStyles.length) return;
    for (const base of this.baseStyles) {
      this.octopus.setStyle(this.overrideStyle(base), base._index);
    }
  }

  /** Build the overridden style props for one base style (font scale + border mapping). */
  private overrideStyle(base: LibassStyle): Record<string, unknown> {
    const { _index, ...props } = base;
    void _index;
    props.FontSize = (Number(base.FontSize) || 0) * (this.overrides.fontScale || 1);

    const outline = Number(base.Outline) || 0;
    const shadow = Number(base.Shadow) || 0;
    const backColour = Number(base.BackColour) || 0;
    const outlineColour = Number(base.OutlineColour) || 0;
    props.OutlineColour = withAlpha(outlineColour,0x0);
    props.BackColour = withAlpha(backColour,0x0);
    switch (this.overrides.borderType) {
      case 'outline': // outline only
        props.BorderStyle = 1;
        props.Outline = 1;
        props.Shadow = 0;
        break;
      case 'shadow': // drop shadow only
        props.BorderStyle = 1;
        props.Outline = 0;
        props.Shadow = shadow || 2;
        break;
      case 'opaquebox': // fully opaque box
        props.BorderStyle = 3;
        props.Outline = outline || 4;
        props.Shadow = 0;
        props.OutlineColour = withAlpha(outlineColour,0x80);
        break;
      case 'default': // keep the authored border; only font scale applies
      default:
        break;
    }
    return props;
  }

  dispose(): void {
    this.disposed = true;
    this.openEvents = [];
    this.buffered = [];
    if (this.octopus) {
      try {
        this.octopus.dispose();
      } catch {
        /* ignore */
      }
      this.octopus = null;
    }
  }
}
