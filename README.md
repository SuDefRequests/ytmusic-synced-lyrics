# Synced Lyrics for YouTube Music

Spotify-style synced lyrics **inside YouTube Music's own Lyrics tab**. The plain LyricFind text is replaced in place with a line-by-line (and karaoke word-level) view that keeps the native look and scrolling.

## Install / update

**Easiest:** download `synced-lyrics-ytmusic-v1.0.0.zip` from the [latest release](https://github.com/SuDefRequests/ytmusic-synced-lyrics/releases/latest), unzip it, then follow step 1 below and select the unzipped folder.

1. `chrome://extensions`
2. Developer mode → **Load unpacked** (first time) or click the extension's **Reload** button (after an update)
3. Select this folder
4. Open a song on [music.youtube.com](https://music.youtube.com) and open the **Lyrics** tab

`Alt + L` toggles synced/plain lyrics. Click any line to seek.

## How it works

- YouTube Music's web UI only ships a plain, unsynced LyricFind blob — its internal API does not expose timed lyrics.
- Timed lyrics come from [LRCLIB](https://lrclib.net) (free, no API key). Lookup tries exact metadata first, then progressively drops album/duration fields to find a match.
- If a line has no word timings, word times are estimated from the gap to the next line so the karaoke fill still works.
- The player's `currentTime` drives highlighting; no audio analysis is used.

## Why the earlier version failed

The page's track metadata was being read from the wrong DOM node (`YouTube Music` instead of the actual song), so the lyric lookup searched for garbage. Metadata now comes from the page's `mediaSession` via main-world injection, and LRCLIB is the primary source.

## Settings

Toolbar icon → source (Auto / LRCLIB / YouTube), size, highlight color, auto-apply, source label.

## Notes

- Coverage depends on LRCLIB's catalogue; songs without synced lyrics keep the original plain view.
- Lyrics are copyrighted — personal use intended.
- No accounts, analytics, or listening-data tracking.
