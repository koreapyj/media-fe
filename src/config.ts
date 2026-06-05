import { asset } from './base';

/**
 * Playlist URL. Defaults to `channels.m3u` served alongside the app under the runtime-detected
 * prefix (i.e. `/${PREFIX}/channels.m3u`); override with VITE_PLAYLIST_URL (see .env.example).
 */
export const PLAYLIST_URL: string = import.meta.env.VITE_PLAYLIST_URL || asset('channels.m3u');

/** Optional EPG override; when unset the playlist's `url-tvg` is used. */
export const EPG_URL_OVERRIDE: string | undefined = import.meta.env.VITE_EPG_URL || undefined;
