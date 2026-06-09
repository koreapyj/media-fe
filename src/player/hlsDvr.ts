/**
 * Client-side DVR window for short-playlist live HLS.
 *
 * Some live HLS media playlists expose only a few segments at a time, so Shaka's seek/DVR range is
 * tiny — and Shaka prunes its segment index to the current playlist on every refresh
 * (`SegmentIndex.evict(playlistStartTime)`), so `manifest.availabilityWindowOverride` can't help.
 *
 * `HlsWindowAccumulator.ingest()` is fed each upstream media playlist (via the networking response
 * filter) and returns a re-serialized playlist that RETAINS scrolled-off segments up to `windowSec`,
 * so Shaka sees a deep window. Original `EXT-X-MEDIA-SEQUENCE` numbers are preserved (required for
 * AES-128 implicit-IV correctness); `EXT-X-KEY`/`EXT-X-MAP` are re-emitted statefully so the oldest
 * retained segment still carries its key/map; `EXT-X-DISCONTINUITY[-SEQUENCE]` is recomputed
 * consistently. The server must still serve the retained segment URLs (and their keys).
 */

interface SegRecord {
  /** Absolute media-sequence number (playlist `EXT-X-MEDIA-SEQUENCE` + index). Stable across refreshes. */
  seq: number;
  /** Absolute discontinuity-sequence (playlist `EXT-X-DISCONTINUITY-SEQUENCE` + inline count). */
  discSeq: number;
  /** Active `EXT-X-KEY` line(s) for this segment (verbatim), or `[]` when unencrypted. */
  keyLines: string[];
  /** Active `EXT-X-MAP` line (verbatim), or null. */
  mapLine: string | null;
  /** Per-segment tags in order (EXTINF, BYTERANGE, PROGRAM-DATE-TIME, GAP, …), excluding KEY/MAP/DISCONTINUITY. */
  segTags: string[];
  /** Raw URI line, kept relative (the rewritten playlist is served at the same URL). */
  uriLine: string;
  /** EXTINF duration (seconds). */
  durationSec: number;
}

/** Tags whose latest value we carry into the re-serialized header (besides the recomputed counters). */
const HEADER_TAGS = [
  'EXT-X-VERSION',
  'EXT-X-INDEPENDENT-SEGMENTS',
  'EXT-X-PLAYLIST-TYPE',
  'EXT-X-START',
  'EXT-X-SERVER-CONTROL',
];

/** Presence of any of these makes accumulation unsafe/meaningless → pass the playlist through as-is. */
const BYPASS_RE = /^#EXT-X-(PART|PART-INF|SKIP|ENDLIST)\b/im;

export class HlsWindowAccumulator {
  private segs: SegRecord[] = [];
  private targetDuration = '#EXT-X-TARGETDURATION:10';
  private header = new Map<string, string>(); // tag name -> latest verbatim line
  private readonly windowSec: number;

  constructor(windowSec: number) {
    this.windowSec = windowSec;
  }

