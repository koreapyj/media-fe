/** A single channel parsed from the M3U playlist. */
export interface Channel {
  /** Display name (text after the comma on the #EXTINF line). */
  name: string;
  /** The actual stream URL (the line following #EXTINF). */
  streamUrl: string;
  /** `x-url`: stable slug used in the app route `/${xUrl}/`. Falls back to a slug of the name. */
  xUrl: string;
  /** `tvg-id`: EPG channel id used to look up programmes (optional). */
  tvgId?: string;
  /** `tvg-chno`: channel number, kept as a string (may include a `.`-separated subpart). */
  chno?: string;
  /** `tvg-logo`: channel logo image URL (optional). */
  logo?: string;
  /** `thumb`: channel thumbnail image URL (optional). */
  thumb?: string;
  /** Category = the playlist this channel came from (assigned when merging playlists). */
  playlist?: string;
}

/** The full parsed playlist. */
export interface Playlist {
  /** `url-tvg` (or `x-tvg-url`) from the #EXTM3U header — the XMLTV EPG URL, if present. */
  epgUrl?: string;
  /** Category name from a `#PLAYLIST:` directive, if present. */
  name?: string;
  channels: Channel[];
}
