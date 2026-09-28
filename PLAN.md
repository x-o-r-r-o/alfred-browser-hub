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
- [x] Chromium family: Chrome (stable, Beta, Dev, Canary), Chromium (and ungoogled-chromium, same bundle and folder), Arc, Brave (+ Beta, Nightly), Brave Origin (+ Beta, Nightly), Edge (+ Beta, Dev, Canary), Vivaldi (+ Snapshot), Opera, Opera GX, Opera Air, Dia, Comet, Helium, ChatGPT Atlas, Thorium, Yandex — Bookmarks + AccountBookmarks JSON + History SQLite (copied first)
- [x] Arc: pinned tabs of every space and Favorites from StorableSidebar.json (Arc keeps no bookmarks in Bookmarks), per profile
- [x] Opera: `Default/` profile and side profiles (`_side_profiles/<id>`), older root layout too
- [x] Firefox family: Firefox (+ Developer Edition, Nightly), Zen, LibreWolf, Floorp, Waterfox — places.sqlite with its WAL, full folder paths, tags and `place:` queries left out; Firefox 138+ profile groups (`Profile Groups/<StoreID>.sqlite`) opened with `--profile <folder>`
- [x] Safari: Bookmarks.plist (Favorites, folders, Reading List) and History.db; Safari 17+ profiles’ history (`~/Library/Containers/com.apple.Safari/Data/Library/Safari/Profiles/<UUID>/History.db`, names from SafariTabs.db); no Full Disk Access is detected and explained with a ↩ to the right Settings pane
- [x] Cached index (SQLite in the cache folder, ~80 ms per keystroke at 60k pages) with a detached background refresh; bookmarks refreshed on change, history at most every 3 minutes (or forced)
- [x] Dedupe: one row per page across browsers and profiles; bookmark titles win, visits summed, sources listed
- [x] `@browser` / `@profile` filters with suggestions while typing (`@chrome @work`, `@safari`)
- [x] ↩ open in the source browser and profile (or the default browser, configurable), ⌘↩ the other, ⌥↩ choose a browser or profile, ⌃↩ copy a Markdown link, ⌘C / ⌘L / ⌘Y
- [x] `prof` lists every Chromium and Firefox-family profile with name, account and picture; ↩ opens the browser in that profile, ⌘↩ opens a typed or copied URL in it, ⌥↩ a private window
- [x] `openin` + Universal Action (URLs and text) + Hotkey: open the frontmost browser's current tab, the selected, typed or copied link in any installed browser or profile; ⌘↩ private window
- [x] `browsers`: what's indexed per profile, access problems, Refresh the index, Clear the index
- [x] Open-only browsers (links open in them, data never read): Orion (+ RC), Safari Technology Preview, SigmaOS, DuckDuckGo, Whale, Wavebox, Ghost Browser, Mullvad Browser, Tor Browser
- [x] Every other installed app macOS registers for both http and https (`NSWorkspace URLsForApplicationsToOpenURL`, macOS 12+) is offered by `openin` and listed by `browsers` as open-only (no bookmarks, history or profiles); Alfred and this workflow are never listed. It counts as a web browser only when its Info.plist also opens HTML documents (`public.html`/`public.xhtml`, `.html`, or `text/html` in `CFBundleDocumentTypes` with a role other than None), the other half of what an app declares to be offered as the default browser. Apps that only take links (download managers such as Folx and PullTube) appear only with the “Other apps” checkbox. “Don’t offer” hides apps by name or bundle id. The scan (~3 ms) is cached in `apps.json` for 5 minutes; Refresh and Clear delete it
- [x] Privacy: local only, no network at all; `/usr/bin/sqlite3 -readonly` on temp copies (deleted right after); exclude browsers or single profiles (`Chrome/Work`); history can be turned off; Clear the index deletes every copy

## Tech
- JXA (`osascript -l JavaScript`) with the ObjC bridge; `/usr/bin/sqlite3` (ships with macOS) for the browsers' databases and the index; `/usr/bin/open` with argv for launching.
- No runtime dependencies, no binaries, no network, no secrets.
- Index files in `$alfred_workflow_cache`: `src-<key>.json` per profile, `index.sqlite` (merged, replaced atomically with rename(2)), `state.json`, `stamp`, `gen` (bumped by Clear so a running indexer discards its work), `index.lock` (mkdir lock with dead-owner check, 15 min backstop > 5 min indexer budget).
- Test mode: `BH_TEST_ROOT` replaces the home folder for all browser data and turns off app lookups, AppleScript and `open`; `BH_TEST_URL_APPS` lists fixture `.app` bundles (inside the fixture root) in place of the http/https app scan.

## Known limitations
- Safari needs Full Disk Access for Alfred (Apple protects ~/Library/Safari). Safari profiles are searched separately, but links always open in Safari’s current window: Safari has no command-line or AppleScript way to pick a profile (FB12320895).
- Arc and Opera have no command-line flag for profiles (Opera’s `--profile-directory` is reported to hang it), so `prof` and `openin` offer only the browser itself; their profiles are still searched separately. Arc has no private-window flag.
- Arc’s unpinned tabs aren’t indexed (they’re open tabs, not bookmarks).
- Chrome’s planned encrypted-only bookmarks stage (`EncryptedBookmarks2`, os_crypt) would hide bookmarks; today Chrome still writes the plain files.
- The current tab can be read from Chromium browsers and Safari (asks for Automation permission once); Firefox-family browsers have no scripting, so `openin` falls back to the clipboard there.
- History changes appear after up to about 3 minutes (the history database is copied at most that often), or at once with Refresh the index.
- Firefox's per-page favicons and Chromium's Favicons database aren't used: rows show the browser's icon.