  /** Ingest one upstream media playlist; return the accumulated (deep) playlist, or the input verbatim if bypassed. */
  ingest(text: string): string {
    if (BYPASS_RE.test(text) || !/^#EXTINF:/im.test(text)) return text;

    const incoming = this.parse(text);
    if (!incoming.length) return this.serialize();

    // Stream reset: the front moved backward, or we missed segments (non-contiguous forward jump).
    // Either case would feed Shaka a front earlier/disjoint from what it holds — start fresh instead.
    const curMax = this.segs.length ? this.segs[this.segs.length - 1].seq : -Infinity;
    const curMin = this.segs.length ? this.segs[0].seq : Infinity;
    if (incoming[0].seq < curMin || incoming[0].seq > curMax + 1) this.segs = [];

    const max = this.segs.length ? this.segs[this.segs.length - 1].seq : -Infinity;
    for (const rec of incoming) if (rec.seq > max) this.segs.push(rec);

    // Cap to the window by dropping the oldest segments.
    let total = this.segs.reduce((s, r) => s + r.durationSec, 0);
    while (this.segs.length > 1 && total - this.segs[0].durationSec >= this.windowSec) {
      total -= this.segs[0].durationSec;
      this.segs.shift();
    }

    return this.serialize();
  }

  /** Parse a playlist into segment records (each tagged with absolute media/discontinuity sequence). */
  private parse(text: string): SegRecord[] {
    let headerMSN = 0;
    let headerDSN = 0;
    let segIndex = 0;
    let inlineDisc = 0;
    let keyLines: string[] = [];
    let mapLine: string | null = null;
    let lastWasKey = false;
    let pendingTags: string[] = [];
    let pendingDur = 0;
    const incoming: SegRecord[] = [];

    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '') continue;

      if (!line.startsWith('#')) {
        incoming.push({
          seq: headerMSN + segIndex,
          discSeq: headerDSN + inlineDisc,
          keyLines,
          mapLine,
          segTags: pendingTags,
          uriLine: line,
          durationSec: pendingDur,
        });
        segIndex++;
        pendingTags = [];
        pendingDur = 0;
        lastWasKey = false;
        continue;
      }

      if (/^#EXTINF:/i.test(line)) {
        pendingDur = parseFloat(line.slice(line.indexOf(':') + 1)) || 0;
        pendingTags.push(line);
        lastWasKey = false;
      } else if (/^#EXT-X-(BYTERANGE|PROGRAM-DATE-TIME|GAP|BITRATE)\b/i.test(line)) {
        pendingTags.push(line);
        lastWasKey = false;
      } else if (/^#EXT-X-DISCONTINUITY-SEQUENCE:/i.test(line)) {
        headerDSN = parseInt(line.slice(line.indexOf(':') + 1), 10) || 0;
        lastWasKey = false;
      } else if (/^#EXT-X-DISCONTINUITY\b/i.test(line)) {
        inlineDisc++;
        lastWasKey = false;
      } else if (/^#EXT-X-KEY\b/i.test(line)) {
        keyLines = (lastWasKey ? keyLines : []).concat(line); // a fresh KEY run replaces the prior set
        lastWasKey = true;
      } else if (/^#EXT-X-MAP\b/i.test(line)) {
        mapLine = line;
        lastWasKey = false;
      } else if (/^#EXT-X-MEDIA-SEQUENCE:/i.test(line)) {
        headerMSN = parseInt(line.slice(line.indexOf(':') + 1), 10) || 0;
        lastWasKey = false;
      } else if (/^#EXT-X-TARGETDURATION:/i.test(line)) {
        this.targetDuration = line;
        lastWasKey = false;
      } else if (/^#EXTM3U\b/i.test(line)) {
        lastWasKey = false;
      } else {
        const name = line.slice(1).split(':')[0].toUpperCase();
        if (HEADER_TAGS.includes(name) && !incoming.length && !pendingTags.length) {
          this.header.set(name, line);
        } else {
          pendingTags.push(line); // unknown tag adjacent to a segment → treat as per-segment
        }
        lastWasKey = false;
      }
    }

    return incoming;
  }

  /** Re-serialize the retained segments as one live media playlist (no EXT-X-ENDLIST). */
  private serialize(): string {
    if (!this.segs.length) return '#EXTM3U\n';
    const out: string[] = ['#EXTM3U'];
    out.push(this.header.get('EXT-X-VERSION') ?? '#EXT-X-VERSION:3');
    for (const name of HEADER_TAGS) {
      if (name === 'EXT-X-VERSION') continue;
      const line = this.header.get(name);
      if (line) out.push(line);
    }
    out.push(this.targetDuration);
    out.push(`#EXT-X-MEDIA-SEQUENCE:${this.segs[0].seq}`);
    out.push(`#EXT-X-DISCONTINUITY-SEQUENCE:${this.segs[0].discSeq}`);

    let lastKey: string | null = null;
    let lastMap: string | null = null;
    let prevDiscSeq = this.segs[0].discSeq;
    for (let i = 0; i < this.segs.length; i++) {
      const seg = this.segs[i];
      if (i > 0 && seg.discSeq > prevDiscSeq) out.push('#EXT-X-DISCONTINUITY');
      if (seg.mapLine && seg.mapLine !== lastMap) {
        out.push(seg.mapLine);
        lastMap = seg.mapLine;
      }
      const keyJoin = seg.keyLines.join('\n');
      if (keyJoin !== lastKey) {
        out.push(...seg.keyLines);
        lastKey = keyJoin;
      }
      out.push(...seg.segTags, seg.uriLine);
      prevDiscSeq = seg.discSeq;
    }
    return out.join('\n') + '\n';
  }
}
