# media-fe — TV Player

A static, single-page TV player:

- Parses an **M3U** playlist (channels + `url-tvg` EPG URL).
- Loads an **XMLTV EPG** into **IndexedDB** and shows now/next per channel.
- Plays HLS with **Shaka Player 5.1** (+ **Shaka UI** overlay for playback controls and the
  **subtitle/caption selection** menu), routing each stream at `/<x-url>/`.
- Renders each stream's **separate ASS-subtitle HLS playlist** (init.ass + segmented .ass) with
  **libass-wasm / SubtitlesOctopus**, wired in as a custom Shaka **text parser** that side-channels
  the ASS into a libass canvas overlay (Shaka itself draws no cues).

No backend: it's pure static files, designed to be served by **nginx only**. The app **auto-detects
its URL prefix at runtime**, so one build runs at `/` or under any subpath (e.g. `/tv/`) with no
rebuild — see the bootstrap in [index.html](index.html) and [deploy/nginx.conf](deploy/nginx.conf).

## Configure

```bash
cp .env.example .env
# edit VITE_PLAYLIST_URL (and optionally VITE_EPG_URL)
```

All upstream origins (M3U, EPG, HLS + subtitle segments) must allow cross-origin requests (CORS).

## Develop

```bash
npm install        # also vendors libass assets into public/libass/ (postinstall)
npm run dev
```

## Build & deploy

```bash
npm run build      # -> dist/ (fully static)
node scripts/verify-bootstrap.mjs   # checks subpath auto-detection against an nginx-like server
```

Copy `dist/` to your web root (or a subpath) and serve with the sample
[deploy/nginx.conf](deploy/nginx.conf).

## Layout

- `src/playlist/` — M3U parsing (`m3u.ts`) and types.
- `src/epg/` — XMLTV parsing (`xmltv.ts`), IndexedDB store (`db.ts`), load/refresh + now-next (`epg.ts`).
- `src/player/` — `libassRenderer.ts` (the single subtitle sink), `assTextParser.ts` (Shaka text
  parser feeding it), `shakaPlayer.ts` (player + track wiring).
- `src/router.ts`, `src/base.ts`, `src/ui/` — History-API routing, runtime base, and views.

## Subtitle integration note

ASS captions are a SUBTITLES rendition in the master HLS playlist. Shaka streams the `.ass` media
segments and routes them to the registered ASS parser (`src/player/assTextParser.ts`, MIME types in
`ASS_MIME_TYPES`), which forwards them to `TvPlayer` (the sink) and into `LibassRenderer`; Shaka draws
no cues.

`LibassRenderer` renders **incrementally** — each segment's Dialogue lines are appended via
SubtitlesOctopus `createEvent` (no per-segment `setTrack`, which would rebuild the libass library +
fontconfig DB every few seconds). Fields are read **by name** from each segment's own `[Events]`
`Format:` line, and styles are resolved by name via `getStyles` (no positional assumptions). A
Dialogue with an empty End is created open-ended and its duration is patched via `setEvent` when a
later-start caption arrives. On an inline `#EXT-X-DISCONTINUITY`, `TvPlayer` resets libass and
force-reloads that program's `#EXT-X-MAP` `init.ass` (no-store, even if the filename repeats).

Two adjustments in `src/player/shakaPlayer.ts` make Shaka handle the raw-ASS-over-HLS shape (a
networking response filter does both):

- **Force `text/x-ssa`** on `.ass` segment responses — Shaka has no `.ass` extension→MIME map and
  would otherwise fall back to `text/vtt`.
- **Strip `#EXT-X-MAP:init.ass`** from the subtitle media playlist — Shaka treats any rendition with
  an init segment as fMP4 and tries to parse the raw ASS bytes as MP4 (Error 4015 + a null
  segmentIndex crash). Without it, Shaka streams the `.ass` files as raw text (like WebVTT). The
  `init.ass` header (PlayResX/Y, styles, fonts) is fetched directly and fed to libass via
  `setHeader` (see `loadHeader`). `manifest.hls.ignoreTextStreamFailures` is enabled so any subtitle
  hiccup can never break video playback.

## Korean machine translation

When a master playlist has a Japanese subtitle rendition, the same filter adds a copy named
**한국어 (자동번역)** (`src/player/assTranslate.ts`). Its playlist URI carries a `#hdtrans` fragment, so
it is a separate track over the same files. While it is selected, `TvPlayer` translates each segment
with [hdTrans](https://github.com/sokcuri/hdTrans) before libass, in order. Source caption boundaries
are registered immediately, so slow translation does not keep the preceding caption on screen past
its original end. Translated text retains the original presentation timestamps.

A caption's rows are grouped into blocks (by gap, position, colour and speaker marks) and sent as one
`wrapped` call, blocks split by a blank line, with the track's recent captions as `context`. The
Korean comes back line for line and is laid out per block in NanumSquareRound (`public/fonts/`).

The engine, runtime and ~37 MB dictionary are vendored from the `hdtrans` package into
`public/hdtrans/` (postinstall, like libass) and run in a worker (`src/player/hdtransWorker.ts`);
nothing of it, nor the Korean font, loads until the Korean track is selected. Switching tracks clears
libass, since the previous track's open-ended captions would otherwise overlap the new one.
