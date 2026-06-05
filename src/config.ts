import { asset } from './base';

/**
 * URL of the runtime JSON manifest listing the playlists to load:
 *   { "playlists": ["a.m3u", "b.m3u"] }
 * Each playlist supplies its own XMLTV EPG via its `#EXTM3U url-tvg`. Defaults to `config.json` served
 * alongside the app under the runtime-detected prefix; override with VITE_CONFIG_URL (see .env.example).
 * The manifest is the only source — there is no single-playlist fallback.
 */
export const CONFIG_URL: string = import.meta.env.VITE_CONFIG_URL || asset('config.json');
