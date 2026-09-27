# Browser Hub — Plan

**Bundle ID:** `io.github.x-o-r-r-o.browser-hub` · **Keywords:** `web`, `bmk`, `webh`, `prof`, `openin`, `browsers` (all configurable)

## Why build it
Raycast demand this workflow replaces (downloads, 2026-09-28):

| Raycast extension | Downloads |
|---|---|
| Browser Bookmarks | 66k |
| Zen Browser | 23k |
| Google Chrome Profiles | 15k |
| Mozilla Firefox | 14k |
| Browser History | 11k |
| Open Link in Specific Browser | 5.6k |
| Open Browsers Profiles | small |
| **Total** | **~135k** |

**Alfred today:** separate single-browser workflows (Chrome bookmarks, Firefox bookmarks, Safari history…), no unified search across browsers and profiles, and no "open this link in another profile".

**Raycast complaints to beat** (open issues at raycast/extensions): searching large bookmark sets takes 5–10 s or crashes; "Database is locked" when Chrome is open; Zen missing from Browser History; Comet and Helium missing; no way to open a result in a secondary browser; Firefox profiles not launched correctly.

## Features (v1.0)
- [x] `web` searches bookmarks and history of every browser and profile at once; `bmk` bookmarks only; `webh` history only
- [x] Chromium family: Chrome (stable, Beta, Dev, Canary), Chromium, Arc, Brave (+ Beta, Nightly), Edge (+ Beta, Dev, Canary), Vivaldi, Opera, Opera GX, Dia, Comet, Helium — Bookmarks JSON + History SQLite (copied first)
- [x] Firefox family: Firefox (+ Developer Edition, Nightly), Zen, LibreWolf, Floorp, Waterfox — places.sqlite with its WAL, full folder paths, tags and `place:` queries left out
- [x] Safari: Bookmarks.plist (Favorites, folders, Reading List) and History.db; no Full Disk Access is detected and explained with a ↩ to the right Settings pane
- [x] Cached index (SQLite in the cache folder, ~80 ms per keystroke at 60k pages) with a detached background refresh; bookmarks refreshed on change, history at most every 3 minutes (or forced)
- [x] Dedupe: one row per page across browsers and profiles; bookmark titles win, visits summed, sources listed
- [x] `@browser` / `@profile` filters with suggestions while typing (`@chrome @work`, `@safari`)
- [x] ↩ open in the source browser and profile (or the default browser, configurable), ⌘↩ the other, ⌥↩ choose a browser or profile, ⌃↩ copy a Markdown link, ⌘C / ⌘L / ⌘Y
- [x] `prof` lists every Chromium and Firefox-family profile with name, account and picture; ↩ opens the browser in that profile, ⌘↩ opens a typed or copied URL in it, ⌥↩ a private window
- [x] `openin` + Universal Action (URLs and text) + Hotkey: open the frontmost browser's current tab, the selected, typed or copied link in any installed browser or profile; ⌘↩ private window
- [x] `browsers`: what's indexed per profile, access problems, Refresh the index, Clear the index
- [x] Privacy: local only, no network at all; `/usr/bin/sqlite3 -readonly` on temp copies (deleted right after); exclude browsers or single profiles (`Chrome/Work`); history can be turned off; Clear the index deletes every copy

## Tech
- JXA (`osascript -l JavaScript`) with the ObjC bridge; `/usr/bin/sqlite3` (ships with macOS) for the browsers' databases and the index; `/usr/bin/open` with argv for launching.
- No runtime dependencies, no binaries, no network, no secrets.
- Index files in `$alfred_workflow_cache`: `src-<key>.json` per profile, `index.sqlite` (merged, replaced atomically with rename(2)), `state.json`, `stamp`, `gen` (bumped by Clear so a running indexer discards its work), `index.lock` (mkdir lock with dead-owner check, 15 min backstop > 5 min indexer budget).
- Test mode: `BH_TEST_ROOT` replaces the home folder for all browser data and turns off app lookups, AppleScript and `open`.

## Known limitations
- Safari needs Full Disk Access for Alfred (Apple protects ~/Library/Safari). Safari profiles (Safari 17) aren't separated: Safari's shared Bookmarks.plist and History.db are read.
- Arc's sidebar (pinned tabs and spaces) isn't read; Arc's regular Bookmarks and History are. Arc has no command-line flag for profiles or private windows, so its profiles open in Arc's last-used space.
- The current tab can be read from Chromium browsers and Safari (asks for Automation permission once); Firefox-family browsers have no scripting, so `openin` falls back to the clipboard there.
- History changes appear after up to about 3 minutes (the history database is copied at most that often), or at once with Refresh the index.
- Firefox's per-page favicons and Chromium's Favicons database aren't used: rows show the browser's icon.

## Verify in real Alfred
- [ ] Full Disk Access: Safari rows appear after granting it to Alfred, and the detached indexer inherits Alfred's permission
- [ ] `open -n -b <bundle> --args --profile-directory=…` opens the right Chrome/Brave/Edge/Vivaldi profile while the browser is running and while it's closed
- [ ] `open -n -b org.mozilla.firefox --args -P <name> <url>` opens the URL in that profile when Firefox is running with the same profile and with another one (Zen, LibreWolf, Floorp too)
- [ ] Private windows: `--incognito` (Chrome, Brave, Vivaldi, Dia, Comet, Helium), `--inprivate` (Edge), `--private` (Opera), `-private-window` (Firefox family)
- [ ] `openin` reads the current tab of Chrome, Arc, Brave, Edge and Safari (Automation prompt), and `menuBarOwningApplication` is the browser behind Alfred's window
- [ ] Session variables `bh_front_url` come back on the next keystroke (no second Automation call while filtering)
- [ ] The Universal Action appears for URLs in Alfred's results and for selected text
- [ ] Rerun "Indexing your browsers…" swaps to results on a fresh install with large histories
- [ ] Screenshots: `web`, `@` filter, `prof`, `openin`, the Universal Action, `browsers`

## Ideas for v1.1
- Arc sidebar (StorableSidebar.json) pinned tabs and spaces as bookmarks
- Open tabs search (Chromium via AppleScript, Safari)
- Favicons from the browsers' own favicon databases
- Safari profiles (per-profile history)
- Delete a history entry (would need writing to browser databases: deliberately left out of v1.0)
- ChatGPT Atlas, Sidekick, Island, Whale, Ghost Browser once their data paths are confirmed

## Audits (v1.0.0, before release)
- [x] Pass 1: selected text around a link no longer filters every browser away; `localhost` opens as http; leftovers of killed index builds pruned; `@browser @` suggests only that browser's profiles; profiles whose names have no letters get a usable `@` token; Firefox folder recursion depth-limited; long queries capped at 12 words
- [x] Pass 2: no `{}` lookups on names from browser files (`constructor`, `__proto__`); cache files written with umask 077; Hotkey mentioned in the README
- [x] Pass 3: index rows name sources by key, not position (a search between the index swap and the state write can't mislabel); "Clear the index" wins over a running indexer (its copies are deleted); `file://` bookmarks open in a browser, never through LaunchServices (which would launch apps); a failed build still updates the stamp (no respawn per keystroke)
- [x] Alfred runtime: `env -i` suite run, cache path with spaces, quotes and ü, fresh cache folder, config values "1"/"0"/padded/empty/garbage, ~/.sqliterc ignored (`-init /dev/null`), WAL databases without their log
- [x] Performance: ~75–90 ms per keystroke with 60,000 indexed pages (osascript start-up included)
