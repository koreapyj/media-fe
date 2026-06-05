import shaka from 'shaka-player/dist/shaka-player.ui.js';

/**
 * Sink for ASS subtitle data extracted from the HLS text stream. Implemented by TvPlayer, which
 * mediates discontinuity handling before forwarding to the LibassRenderer.
 */
export interface AssSink {
  setHeader(headerText: string): void;
  appendSegment(text: string, segmentStartSec: number, segmentEndSec: number, uri: string): void;
}

/**
 * Custom Shaka text parser for ASS subtitle streams. Shaka fetches the subtitle HLS playlist's
 * media segments and routes them here; instead of producing cues, we side-channel the raw ASS into
 * the active sink (which renders via libass) and return no cues.
 *
 * The sink is module-level because Shaka instantiates parsers via a zero-arg factory; there is
 * exactly one active player/channel at a time.
 */
let sink: AssSink | null = null;

export function setAssSink(s: AssSink | null): void {
  sink = s;
}

const decoder = new TextDecoder('utf-8');

interface TimeContext {
  segmentStart: number;
  segmentEnd: number;
}

class AssTextParser {
  parseInit(data: Uint8Array): void {
    sink?.setHeader(decoder.decode(data));
  }

  parseMedia(data: Uint8Array, time: TimeContext, uri?: string): unknown[] {
    // ASS timestamps in each segment restart at 0; the sink rebases to the segment's presentation
    // time. We render via libass and return no cues for Shaka's displayer.
    sink?.appendSegment(decoder.decode(data), time.segmentStart, time.segmentEnd, uri ?? '');
    return [];
  }

  setManifestType(_manifestType: string): void {
    // no-op
  }
}

/** MIME types an ASS/SSA subtitle rendition may be surfaced as by the manifest parser. */
export const ASS_MIME_TYPES = [
  'text/x-ssa',
  'text/ssa',
  'text/x-ass',
  'text/ass',
  'application/x-ass',
  'application/x-ssa',
];

let registered = false;

/** Register the ASS parser for all known ASS/SSA MIME types (idempotent). */
export function registerAssParser(): void {
  if (registered) return;
  registered = true;
  const factory = () => new AssTextParser();
  for (const mime of ASS_MIME_TYPES) {
    shaka.text.TextEngine.registerParser(mime, factory as never);
  }
}