## Verify in real Alfred
- [ ] Full Disk Access: Safari rows appear after granting it to Alfred, and the detached indexer inherits Alfred's permission
- [ ] `open -n -b <bundle> --args --profile-directory=…` opens the right Chrome/Brave/Edge/Vivaldi profile while the browser is running and while it's closed
- [ ] `open -n -b org.mozilla.firefox --args -P <name> <url>` opens the URL in that profile when Firefox is running with the same profile and with another one (Zen, LibreWolf, Floorp too)
- [ ] Private windows: `--incognito` (Chrome, Brave, Vivaldi, Dia, Comet, Helium, Atlas), `--inprivate` (Edge), `--private` (Opera), `-private-window` (Firefox family); Dia’s and Atlas’s flags are unconfirmed
- [ ] A Firefox 138+ profile-group profile opens with `open -n -b org.mozilla.firefox --args --profile <folder> <url>`, both while it’s running and while it’s closed
- [ ] Arc: pinned tabs and Favorites of each profile appear with their space as the folder
- [ ] Safari profile history appears with the profile’s name (with Full Disk Access)
- [ ] Dia’s current tab is read by `openin` (Dia’s own dictionary, `isFocused`)
- [ ] `openin` reads the current tab of Chrome, Arc, Brave, Edge and Safari (Automation prompt), and `menuBarOwningApplication` is the browser behind Alfred's window
- [ ] Session variables `bh_front_url` come back on the next keystroke (no second Automation call while filtering)
- [ ] The Universal Action appears for URLs in Alfred's results and for selected text (checked for a URL passed to Alfred’s `action` command; opens `openin` with the typed link)
- [ ] Rerun "Indexing your browsers…" swaps to results on a fresh install with large histories
- [x] Screenshots: `web`, `@` filter, `prof`, `openin`, the Universal Action, `browsers` (taken with the test fixture; `prof` shows three demo Brave profiles, with the installed Brave Origin.app as the icon source only)
- [x] Paths in NFC everywhere they become keys (source keys, cache folder, fixture root): an NFD path from Alfred no longer leaves `browsers` saying “Not indexed yet” after an index built with the NFC form (checked in real Alfred 2026-09-28)

## Ideas for v1.1
- Open tabs search (Chromium via AppleScript, Safari)
- Favicons from the browsers' own favicon databases
- Delete a history entry (would need writing to browser databases: deliberately left out of v1.0)
- Orion (com.kagi.kagimacOS): `Orion/Defaults/favourites.plist` and the `history` SQLite; profiles are separate apps
- Index Whale, Wavebox, Ghost Browser once their data layouts are confirmed (open-only for now); Sidekick and Island are found by the generic app scan
- Zen Essentials and pinned tabs (`zen-sessions.jsonlz4`, mozLz4: needs an LZ4 decoder in JXA)
- Reuse a profile’s existing window instead of a new one (Raycast #24252; would need UI scripting)
- Open Opera side profiles (`--side-profile-name`, documented only for Windows)
- `-foreground` for Firefox launches, as Mozilla’s own launcher does

## Bug fix: missing browsers (2026-09-28, user report)
- [x] “Browser hub not showing all installed browsers”: Brave Origin (`com.brave.Browser.origin`, `BraveSoftware/Brave-Origin`) wasn't in the table. Added it with its Beta and Nightly (bundle ids and folders from Homebrew's brave-origin casks), Vivaldi Snapshot, Opera Air, Thorium (Alex313031's; not Thorium Reader), Yandex (profile folder from Yandex's help), the open-only browsers above, and the generic scan so an unknown browser is never missing from `openin` again
- [x] Checked on this Mac by listing app bundles only (no browser data read): Brave Origin and Safari found from the table; Folx and PullTube found by the scan as link-only apps and hidden by default
- [ ] Real Alfred: Brave Origin profiles in `prof`/`openin`, `--incognito` and `--profile-directory` with Brave Origin

## Audits (v1.0.0, before release)
- [x] Pass 1: selected text around a link no longer filters every browser away; `localhost` opens as http; leftovers of killed index builds pruned; `@browser @` suggests only that browser's profiles; profiles whose names have no letters get a usable `@` token; Firefox folder recursion depth-limited; long queries capped at 12 words
- [x] Pass 2: no `{}` lookups on names from browser files (`constructor`, `__proto__`); cache files written with umask 077; Hotkey mentioned in the README
- [x] Pass 3: index rows name sources by key, not position (a search between the index swap and the state write can't mislabel); "Clear the index" wins over a running indexer (its copies are deleted); `file://` bookmarks open in a browser, never through LaunchServices (which would launch apps); a failed build still updates the stamp (no respawn per keystroke)
- [x] Alfred runtime: `env -i` suite run, cache path with spaces, quotes and ü, fresh cache folder, config values "1"/"0"/padded/empty/garbage, ~/.sqliterc ignored (`-init /dev/null`), WAL databases without their log
- [x] Performance: ~75–90 ms per keystroke with 60,000 indexed pages (osascript start-up included)
- [x] Independent audit (2026-09-28): bundle id `io.github.x-o-r-r-o.browser-hub`; hard test-mode guard (any `BH_TEST_*` variable without a fixture root inside the temporary folder stops the script before it reads anything; fixture reads can't follow symlinks out); formats checked against upstream sources: Chrome `AccountBookmarks` (Chrome 146+ “Save in Account” leaves `Bookmarks` empty), Arc's StorableSidebar.json, Opera `Default/` and side profiles, Firefox 138+ profile groups, Safari profiles, ChatGPT Atlas's nested data folder; no `--profile-directory` for Arc and Opera; links from browser data with other schemes than http(s) open in the default browser, never through LaunchServices
