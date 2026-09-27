#!/usr/bin/osascript -l JavaScript
// Browser Hub for Alfred: bookmarks and history of every browser and profile, profiles, and "open in".
// Usage: osascript -l JavaScript browserhub.js <command> [query]
//   web | bmk | hist | prof | openin | browsers   Script Filters
//   action <arg>                                 run $bh_action (open, launch, copy…)
//   index [force]                                refresh the index (background, detached)
// Everything stays on this Mac: browser databases are copied to the workflow's cache folder and
// read there with /usr/bin/sqlite3 in read-only mode; nothing is ever sent anywhere.
ObjC.import("Foundation");
ObjC.import("AppKit");

const ENV = $.NSProcessInfo.processInfo.environment;
function env(name, fallback) {
  const v = ENV.objectForKey(name);
  return v.isNil() ? fallback : v.js;
}
const FM = $.NSFileManager.defaultManager;
const BUNDLE = "io.github.x-o-r-r-o.browser-hub";
const PID = $.NSProcessInfo.processInfo.processIdentifier;
// Tests point BH_TEST_ROOT at a fixture tree: browser data is then read only from there, no real
// app is detected or scripted, and nothing is opened (see isTest()).
const TEST_ROOT = env("BH_TEST_ROOT", "");
const ROOT = TEST_ROOT || $.NSHomeDirectory().js;
function isTest() {
  return TEST_ROOT !== "";
}
// Symlinks resolved, "//", "." and ".." collapsed ("/private" is dropped the same way on both sides)
// (a path in an unreadable folder isn't resolved, and keeps its "/private": dropped here too)
function resolved(p) {
  return normPath($(String(p)).stringByResolvingSymlinksInPath.js).replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, "");
}
function inside(p, dir) {
  const n = resolved(p), d = resolved(dir);
  return n === d || n.startsWith(d === "/" ? "/" : d + "/");
}
// Hard test-mode guard: a test run (any BH_TEST_* variable) must have a fixture root that is a
// folder inside the temporary folder, away from the home folder. Otherwise the script stops before
// reading anything, so a test that forgets an override can never reach the real browser data.
function testGuardError() {
  const keys = ObjC.deepUnwrap(ENV.allKeys) || [];
  const testRun = keys.some((k) => /^BH_TEST_/.test(k));
  if (!testRun && !isTest()) return "";
  if (!TEST_ROOT) return "Test mode without BH_TEST_ROOT";
  const home = $.NSHomeDirectoryForUser($.NSUserName()).js;
  const temps = [$.NSTemporaryDirectory().js, env("TMPDIR", ""), "/tmp", "/private/tmp"].filter(Boolean);
  if (!temps.some((t) => inside(TEST_ROOT, t) && resolved(TEST_ROOT) !== resolved(t))) return "BH_TEST_ROOT isn’t inside the temporary folder";
  if (inside(home, TEST_ROOT) || inside(TEST_ROOT, home)) return "BH_TEST_ROOT overlaps the home folder";
  if (!isDir(TEST_ROOT)) return "BH_TEST_ROOT isn’t a folder";
  return "";
}

const INDEX_VERSION = 2;
const MAX_ROWS = 50;
const REFRESH_AFTER = 60; // seconds: an older index is checked for changes in the background
const HISTORY_MIN_AGE = 180; // seconds: a changed history database is copied at most this often
const INDEX_TIMEOUT = 300; // seconds: the indexer stops reading more sources after this
const INDEX_STALE = 900; // seconds: lock backstop, longer than INDEX_TIMEOUT (the owner's PID is checked first)
const MAX_BOOKMARKS = 100000; // per source
const MAX_URL = 4096;
const MAX_TITLE = 300;

// ---------- browsers ----------
// dir: data folder relative to the home folder. private: the flag for a private window.

const AS = "Library/Application Support/";
const BROWSERS = [
  { id: "chrome", name: "Google Chrome", short: "Chrome", family: "chromium", bundles: ["com.google.Chrome"], dir: AS + "Google/Chrome", private: "--incognito" },
  { id: "chromebeta", name: "Google Chrome Beta", short: "Chrome Beta", family: "chromium", bundles: ["com.google.Chrome.beta"], dir: AS + "Google/Chrome Beta", private: "--incognito" },
  { id: "chromedev", name: "Google Chrome Dev", short: "Chrome Dev", family: "chromium", bundles: ["com.google.Chrome.dev"], dir: AS + "Google/Chrome Dev", private: "--incognito" },
  { id: "chromecanary", name: "Google Chrome Canary", short: "Chrome Canary", family: "chromium", bundles: ["com.google.Chrome.canary"], dir: AS + "Google/Chrome Canary", private: "--incognito" },
  { id: "chromium", name: "Chromium", short: "Chromium", family: "chromium", bundles: ["org.chromium.Chromium"], dir: AS + "Chromium", private: "--incognito" },
  { id: "arc", name: "Arc", short: "Arc", family: "chromium", bundles: ["company.thebrowser.Browser"], dir: AS + "Arc/User Data", private: null },
  { id: "brave", name: "Brave Browser", short: "Brave", family: "chromium", bundles: ["com.brave.Browser"], dir: AS + "BraveSoftware/Brave-Browser", private: "--incognito" },
  { id: "bravebeta", name: "Brave Browser Beta", short: "Brave Beta", family: "chromium", bundles: ["com.brave.Browser.beta"], dir: AS + "BraveSoftware/Brave-Browser-Beta", private: "--incognito" },
  { id: "bravenightly", name: "Brave Browser Nightly", short: "Brave Nightly", family: "chromium", bundles: ["com.brave.Browser.nightly"], dir: AS + "BraveSoftware/Brave-Browser-Nightly", private: "--incognito" },
  { id: "edge", name: "Microsoft Edge", short: "Edge", family: "chromium", bundles: ["com.microsoft.edgemac"], dir: AS + "Microsoft Edge", private: "--inprivate" },
  { id: "edgebeta", name: "Microsoft Edge Beta", short: "Edge Beta", family: "chromium", bundles: ["com.microsoft.edgemac.Beta"], dir: AS + "Microsoft Edge Beta", private: "--inprivate" },
  { id: "edgedev", name: "Microsoft Edge Dev", short: "Edge Dev", family: "chromium", bundles: ["com.microsoft.edgemac.Dev"], dir: AS + "Microsoft Edge Dev", private: "--inprivate" },
  { id: "edgecanary", name: "Microsoft Edge Canary", short: "Edge Canary", family: "chromium", bundles: ["com.microsoft.edgemac.Canary"], dir: AS + "Microsoft Edge Canary", private: "--inprivate" },
  { id: "vivaldi", name: "Vivaldi", short: "Vivaldi", family: "chromium", bundles: ["com.vivaldi.Vivaldi"], dir: AS + "Vivaldi", private: "--incognito" },
  { id: "opera", name: "Opera", short: "Opera", family: "chromium", bundles: ["com.operasoftware.Opera"], dir: AS + "com.operasoftware.Opera", private: "--private" },
  { id: "operagx", name: "Opera GX", short: "Opera GX", family: "chromium", bundles: ["com.operasoftware.OperaGX"], dir: AS + "com.operasoftware.OperaGX", private: "--private" },
  { id: "dia", name: "Dia", short: "Dia", family: "chromium", bundles: ["company.thebrowser.dia"], dir: AS + "Dia/User Data", private: "--incognito" },
  { id: "comet", name: "Comet", short: "Comet", family: "chromium", bundles: ["ai.perplexity.comet"], dir: AS + "Comet", private: "--incognito" },
  { id: "helium", name: "Helium", short: "Helium", family: "chromium", bundles: ["net.imput.helium"], dir: AS + "net.imput.helium", private: "--incognito" },
  { id: "firefox", name: "Firefox", short: "Firefox", family: "firefox", bundles: ["org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly"], dir: AS + "Firefox", private: "-private-window" },
  { id: "zen", name: "Zen", short: "Zen", family: "firefox", bundles: ["app.zen-browser.zen"], dir: AS + "zen", private: "-private-window" },
  { id: "librewolf", name: "LibreWolf", short: "LibreWolf", family: "firefox", bundles: ["org.mozilla.librewolf", "io.gitlab.librewolf-community"], dir: AS + "librewolf", private: "-private-window" },
  { id: "floorp", name: "Floorp", short: "Floorp", family: "firefox", bundles: ["one.ablaze.floorp", "org.mozilla.floorp"], dir: AS + "Floorp", private: "-private-window" },
  { id: "waterfox", name: "Waterfox", short: "Waterfox", family: "firefox", bundles: ["net.waterfox.waterfox"], dir: AS + "Waterfox", private: "-private-window" },
  { id: "safari", name: "Safari", short: "Safari", family: "safari", bundles: ["com.apple.Safari"], dir: "Library/Safari", private: null },
];
const BROWSER_BY_ID = new Map(BROWSERS.map((b) => [b.id, b]));
const SQLITE = "/usr/bin/sqlite3";
const FDA_URL = "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles";

// ---------- configuration ----------

function flag(name, fallback) {
  const v = String(env(name, "")).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}
function choice(name, allowed, fallback) {
  const v = String(env(name, "")).trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}
function splitList(s) {
  return String(s || "").split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
}
function config() {
  let limit = parseInt(String(env("history_limit", "")).trim(), 10);
  if (isNaN(limit) || limit < 0) limit = 10000;
  if (limit === 0 || limit > 200000) limit = 200000; // 0 = everything (capped)
  if (limit < 100) limit = 100;
  return {
    excluded: splitList(env("excluded_browsers", "")).map((x) => x.split("/").map(squash).join("/")),
    history: flag("index_history", true),
    historyLimit: limit,
    openWith: choice("open_with", ["source", "default"], "source"),
  };
}
function keyword(name, fallback) {
  const v = String(env(`keyword_${name}`, "")).trim();
  return v || fallback;
}

// ---------- files ----------

function mkdirs(dir) {
  FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  return dir;
}
function cacheDir() {
  return mkdirs(env("alfred_workflow_cache", "") || `${$.NSTemporaryDirectory().js}${BUNDLE}`);
}
function decode(data) {
  if (data.isNil()) return null;
  const s = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  if (!s.isNil()) return s.js;
  // invalid UTF-8 (a truncated title in a database): decode it here, replacing only the bad bytes
  const bytes = $.NSString.alloc.initWithDataEncoding(data, $.NSISOLatin1StringEncoding);
  return bytes.isNil() ? null : utf8Lossy(bytes.js);
}
// Latin-1 string (one char per byte) -> UTF-8 decoded, with U+FFFD for invalid sequences
function utf8Lossy(b) {
  let out = "";
  const n = b.length;
  for (let i = 0; i < n; ) {
    const c = b.charCodeAt(i);
    let len = 0, cp = 0, min = 0;
    if (c < 0x80) {
      let j = i + 1;
      while (j < n && b.charCodeAt(j) < 0x80) j++;
      out += b.slice(i, j);
      i = j;
      continue;
    } else if (c >= 0xc2 && c <= 0xdf) { len = 1; cp = c & 0x1f; min = 0x80; }
    else if (c >= 0xe0 && c <= 0xef) { len = 2; cp = c & 0x0f; min = 0x800; }
    else if (c >= 0xf0 && c <= 0xf4) { len = 3; cp = c & 0x07; min = 0x10000; }
    else {
      out += "\uFFFD";
      i++;
      continue;
    }
    let ok = i + len < n;
    for (let k = 1; ok && k <= len; k++) {
      const d = b.charCodeAt(i + k);
      if ((d & 0xc0) !== 0x80) ok = false;
      else cp = (cp << 6) | (d & 0x3f);
    }
    if (!ok || cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      out += "\uFFFD";
      i++;
      continue;
    }
    out += String.fromCodePoint(cp);
    i += len + 1;
  }
  return out;
}
function readFile(path) {
  return decode($.NSData.dataWithContentsOfFile(path));
}
function writeFile(path, text) {
  return $(text).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, $());
}
function readJSON(path) {
  const s = readFile(path);
  if (s === null) return null;
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}
function exists(path) {
  return FM.fileExistsAtPath(path);
}
function isDir(path) {
  const d = Ref();
  return FM.fileExistsAtPathIsDirectory(path, d) && !!d[0];
}
function stat(path) {
  const a = FM.attributesOfItemAtPathError(path, $());
  if (a.isNil()) return null;
  const d = a.objectForKey($.NSFileModificationDate);
  return { mtime: d.isNil() ? 0 : d.timeIntervalSince1970, size: Number(a.objectForKey($.NSFileSize).js) || 0 };
}
function mtime(path) {
  const s = stat(path);
  return s ? s.mtime : 0;
}
function removeFile(path) {
  FM.removeItemAtPathError(path, $());
}
function listDir(dir) {
  const names = FM.contentsOfDirectoryAtPathError(dir, $());
  return names.isNil() ? [] : ObjC.deepUnwrap(names);
}
function now() {
  const t = isTest() ? env("BH_TEST_NOW", "") : "";
  if (t && !isNaN(Number(t))) return Number(t);
  return Date.now() / 1000;
}
function basename(p) {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}
// Is this a sandbox-safe path for the current mode? In test mode nothing outside the fixture root
// is ever read (a profiles.ini may point anywhere).
function allowedPath(p) {
  if (!isTest()) return true;
  return inside(p, TEST_ROOT); // symlinks resolved: a fixture link can't lead out of the root
}
// "//", "." and ".." collapsed (stringByStandardizingPath would also drop "/private")
function normPath(p) {
  const out = [];
  for (const part of String(p).split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return "/" + out.join("/");
}
// Was an NSError caused by missing permission (Full Disk Access, or file modes)?
// (NSError out-parameters are passed as $(): a Ref() crashes osascript when an error is set; only
// read it after the call failed)
function permissionError(err) {
  if (!err || err.isNil()) return false;
  let dom, code;
  try {
    dom = err.domain.js;
    code = Number(err.code);
  } catch (e) {
    return false;
  }
  if (dom === "NSCocoaErrorDomain" && (code === 257 || code === 513)) return true;
  if (dom === "NSPOSIXErrorDomain" && (code === 1 || code === 13)) return true;
  const u = err.userInfo.objectForKey("NSUnderlyingError");
  return !u.isNil() && u.domain.js === "NSPOSIXErrorDomain" && (Number(u.code) === 1 || Number(u.code) === 13);
}

// ---------- processes and locks ----------

ObjC.bindFunction("kill", ["int", ["int", "int"]]);
ObjC.bindFunction("setsid", ["int", []]);
ObjC.bindFunction("rename", ["int", ["char *", "char *"]]);
ObjC.bindFunction("umask", ["unsigned short", ["unsigned short"]]);
// Everything this workflow writes (copies of browsing data) is readable by this user only
$.umask(0o077);

// Run a program with argv (never through a shell with interpolated data).
function runTask(path, args, opts = {}) {
  const task = $.NSTask.alloc.init;
  task.executableURL = $.NSURL.fileURLWithPath(path);
  task.arguments = args;
  if (opts.env) {
    const e = $.NSMutableDictionary.dictionaryWithDictionary(ENV);
    for (const k of Object.keys(opts.env)) e.setObjectForKey(opts.env[k], k);
    task.environment = e;
  }
  const outP = $.NSPipe.pipe, errP = $.NSPipe.pipe;
  task.standardInput = opts.stdinFile ? $.NSFileHandle.fileHandleForReadingAtPath(opts.stdinFile) : $.NSFileHandle.fileHandleWithNullDevice;
  task.standardOutput = outP;
  task.standardError = opts.stderr ? errP : $.NSFileHandle.fileHandleWithNullDevice;
  if (!task.launchAndReturnError($())) return { status: -1, stdout: "", stderr: "couldn’t start " + basename(path) };
  if (opts.timeout) {
    // Apple events to a hung app would otherwise block for two minutes
    const end = Date.now() + opts.timeout * 1000;
    while (task.running && Date.now() < end) $.NSThread.sleepForTimeInterval(0.02);
    if (task.running) {
      task.terminate;
      return { status: -2, stdout: "", stderr: "timed out" };
    }
  }
  const out = outP.fileHandleForReading.readDataToEndOfFile;
  const err = opts.stderr ? errP.fileHandleForReading.readDataToEndOfFile : null;
  task.waitUntilExit;
  return { status: task.terminationStatus, stdout: decode(out) || "", stderr: err ? decode(err) || "" : "" };
}

// Start `browserhub.js index` detached: `set -m` gives it its own process group, so it survives
// Alfred ending the Script Filter while you type.
function spawnIndexer(force) {
  if (env("BH_TEST_NO_SPAWN", "") === "1") return 0;
  const r = runTask("/bin/bash", ["-c", 'set -m; nohup /usr/bin/osascript -l JavaScript ./browserhub.js index "$1" </dev/null >/dev/null 2>&1 & echo $!', "bash", force ? "force" : ""]);
  const pid = parseInt(r.stdout.trim(), 10);
  return pid > 0 ? pid : 0;
}
function pidAlive(pid) {
  if (!(pid > 0) || $.kill(pid, 0) !== 0) return false;
  const r = runTask("/bin/ps", ["-o", "command=", "-p", String(pid)]);
  return r.status === -1 || /browserhub\.js/.test(r.stdout); // PIDs are reused
}
function lockPath(name) {
  return `${cacheDir()}/${name}.lock`;
}
function lockStale(dir, staleSec) {
  const age = now() - mtime(dir);
  if (age > staleSec) return true;
  const pid = parseInt(readFile(`${dir}/pid`) || "", 10);
  if (isNaN(pid)) return age > 5; // just created; the PID is written next
  return !pidAlive(pid);
}
function tryLock(name, staleSec) {
  const dir = lockPath(name);
  const take = () => {
    if (!FM.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, false, $(), $())) return false;
    writeFile(`${dir}/pid`, String(PID));
    return true;
  };
  if (take()) return dir;
  if (exists(dir) && lockStale(dir, staleSec)) {
    removeFile(dir);
    if (take()) return dir;
  }
  return null;
}
function lockHeld(name, staleSec) {
  const dir = lockPath(name);
  return exists(dir) && !lockStale(dir, staleSec);
}
function unlock(dir) {
  const owner = parseInt(readFile(`${dir}/pid`) || "", 10);
  if (owner === PID || !pidAlive(owner)) removeFile(dir);
}

// ---------- text ----------

function fold(s) {
  return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}
// lower case, no accents, no spaces or punctuation: how "@filters" and exclusions are compared
function squash(s) {
  return fold(s).replace(/[^\p{L}\p{N}]+/gu, "");
}
// Control characters and line breaks become spaces; bidi overrides are dropped.
function oneLine(s) {
  return String(s).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]+/g, " ").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}
// Lone surrogates can't be written as UTF-8 (the whole file write would fail)
function wellFormed(s) {
  return String(s).replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (m) => (m.length === 2 ? m : "\uFFFD"));
}
function shorten(s, max) {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : s;
}
function plural(n, one, many) {
  return `${Number(n).toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
// FNV-1a: a short, stable file-name-safe key
function hashKey(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
// Rows need a uid for Alfred to keep the selected row while the Script Filter reruns.
function stableUids(items) {
  items.forEach((it, i) => {
    if (it && !it.uid) it.uid = `${i}|${String(it.title || "").replace(/[0-9]+/g, "#")}`;
  });
  return items;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function shortDate(t) {
  const d = new Date(t * 1000), n = new Date(now() * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === n.getFullYear() ? "" : " " + d.getFullYear()}`;
}
function relativeTime(t) {
  if (!(t > 0)) return "";
  const s = now() - t;
  if (s < -120) return shortDate(t);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return shortDate(t);
}

// ---------- URLs ----------

// Schemes that can't be opened from outside a browser, or aren't pages
const SKIP_SCHEMES = new Set(["javascript", "place", "data", "blob", "about", "chrome", "chrome-extension", "chrome-search", "chrome-untrusted",
  "edge", "brave", "vivaldi", "opera", "arc", "moz-extension", "view-source", "resource", "devtools", "comet", "helium", "dia"]);
function schemeOf(u) {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(u);
  return m ? m[1].toLowerCase() : "";
}
function indexable(u) {
  if (typeof u !== "string" || !u || u.length > MAX_URL || /[\s\x00-\x1f]/.test(u)) return false;
  const s = schemeOf(u);
  return !!s && !SKIP_SCHEMES.has(s);
}
// The same page in different browsers: scheme and host compared without case, "/" alone dropped
function urlKey(u) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/i.exec(u);
  if (!m) return u;
  const rest = m[3] === "/" ? "" : m[3];
  return `${m[1].toLowerCase()}://${m[2].toLowerCase()}${rest}`;
}
function safeDecode(s) {
  try {
    return decodeURI(s);
  } catch (e) {
    return s;
  }
}
// "github.com/user/repo": what's shown and matched (no scheme, no www.)
function displayURL(u) {
  let s = safeDecode(u).replace(/^(https?):\/\//i, "").replace(/^www\./i, "");
  if (/^[^/]+\/$/.test(s)) s = s.slice(0, -1);
  return s;
}
// A URL typed or copied: http(s) and other scheme URLs, or a bare domain like "example.com/x"
function asURL(s) {
  s = String(s || "").trim();
  if (!s || /[\s\x00-\x1f]/.test(s) || s.length > MAX_URL) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(s)) return indexable(s) ? s : "";
  if (/^(mailto|tel):\S+$/i.test(s)) return "";
  if (/^localhost(:\d+)?([/?#]\S*)?$/i.test(s)) return "http://" + s;
  if (/^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)*\.\p{L}{2,}(:\d+)?([/?#]\S*)?$/iu.test(s)) return "https://" + s;
  return "";
}

// ---------- apps ----------

let APPS = null;
// bundle id -> app path, for installed apps only
function appPath(bundle) {
  if (!APPS) {
    APPS = new Map();
    if (isTest()) {
      // BH_TEST_APPS: "bundle=path,bundle=path" (no real app is looked up in tests)
      for (const pair of splitList(env("BH_TEST_APPS", ""))) {
        const i = pair.indexOf("=");
        if (i > 0) APPS.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
      }
    }
  }
  if (APPS.has(bundle)) return APPS.get(bundle);
  let p = "";
  if (!isTest()) {
    const u = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier(bundle);
    p = u.isNil() ? "" : u.path.js;
  }
  APPS.set(bundle, p);
  return p;
}
// The installed bundle of a browser (first of its alternatives), or null
function installed(b) {
  for (const id of b.bundles) {
    const p = appPath(id);
    if (p) return { bundle: id, path: p };
  }
  return null;
}
function defaultBrowserBundle() {
  if (isTest()) return env("BH_TEST_DEFAULT_BROWSER", "");
  const ws = $.NSWorkspace.sharedWorkspace;
  const u = ws.URLForApplicationToOpenURL($.NSURL.URLWithString("https://example.com"));
  if (u.isNil()) return "";
  const b = $.NSBundle.bundleWithURL(u);
  return b.isNil() || b.bundleIdentifier.isNil() ? "" : b.bundleIdentifier.js;
}

// ---------- profiles ----------
// A source is one profile of one browser:
// { key, browser, dir, profileId, name, email, avatar, isDefault, files: { bookmarks, history } }

function chromiumProfiles(b, root) {
  const out = [];
  const ls = allowedPath(root) ? readJSON(`${root}/Local State`) : null;
  const cache = ls && ls.profile && ls.profile.info_cache && typeof ls.profile.info_cache === "object" ? ls.profile.info_cache : {};
  const order = ls && ls.profile && Array.isArray(ls.profile.profiles_order) ? ls.profile.profiles_order.filter((x) => typeof x === "string") : [];
  const dirs = [];
  const add = (d) => {
    if (typeof d !== "string" || !d || d.includes("/") || d === "." || d === ".." || dirs.includes(d)) return;
    if (/^(System Profile|Guest Profile)$/i.test(d)) return;
    if (isDir(`${root}/${d}`)) dirs.push(d);
  };
  order.forEach(add);
  Object.keys(cache).forEach(add);
  // profiles Local State doesn't list (or no Local State at all)
  for (const d of listDir(root).sort()) {
    if (/^(Default|Profile \d+)$/.test(d) && (exists(`${root}/${d}/Bookmarks`) || exists(`${root}/${d}/History`))) add(d);
  }
  dirs.sort((x, y) => (x === "Default" ? -1 : y === "Default" ? 1 : 0));
  for (const d of dirs) {
    const pdir = `${root}/${d}`;
    const info = Object.prototype.hasOwnProperty.call(cache, d) && cache[d] && typeof cache[d] === "object" ? cache[d] : {};
    const avatar = ["Google Profile Picture.png", "Edge Profile Picture.png"].map((f) => `${pdir}/${f}`).find(exists) || "";
    out.push({
      browser: b, dir: pdir, profileId: d,
      name: typeof info.name === "string" && info.name.trim() ? info.name.trim() : d === "Default" ? "Default" : d,
      email: typeof info.user_name === "string" ? info.user_name : "",
      avatar, isDefault: d === "Default",
      files: { bookmarks: `${pdir}/Bookmarks`, history: `${pdir}/History` },
    });
  }
  // Opera keeps its only profile in the data folder itself
  if (!out.length && (exists(`${root}/Bookmarks`) || exists(`${root}/History`))) {
    out.push({ browser: b, dir: root, profileId: "", name: "Default", email: "", avatar: "", isDefault: true,
      files: { bookmarks: `${root}/Bookmarks`, history: `${root}/History` } });
  }
  return out;
}

function parseINI(text) {
  const sections = [];
  let cur = null;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const m = /^\[(.+)\]$/.exec(line);
    if (m) {
      cur = { name: m[1], values: Object.create(null) };
      sections.push(cur);
    } else if (cur) {
      const i = line.indexOf("=");
      if (i > 0) cur.values[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return sections;
}

function firefoxProfiles(b, root) {
  const out = [];
  const secs = allowedPath(root) ? parseINI(readFile(`${root}/profiles.ini`)) : [];
  const installDefaults = new Set(secs.filter((s) => /^Install/i.test(s.name) && s.values.Default).map((s) => s.values.Default));
  const profs = secs.filter((s) => /^Profile\d+$/i.test(s.name) && s.values.Path);
  const anyInstall = installDefaults.size > 0;
  for (const s of profs) {
    const rel = s.values.IsRelative !== "0";
    const path = rel ? `${root}/${s.values.Path}` : s.values.Path;
    if (!path.startsWith("/") || !allowedPath(path) || !isDir(path)) continue;
    out.push({
      browser: b, dir: path, profileId: s.values.Name || basename(path),
      name: s.values.Name || basename(path), email: "", avatar: "",
      isDefault: anyInstall ? installDefaults.has(s.values.Path) : s.values.Default === "1",
      files: { bookmarks: `${path}/places.sqlite`, history: `${path}/places.sqlite` },
    });
  }
  out.sort((x, y) => (y.isDefault ? 1 : 0) - (x.isDefault ? 1 : 0));
  return out;
}

let DISCOVERED = null;
// Every profile of every browser with data on this Mac
function discover() {
  if (DISCOVERED) return DISCOVERED;
  const out = [];
  for (const b of BROWSERS) {
    const root = `${ROOT}/${b.dir}`;
    if (!allowedPath(root) || !isDir(root)) continue;
    let list = [];
    if (b.family === "chromium") list = chromiumProfiles(b, root);
    else if (b.family === "firefox") list = firefoxProfiles(b, root);
    else list = [{ browser: b, dir: root, profileId: "", name: "Safari", email: "", avatar: "", isDefault: true,
      files: { bookmarks: `${root}/Bookmarks.plist`, history: `${root}/History.db` } }];
    for (const s of list) {
      s.key = hashKey(`${b.id}\u0000${s.dir}`);
      out.push(s);
    }
  }
  const counts = new Map();
  for (const s of out) counts.set(s.browser.id, (counts.get(s.browser.id) || 0) + 1);
  for (const s of out) s.multi = counts.get(s.browser.id) > 1;
  DISCOVERED = out;
  return out;
}
// "Chrome" or "Chrome (Work)" when the browser has several profiles
function sourceLabel(s) {
  return s.multi ? `${s.short || s.browser.short} (${s.name})` : s.short || s.browser.short;
}
// Excluded in the Workflow's Configuration: "Safari", "chrome", or "Chrome/Work" for one profile
function isExcluded(browserId, profileName, cfg) {
  const b = BROWSER_BY_ID.get(browserId);
  const names = b ? [b.id, squash(b.name), squash(b.short)] : [browserId];
  const p = squash(profileName || "");
  for (const e of cfg.excluded) {
    if (!e) continue;
    const i = e.indexOf("/");
    if (i < 0) {
      if (names.includes(e)) return true;
    } else if (names.includes(e.slice(0, i)) && e.slice(i + 1) === p) return true;
  }
  return false;
}

// ---------- reading browser data ----------

let TMP_N = 0;
let TMP_DIRS = [];
function tmpDir() {
  const d = mkdirs(`${cacheDir()}/tmp-${PID}-${++TMP_N}`);
  TMP_DIRS.push(d);
  return d;
}
function cleanTmp() {
  for (const d of TMP_DIRS) removeFile(d);
  TMP_DIRS = [];
}
// Copies left behind by a killed indexer
function pruneTmp() {
  for (const name of listDir(cacheDir())) {
    const m = /^(?:tmp-(\d+)-\d+|index\.tmp-(\d+)\.(?:sql|sqlite))$/.exec(name);
    if (m && Number(m[1] || m[2]) !== PID && now() - mtime(`${cacheDir()}/${name}`) > 600) removeFile(`${cacheDir()}/${name}`);
  }
}

// Can the folder be listed? Not without Full Disk Access for ~/Library/Safari.
function folderBlocked(dir) {
  const err = $();
  const r = FM.contentsOfDirectoryAtPathError(dir, err);
  return r.isNil() && (permissionError(err) || !FM.isReadableFileAtPath(dir));
}

// Copy a database (and its write-ahead log) so the browser's lock doesn't matter.
// Returns { path } or { error: "noaccess" | "missing" | message }
function copyDB(path) {
  if (!allowedPath(path)) return { error: "missing" };
  if (!exists(path)) {
    // exists() is false for an unreadable folder too: check the folder
    return { error: folderBlocked(path.slice(0, path.lastIndexOf("/"))) ? "noaccess" : "missing" };
  }
  const dir = tmpDir();
  const dest = `${dir}/${basename(path)}`;
  const err = $();
  if (!FM.copyItemAtPathToPathError(path, dest, err)) return { error: permissionError(err) ? "noaccess" : "Couldn’t copy the database" };
  // A WAL database without its log (the browser is closed) can't be opened read-only unless the
  // log exists: an empty one is valid, and is ignored for other journal modes
  if (!exists(`${path}-wal`) || !FM.copyItemAtPathToPathError(`${path}-wal`, `${dest}-wal`, $())) writeFile(`${dest}-wal`, "");
  return { path: dest };
}
// Read-only query on a copy; "-init /dev/null" keeps a ~/.sqliterc from changing the output
function sqlJSON(db, sql) {
  const r = runTask(SQLITE, ["-init", "/dev/null", "-readonly", "-bail", "-json", db, sql], { stderr: true });
  if (r.status !== 0) return { error: oneLine(r.stderr.replace(/^Error:\s*/i, "")).trim() || "sqlite3 failed" };
  const out = r.stdout.trim();
  if (!out) return { rows: [] };
  try {
    return { rows: JSON.parse(out) };
  } catch (e) {
    return { error: "Unexpected database output" };
  }
}
function num(x) {
  const n = Number(x);
  return isFinite(n) ? n : 0;
}
function row(url, title, kind, folder, visits, last) {
  return [url, shorten(oneLine(title || "").trim(), MAX_TITLE), kind, oneLine(folder || "").trim(), Math.max(0, Math.floor(num(visits))), Math.max(0, Math.floor(num(last)))];
}

function chromiumBookmarks(path) {
  if (!allowedPath(path) || !exists(path)) return { rows: [] };
  const data = $.NSData.dataWithContentsOfFileOptionsError(path, 0, $());
  if (data.isNil()) return { error: FM.isReadableFileAtPath(path) ? "Couldn’t read the bookmarks" : "noaccess" };
  let j;
  try {
    j = JSON.parse(decode(data) || "");
  } catch (e) {
    return { error: "Couldn’t read the bookmarks file" };
  }
  const rows = [];
  const NAMES = new Map([["bookmark_bar", "Bookmarks Bar"], ["other", "Other Bookmarks"], ["synced", "Mobile Bookmarks"]]);
  const walk = (node, folder, depth) => {
    if (!node || typeof node !== "object" || depth > 64 || rows.length >= MAX_BOOKMARKS) return;
    if (node.type === "url") {
      if (indexable(node.url)) rows.push(row(node.url, typeof node.name === "string" ? node.name : "", "b", folder, 0, 0));
      return;
    }
    if (Array.isArray(node.children)) {
      const name = depth > 0 && typeof node.name === "string" ? node.name : "";
      const sub = name ? (folder ? `${folder}/${name}` : name) : folder;
      for (const c of node.children) walk(c, sub, depth + 1);
    }
  };
  const roots = j && typeof j.roots === "object" && j.roots ? j.roots : {};
  for (const k of Object.keys(roots)) {
    const r = roots[k];
    if (!r || typeof r !== "object" || !Array.isArray(r.children)) continue;
    const name = typeof r.name === "string" && r.name ? r.name : NAMES.get(k) || k;
    for (const c of r.children) walk(c, name, 1);
  }
  return { rows };
}

// Chromium time: microseconds since 1601-01-01
const CHROME_SQL = (limit) => `SELECT url AS u, title AS t, visit_count AS v, last_visit_time AS l FROM urls WHERE hidden = 0 AND last_visit_time > 0 ORDER BY last_visit_time DESC LIMIT ${limit}`;
function chromiumHistory(path, limit) {
  const c = copyDB(path);
  if (c.error) return c.error === "missing" ? { rows: [] } : c;
  const r = sqlJSON(c.path, CHROME_SQL(limit));
  if (r.error) return r;
  const rows = [];
  for (const x of r.rows) if (indexable(x.u)) rows.push(row(x.u, x.t, "h", "", x.v, num(x.l) / 1e6 - 11644473600));
  return { rows };
}

// Firefox (and Zen, LibreWolf, Floorp…): bookmarks and history both live in places.sqlite
const FF_ROOTS = "CASE guid WHEN 'toolbar_____' THEN 'Bookmarks Toolbar' WHEN 'menu________' THEN 'Bookmarks Menu' WHEN 'unfiled_____' THEN 'Other Bookmarks' WHEN 'mobile______' THEN 'Mobile Bookmarks' ELSE coalesce(title, '') END";
// (depth-limited: a damaged database with a folder loop can't make it run forever)
const FF_BOOKMARKS_SQL = `WITH RECURSIVE tree(id, path, depth) AS (
  SELECT id, ${FF_ROOTS}, 0 FROM moz_bookmarks WHERE parent = (SELECT id FROM moz_bookmarks WHERE guid = 'root________') AND guid <> 'tags________'
  UNION ALL SELECT b.id, tree.path || '/' || coalesce(b.title, ''), tree.depth + 1 FROM moz_bookmarks b JOIN tree ON b.parent = tree.id WHERE b.type = 2 AND tree.depth < 32)
SELECT p.url AS u, b.title AS t, tree.path AS f, p.visit_count AS v, p.last_visit_date AS l
FROM moz_bookmarks b JOIN tree ON b.parent = tree.id JOIN moz_places p ON p.id = b.fk WHERE b.type = 1 LIMIT ${MAX_BOOKMARKS}`;
const FF_HISTORY_SQL = (limit) => `SELECT url AS u, title AS t, visit_count AS v, last_visit_date AS l FROM moz_places WHERE hidden = 0 AND visit_count > 0 AND last_visit_date IS NOT NULL ORDER BY last_visit_date DESC LIMIT ${limit}`;
function firefoxPlaces(path, limit, wantHistory) {
  const c = copyDB(path);
  if (c.error) return c.error === "missing" ? { b: [], h: [] } : { error: c.error };
  const bm = sqlJSON(c.path, FF_BOOKMARKS_SQL);
  if (bm.error) return bm;
  const b = [];
  for (const x of bm.rows) if (indexable(x.u)) b.push(row(x.u, x.t, "b", x.f, x.v, num(x.l) / 1e6));
  const h = [];
  if (wantHistory) {
    const hs = sqlJSON(c.path, FF_HISTORY_SQL(limit));
    if (hs.error) return hs;
    for (const x of hs.rows) if (indexable(x.u)) h.push(row(x.u, x.t, "h", "", x.v, num(x.l) / 1e6));
  }
  return { b, h };
}

// Safari needs Full Disk Access (for Alfred) to read ~/Library/Safari
function safariBookmarks(path) {
  if (!allowedPath(path)) return { rows: [] };
  const dir = path.slice(0, path.lastIndexOf("/"));
  const err = $();
  const d = $.NSDictionary.dictionaryWithContentsOfURLError($.NSURL.fileURLWithPath(path), err);
  if (d.isNil()) {
    if (permissionError(err) || folderBlocked(dir)) return { error: "noaccess" };
    if (!exists(path)) return { rows: [] };
    return { error: "Couldn’t read Safari’s bookmarks" };
  }
  const rows = [];
  const NAMES = new Map([["BookmarksBar", "Favorites"], ["BookmarksMenu", "Bookmarks Menu"], ["com.apple.ReadingList", "Reading List"]]);
  const walk = (node, folder, depth) => {
    if (!node || typeof node !== "object" || depth > 64 || rows.length >= MAX_BOOKMARKS) return;
    const t = node.WebBookmarkType;
    if (t === "WebBookmarkTypeLeaf") {
      const u = node.URLString;
      const title = node.URIDictionary && typeof node.URIDictionary.title === "string" ? node.URIDictionary.title : "";
      if (indexable(u)) rows.push(row(u, title, "b", folder, 0, 0));
    } else if (t === "WebBookmarkTypeList" && Array.isArray(node.Children)) {
      let name = typeof node.Title === "string" ? node.Title : "";
      name = NAMES.get(name) || name;
      const sub = depth === 0 ? "" : folder ? `${folder}/${name}` : name;
      for (const c of node.Children) walk(c, sub, depth + 1);
    }
  };
  walk(ObjC.deepUnwrap(d), "", 0);
  return { rows };
}
// Safari time: seconds since 2001-01-01
const SAFARI_SQL = (limit) => `SELECT i.url AS u, v.title AS t, i.visit_count AS c, max(v.visit_time) AS l FROM history_items i JOIN history_visits v ON v.history_item = i.id GROUP BY i.id ORDER BY l DESC LIMIT ${limit}`;
function safariHistory(path, limit) {
  const c = copyDB(path);
  if (c.error) return c.error === "missing" ? { rows: [] } : c;
  const r = sqlJSON(c.path, SAFARI_SQL(limit));
  if (r.error) return r;
  const rows = [];
  for (const x of r.rows) if (indexable(x.u)) rows.push(row(x.u, x.t, "h", "", x.c, num(x.l) + 978307200));
  return { rows };
}

// ---------- the index ----------
// src-<key>.json   one source's rows: { v, key, b: part, h: part }, part = { sig, at, limit, status, rows }
// index.sqlite     every source merged, one row per page (see buildDB)
// state.json       { v, built, gen, history, sources: [{ key, browser, name, … counts, status }] }
// stamp            touched after every check (its mtime tells when the index was last checked)
// gen              bumped by "Clear the index": an indexer started before discards its work

function srcPath(key) {
  return `${cacheDir()}/src-${key}.json`;
}
function statePath() {
  return `${cacheDir()}/state.json`;
}
function dbPath() {
  return `${cacheDir()}/index.sqlite`;
}
function stampPath() {
  return `${cacheDir()}/stamp`;
}
function genValue() {
  return readFile(`${cacheDir()}/gen`) || "0";
}
function loadState() {
  const j = readJSON(statePath());
  return j && j.v === INDEX_VERSION && Array.isArray(j.sources) && exists(dbPath()) ? j : null;
}
function touch(path) {
  writeFile(path, String(now()));
}
function signature(paths) {
  return paths.map((p) => {
    const s = stat(p);
    return s ? `${s.mtime}:${s.size}` : "-";
  }).join("|");
}

function sqlStr(s) {
  return "'" + wellFormed(String(s)).replace(/\u0000/g, "").replace(/'/g, "''") + "'";
}
function titleFold(s) {
  return fold(s).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

// Merge every source into one row per page and write index.sqlite (atomically, by rename)
function buildDB(sources, parts, gen0) {
  const pages = new Map();
  // rows name their sources by key ("|b1a2b3c4d|h…|"), never by position: a search that reads a
  // state.json from just before or after this build still labels and opens them correctly
  sources.forEach((s) => {
    const idx = s.key;
    const p = parts.get(s.key);
    for (const kind of ["b", "h"]) {
      const part = p && p[kind];
      if (!part || !Array.isArray(part.rows)) continue;
      for (const r of part.rows) {
        const [url, title, , folder, visits, last] = r;
        const k = urlKey(url);
        let e = pages.get(k);
        if (!e) {
          e = { url, tb: "", th: "", thAt: -1, folder: "", srcs: [], vis: new Map(), last: 0 };
          pages.set(k, e);
        }
        const tag = `${kind}${idx}`;
        if (!e.srcs.includes(tag)) e.srcs.push(tag);
        if (kind === "b") {
          if (!e.tb && title) e.tb = title;
          if (!e.folder && folder) e.folder = folder;
          if (!e.hasB) {
            e.url = url; // a bookmark's URL is what the user saved
            e.hasB = true;
          }
        } else if (title && last > e.thAt) {
          e.th = title;
          e.thAt = last;
        }
        e.vis.set(idx, Math.max(e.vis.get(idx) || 0, visits));
        if (last > e.last) e.last = last;
      }
    }
  });
  const lines = ["PRAGMA journal_mode = OFF;", "PRAGMA synchronous = OFF;", "BEGIN;",
    "CREATE TABLE items(url TEXT, title TEXT, folder TEXT, srcs TEXT, bm INTEGER, visits INTEGER, last INTEGER, tf TEXT, uf TEXT, ff TEXT);"];
  for (const e of pages.values()) {
    const title = e.tb || e.th;
    let visits = 0;
    for (const v of e.vis.values()) visits += v;
    const bm = e.hasB ? 1 : 0;
    lines.push(`INSERT INTO items VALUES(${sqlStr(e.url)},${sqlStr(title)},${sqlStr(e.folder)},${sqlStr("|" + e.srcs.join("|") + "|")},${bm},${visits},${e.last},` +
      `${sqlStr(titleFold(title))},${sqlStr(fold(displayURL(e.url)))},${sqlStr(titleFold(e.folder))});`);
  }
  lines.push("CREATE INDEX items_last ON items(last);", "COMMIT;");
  const tmp = `${cacheDir()}/index.tmp-${PID}.sqlite`;
  const sqlFile = `${cacheDir()}/index.tmp-${PID}.sql`;
  removeFile(tmp);
  if (!writeFile(sqlFile, lines.join("\n") + "\n")) return false;
  const r = runTask(SQLITE, ["-init", "/dev/null", "-bail", tmp], { stdinFile: sqlFile, stderr: true });
  removeFile(sqlFile);
  if (r.status !== 0 || genValue() !== gen0) {
    removeFile(tmp);
    return false;
  }
  // rename(2) replaces the old index atomically: a search running meanwhile reads one or the other
  if ($.rename(tmp, dbPath()) === 0) return true;
  removeFile(tmp);
  return false;
}

function loadPart(key) {
  const j = readJSON(srcPath(key));
  return j && j.v === INDEX_VERSION && j.key === key ? j : { v: INDEX_VERSION, key };
}

// Refresh the sources that changed, then rebuild index.sqlite when anything did
function refreshIndex(force) {
  const start = now();
  const gen0 = genValue();
  const cfg = config();
  const all = discover();
  const sources = all.filter((s) => !isExcluded(s.browser.id, s.name, cfg));
  const keep = new Set(sources.map((s) => s.key));
  // excluded and removed profiles: delete their copies
  for (const name of listDir(cacheDir())) {
    const m = /^src-([0-9a-f]{8})\.json$/.exec(name);
    if (m && !keep.has(m[1])) removeFile(`${cacheDir()}/${name}`);
  }
  pruneTmp();
  const prev = readJSON(statePath());
  let changed = !prev || prev.v !== INDEX_VERSION || !exists(dbPath()) || prev.history !== cfg.history ||
    JSON.stringify((prev.sources || []).map((s) => s.key)) !== JSON.stringify(sources.map((s) => s.key));
  const parts = new Map();
  const written = [];
  // "Clear the index" ran meanwhile: remove what this run wrote, so no copy survives it
  const cleared = () => {
    if (genValue() === gen0) return false;
    for (const k of written) removeFile(srcPath(k));
    return true;
  };
  for (const s of sources) {
    const p = loadPart(s.key);
    let dirty = false;
    const timedOut = now() - start > INDEX_TIMEOUT;
    const fam = s.browser.family;
    const hFiles = [s.files.history, `${s.files.history}-wal`];
    const bFiles = fam === "firefox" ? hFiles : [s.files.bookmarks];
    const needs = (part, files, throttle, limit) => {
      if (!part) return true;
      if (part.limit !== limit) return true;
      if (part.sig === signature(files)) return false;
      return force || !throttle || now() - (part.at || 0) >= HISTORY_MIN_AGE;
    };
    try {
      if (fam === "firefox") {
        const want = cfg.history ? cfg.historyLimit : 0;
        if (!timedOut && (needs(p.b, bFiles, true, 0) || (cfg.history && needs(p.h, hFiles, true, want)))) {
          const sig = signature(hFiles);
          const r = firefoxPlaces(s.files.history, cfg.historyLimit, cfg.history);
          const status = r.error ? r.error : "ok";
          p.b = { sig, at: now(), limit: 0, status, rows: r.error ? (p.b && p.b.rows) || [] : r.b };
          p.h = cfg.history ? { sig, at: now(), limit: want, status, rows: r.error ? (p.h && p.h.rows) || [] : r.h } : null;
          dirty = true;
        }
      } else {
        if (!timedOut && needs(p.b, bFiles, false, 0)) {
          const sig = signature(bFiles);
          const r = fam === "safari" ? safariBookmarks(s.files.bookmarks) : chromiumBookmarks(s.files.bookmarks);
          p.b = { sig, at: now(), limit: 0, status: r.error ? r.error : "ok", rows: r.error ? (r.error === "noaccess" ? [] : (p.b && p.b.rows) || []) : r.rows };
          dirty = true;
        }
        if (cfg.history && !timedOut && needs(p.h, hFiles, true, cfg.historyLimit)) {
          const sig = signature(hFiles);
          const r = fam === "safari" ? safariHistory(s.files.history, cfg.historyLimit) : chromiumHistory(s.files.history, cfg.historyLimit);
          p.h = { sig, at: now(), limit: cfg.historyLimit, status: r.error ? r.error : "ok", rows: r.error ? (r.error === "noaccess" ? [] : (p.h && p.h.rows) || []) : r.rows };
          dirty = true;
        }
      }
      if (p.b && p.b.status === "noaccess") p.b.rows = [];
      if (p.h && p.h.status === "noaccess") p.h.rows = [];
    } finally {
      cleanTmp();
    }
    if (!cfg.history && p.h) {
      p.h = null;
      dirty = true;
    }
    if (dirty) {
      if (cleared()) return false;
      writeFile(srcPath(s.key), JSON.stringify(p));
      written.push(s.key);
      if (isTest() && env("BH_TEST_CLEAR_DURING", "") === "1") clearIndex();
      changed = true;
    }
    parts.set(s.key, p);
  }
  if (changed) {
    if (!buildDB(sources, parts, gen0)) {
      cleared();
      return false;
    }
    const st = {
      v: INDEX_VERSION, built: now(), history: cfg.history,
      sources: sources.map((s) => {
        const p = parts.get(s.key) || {};
        return {
          key: s.key, browser: s.browser.id, profileId: s.profileId, name: s.name, multi: s.multi,
          b: p.b ? p.b.rows.length : 0, h: p.h ? p.h.rows.length : 0,
          bs: p.b ? p.b.status : "", hs: p.h ? p.h.status : "",
        };
      }),
    };
    if (cleared()) {
      removeFile(dbPath());
      return false;
    }
    writeFile(statePath(), JSON.stringify(st));
  }
  touch(stampPath());
  return true;
}

// Background job
function runIndexer(force) {
  $.setsid();
  const lock = tryLock("index", INDEX_STALE);
  if (!lock) return;
  try {
    refreshIndex(force);
  } catch (e) {
    writeFile(`${cacheDir()}/index-error.txt`, String(e && e.message ? e.message : e));
  } finally {
    cleanTmp();
    // also after a failure: searches retry once a minute, not on every keystroke
    if (exists(statePath())) touch(stampPath());
    unlock(lock);
  }
}

// Delete every copy of browser data this workflow keeps
function clearIndex() {
  writeFile(`${cacheDir()}/gen`, String(Date.now()) + "-" + PID);
  for (const name of listDir(cacheDir())) {
    if (/^(src-[0-9a-f]{8}\.json|index\.sqlite.*|index\.tmp-.*|state\.json|stamp|tmp-\d+-\d+|index-error\.txt)$/.test(name)) removeFile(`${cacheDir()}/${name}`);
  }
}

// The index and its state, starting a background refresh when missing or old.
// Returns { state, building }
function ensureIndex() {
  const state = loadState();
  const stale = !state || now() - mtime(stampPath()) > REFRESH_AFTER;
  let building = false;
  if (stale) {
    building = lockHeld("index", INDEX_STALE);
    if (!building) building = spawnIndexer(false) > 0;
  }
  return { state, building };
}

// ---------- searching ----------

function likeEsc(s) {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}
// Words and @filters of a query. "@chrome @work" = Chrome's Work profile.
function parseQuery(q) {
  const words = [], filters = [];
  for (const t of String(q || "").split(/\s+/).filter(Boolean)) {
    if (t.length > 1 && t.startsWith("@")) filters.push(squash(t.slice(1)));
    else if (t !== "@") {
      const w = titleFold(t) || fold(t);
      if (w) words.push(...w.split(" ").filter(Boolean));
    }
  }
  const last = /(^|\s)@(\S*)$/.exec(String(q || ""));
  const typingFilter = last ? squash(last[2]) : null;
  const finished = filters.slice(0, last && last[2] ? -1 : filters.length).filter(Boolean);
  return { words: [...new Set(words)].slice(0, 12), filters: filters.filter(Boolean), finished, typingFilter };
}
// State sources, enriched with their browser (idx: the key rows use to name them)
function stateSources(state) {
  return state.sources.map((s) => {
    const b = BROWSER_BY_ID.get(s.browser);
    return b && /^[0-9a-f]{8}$/.test(String(s.key)) ? Object.assign({}, s, { idx: s.key, browser: b, short: b.short }) : null;
  }).filter(Boolean);
}
function matchesFilter(s, f) {
  const b = s.browser;
  return b.id.startsWith(f) || squash(b.name).startsWith(f) || squash(b.short).startsWith(f) || profileMatches(s, f);
}
function profileMatches(s, f) {
  return !!s.name && (squash(s.name).startsWith(f) || (!!s.profileId && squash(s.profileId).startsWith(f)));
}
// "@work": the profile's name as a filter (its folder name when the name has no letters or digits)
function profileToken(s) {
  return squash(s.name) || squash(s.profileId || "") || "default";
}

function searchSQL(words, allowed, kind, limit) {
  const conds = [];
  const scores = ["bm * 40", "min(visits, 500) / 20"];
  for (const w of words) {
    const l = sqlStr(likeEsc(w)).slice(1, -1);
    const has = (col, pat) => `${col} LIKE '${pat}' ESCAPE '\\'`;
    conds.push(`(${has("tf", `%${l}%`)} OR ${has("uf", `%${l}%`)} OR ${has("ff", `%${l}%`)})`);
    scores.push(`(CASE WHEN ${has("tf", `${l}%`)} THEN 30 WHEN ${has("uf", `${l}%`)} THEN 25 WHEN ${has("tf", `% ${l}%`)} THEN 20 ` +
      `WHEN ${has("tf", `%${l}%`)} THEN 10 WHEN ${has("uf", `%${l}%`)} THEN 5 ELSE 2 END)`);
  }
  const t = Math.floor(now());
  scores.push(`(CASE WHEN last > ${t - 86400} THEN 15 WHEN last > ${t - 7 * 86400} THEN 8 WHEN last > ${t - 30 * 86400} THEN 3 ELSE 0 END)`);
  if (allowed) {
    const kinds = kind ? [kind] : ["b", "h"];
    const tags = [];
    for (const idx of allowed) for (const k of kinds) if (/^[0-9a-f]{8}$/.test(idx)) tags.push(`srcs LIKE '%|${k}${idx}|%'`);
    conds.push(tags.length ? `(${tags.join(" OR ")})` : "0");
  } else if (kind) conds.push(`srcs LIKE '%|${kind}%'`);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const order = words.length ? `${scores.join(" + ")} DESC, last DESC` : kind === "b" ? "last DESC, title COLLATE NOCASE" : "last DESC";
  return `SELECT url, title, folder, srcs, bm, visits, last FROM items ${where} ORDER BY ${order} LIMIT ${limit}`;
}

function info(title, subtitle, icon = "info", extra = {}) {
  return Object.assign({ title: oneLine(title), subtitle: oneLine(subtitle || ""), valid: false, icon: { path: `icons/${icon}.png` } }, extra);
}
function mod(arg, subtitle, variables, valid = true) {
  return { arg, subtitle: oneLine(subtitle), valid, variables: variables || {} };
}
function appIcon(b, fallback) {
  const inst = installed(b);
  return inst ? { type: "fileicon", path: inst.path } : { path: `icons/${fallback}.png` };
}

// What ↩ opens: the source profile (a bookmark's first) or the default browser
function openVars(url, src, how) {
  if (how === "default" || !src) return { bh_action: "open", bh_url: url, bh_browser: "", bh_profile: "" };
  return { bh_action: "open", bh_url: url, bh_browser: src.browser.id, bh_profile: src.profileId || "" };
}

function resultItem(r, byIdx, allowedSet, cfg) {
  const url = String(r.url || "");
  const tags = String(r.srcs || "").split("|").filter(Boolean);
  const bSrc = [], hSrc = [];
  for (const t of tags) {
    const idx = t.slice(1);
    const s = byIdx.get(idx);
    if (!s || (allowedSet && !allowedSet.has(idx))) continue;
    (t[0] === "b" ? bSrc : hSrc).push(s);
  }
  const srcs = [...new Set(bSrc.concat(hSrc))];
  const primary = bSrc[0] || hSrc[0] || null;
  const title = String(r.title || "").trim() || displayURL(url);
  const labels = srcs.map(sourceLabel);
  const where = labels.length > 2 ? `${labels.slice(0, 2).join(", ")} +${labels.length - 2}` : labels.join(", ");
  const parts = [];
  if (Number(r.bm)) parts.push(`★ ${r.folder ? shorten(r.folder, 40) : "Bookmark"}`);
  parts.push(shorten(displayURL(url), 60));
  if (where) parts.push(where);
  const when = relativeTime(Number(r.last));
  if (when) parts.push(when);
  const primaryName = primary ? sourceLabel(primary) : "";
  const how = cfg.openWith === "default" || !primary ? "default" : "source";
  const vars = openVars(url, primary, how);
  const other = how === "default" ? (primary ? "source" : null) : "default";
  const md = `[${title.replace(/([\[\]\\])/g, "\\$1")}](${url.replace(/[()\s]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"))})`;
  return {
    title: oneLine(title),
    subtitle: oneLine(parts.join(" · ")),
    arg: url,
    quicklookurl: url,
    text: { copy: url, largetype: url },
    icon: primary ? appIcon(primary.browser, Number(r.bm) ? "bookmark" : "history") : { path: `icons/${Number(r.bm) ? "bookmark" : "history"}.png` },
    variables: vars,
    mods: {
      cmd: other ? mod(url, other === "default" ? "Open in the default browser" : `Open in ${primaryName}`, openVars(url, primary, other))
        : mod(url, "Open in the default browser", vars, false),
      alt: mod(url, "Open in another browser or profile…", { bh_action: "choose", bh_url: url }),
      ctrl: mod(md, "Copy as a Markdown link", { bh_action: "copy", bh_url: url }),
    },
  };
}

// web / bmk / hist
function searchItems(query, kind) {
  const cfg = config();
  const { state, building } = ensureIndex();
  const items = [];
  if (!state) {
    if (building) return { items: [info("Indexing your browsers…", "Reading bookmarks and history on this Mac; results appear in a moment", "refresh")], rerun: 0.5 };
    return { items: [info("Couldn’t index your browsers", "↩ Try again", "error", { valid: true, arg: "", variables: { bh_action: "refresh" } })] };
  }
  const srcs = stateSources(state).filter((s) => !isExcluded(s.browser.id, s.name, cfg));
  if (!state.sources.length || !srcs.length) {
    const why = state.sources.length ? "Every browser is excluded in the Workflow’s Configuration" : "Chrome, Arc, Brave, Edge, Vivaldi, Opera, Dia, Comet, Helium, Firefox, Zen, LibreWolf, Floorp and Safari are supported";
    return { items: [info("No browser data found", why, "empty")] };
  }
  const q = parseQuery(query);
  let pool = srcs;
  for (const f of q.filters) pool = pool.filter((s) => matchesFilter(s, f));
  // "@…" being typed: suggest browsers and profiles (unless it already names one exactly)
  const tf = q.typingFilter;
  const exact = tf && srcs.some((s) => s.browser.id === tf || squash(s.browser.short) === tf || (s.multi && profileToken(s) === tf));
  if (tf !== null && !exact) {
    const prefix = String(query).replace(/(^|\s)@\S*$/, "$1");
    const seen = new Set();
    const sugg = [];
    const browserOnly = (s) => Object.assign({}, s, { name: "", profileId: "" });
    for (const s of srcs.filter((x) => q.finished.every((f) => matchesFilter(x, f)))) {
      // a browser already named by a finished filter: suggest only its profiles
      const named = q.finished.some((f) => matchesFilter(browserOnly(s), f));
      const cands = named ? [] : [[s.browser.id, s.browser.name, null]];
      if (s.multi) cands.push([named ? profileToken(s) : `${s.browser.id} @${profileToken(s)}`, `${s.browser.short} · ${s.name}`, s]);
      for (const [tok, label, prof] of cands) {
        if (seen.has(tok)) continue;
        const ok = !q.typingFilter || (prof ? matchesFilter(s, q.typingFilter) : matchesFilter(browserOnly(s), q.typingFilter));
        if (!ok) continue;
        seen.add(tok);
        sugg.push(info(label, prof ? `Only ${s.browser.short}’s “${s.name}” profile` : `Only ${s.browser.name}`, "filter",
          { autocomplete: `${prefix}@${tok} `, icon: appIcon(s.browser, "filter") }));
      }
    }
    if (sugg.length) return { items: sugg.slice(0, MAX_ROWS) };
    return { items: [info(`No browser or profile matches “@${shorten(oneLine(q.typingFilter), 30)}”`, `Try ${srcs.slice(0, 3).map((s) => "@" + s.browser.id).join(", ")}`, "filter")] };
  }
  if (!pool.length) {
    return { items: [info(`No browser or profile matches “@${shorten(q.filters.join(" @"), 30)}”`, "Type @ to see your browsers and profiles", "filter")] };
  }
  const allowed = pool.length === state.sources.length ? null : pool.map((s) => s.idx);
  const allowedSet = allowed ? new Set(allowed) : null;
  const r = sqlJSON(dbPath(), searchSQL(q.words, allowed, kind, MAX_ROWS));
  if (r.error) {
    spawnIndexer(true);
    return { items: [info("Couldn’t search the index", `${r.error} · ↩ Rebuild it`, "error", { valid: true, arg: "", variables: { bh_action: "refresh" } })] };
  }
  const byIdx = new Map(srcs.map((s) => [s.idx, s]));
  for (const x of r.rows) items.push(resultItem(x, byIdx, allowedSet, cfg));
  const what = kind === "b" ? "bookmarks" : kind === "h" ? "history" : "bookmarks or history";
  if (!items.length) {
    if (q.words.length) {
      const typed = asURL(query.trim());
      items.push(info(`No ${what} match “${shorten(oneLine(query.trim()), 40)}”`, typed ? "↩ Open it as a link" : "Try fewer words, or another @browser", "empty",
        typed ? { valid: true, arg: typed, variables: { bh_action: "open", bh_url: typed, bh_browser: "", bh_profile: "" } } : {}));
    } else if (kind === "h" && !state.history) {
      items.push(info("History isn’t indexed", "Turn on “Index history” in the Workflow’s Configuration", "empty"));
    } else items.push(info(`No ${what} yet`, building ? "Still indexing…" : "Nothing indexed in these browsers", "empty"));
  }
  // Safari without Full Disk Access: explain once, below the results of an empty query
  if (!q.words.length) {
    const blocked = pool.filter((s) => s.bs === "noaccess" || s.hs === "noaccess");
    for (const s of blocked) {
      items.push(info(`${s.browser.name} needs Full Disk Access`, "↩ Open Privacy & Security, then turn on Full Disk Access for Alfred", "lock",
        { valid: true, arg: FDA_URL, variables: { bh_action: "fda" } }));
    }
  }
  const out = { items };
  if (building && !items.some((i) => i.valid !== false)) out.rerun = 1;
  return out;
}

// ---------- profiles ----------

// A URL in the query ("work https://x.com") or copied: what ⌘↩ opens
function splitURL(query) {
  const words = [];
  let url = "";
  for (const t of String(query || "").split(/\s+/).filter(Boolean)) {
    const u = !url && asURL(t);
    if (u) url = u;
    else words.push(t);
  }
  return { url, words: words.map((w) => fold(w)) };
}
function clipboardURL() {
  const pb = pasteboard();
  const s = pb.stringForType($.NSPasteboardTypeString);
  if (s.isNil()) return "";
  return asURL(s.js.trim());
}

function profileRows() {
  const out = [];
  for (const s of discover()) {
    if (s.browser.family === "safari") continue;
    const inst = installed(s.browser);
    if (!inst) continue;
    out.push(Object.assign({}, s, { inst }));
  }
  return out;
}
function matchesWords(fields, words) {
  const hay = fields.map((f) => fold(f || "")).join(" ");
  return words.every((w) => hay.includes(w));
}

function profileItems(query) {
  const { url: typed, words } = splitURL(query);
  const url = typed || clipboardURL();
  const all = profileRows();
  const rows = all.filter((s) => matchesWords([s.name, s.browser.name, s.browser.short, s.email, s.profileId], words));
  if (!all.length) return { items: [info("No browser profiles found", "Chrome, Arc, Brave, Edge, Vivaldi, Opera, Dia, Comet, Helium, Firefox, Zen, LibreWolf and Floorp profiles are listed", "empty")] };
  if (!rows.length) return { items: [info(`No profile matches “${shorten(oneLine(words.join(" ")), 40)}”`, "Try a browser or profile name", "empty")] };
  const items = rows.map((s) => {
    const sub = [s.browser.name, s.email || (s.browser.family === "chromium" && s.profileId ? s.profileId : "")].filter(Boolean).join(" · ");
    const base = { bh_browser: s.browser.id, bh_profile: s.profileId };
    const priv = s.browser.private;
    return {
      title: oneLine(s.name),
      subtitle: oneLine(sub + (s.isDefault && s.multi ? " · default" : "")),
      arg: url || "",
      autocomplete: s.name,
      icon: s.avatar ? { path: s.avatar } : { type: "fileicon", path: s.inst.path },
      variables: Object.assign({ bh_action: "launch", bh_url: "" }, base),
      mods: {
        cmd: url ? mod(url, `Open ${shorten(displayURL(url), 50)} in this profile`, Object.assign({ bh_action: "open", bh_url: url }, base))
          : mod("", "Type or copy a URL to open it in this profile", {}, false),
        alt: priv ? mod(url || "", url ? "Open it in a private window of this profile" : "Open a private window of this profile", Object.assign({ bh_action: "private", bh_url: url || "" }, base))
          : mod("", `${s.browser.short} can’t be opened in a private window from here`, {}, false),
      },
    };
  });
  return { items: items.slice(0, MAX_ROWS) };
}

// ---------- open in ----------

// The URL of the frontmost browser's current tab (Chromium browsers and Safari; asks for Automation
// permission once). Firefox-based browsers can't be asked.
function frontURL() {
  if (isTest()) {
    const t = env("BH_TEST_FRONT", "");
    const i = t.indexOf("\t");
    return i > 0 ? { bundle: t.slice(0, i), url: asURL(t.slice(i + 1)) } : { bundle: "", url: "" };
  }
  const app = $.NSWorkspace.sharedWorkspace.menuBarOwningApplication;
  if (app.isNil() || app.bundleIdentifier.isNil()) return { bundle: "", url: "" };
  const bundle = app.bundleIdentifier.js;
  const b = BROWSERS.find((x) => x.bundles.includes(bundle));
  if (!b || b.family === "firefox") return { bundle, url: "" };
  const script = b.family === "safari"
    ? "function run(argv) { const a = Application(argv[0]); return a.documents.length ? a.documents[0].url() : ''; }"
    : "function run(argv) { const a = Application(argv[0]); return a.windows.length ? a.windows[0].activeTab.url() : ''; }";
  const r = runTask("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, bundle], { timeout: 1.5 });
  return { bundle, url: r.status === 0 ? asURL(r.stdout.trim()) : "" };
}

function openInItems(query) {
  const { url: typed, words } = splitURL(query);
  let url = typed, from = "";
  // The current tab's URL is remembered for this Alfred session (Script Filter variables come back
  // in on the next run), so typing to filter the browsers doesn't ask the browser again
  let front = env("bh_front_url", null), frontFrom = env("bh_front_from", "");
  if (!url) {
    if (front === null) {
      const f = frontURL();
      front = f.url || "-";
      const b = BROWSERS.find((x) => x.bundles.includes(f.bundle));
      frontFrom = f.url ? (b ? `From ${b.name}` : "From the frontmost browser") : "";
    }
    if (front !== "-" && asURL(front)) {
      url = asURL(front);
      from = frontFrom;
    } else {
      url = clipboardURL();
      if (url) from = "From the clipboard";
    }
  }
  const def = defaultBrowserBundle();
  const rows = [];
  for (const b of BROWSERS) {
    const inst = installed(b);
    if (!inst) continue;
    const profs = b.family === "safari" ? [] : discover().filter((s) => s.browser === b);
    rows.push({ b, inst, prof: null, isDef: b.bundles.includes(def) });
    if (profs.length > 1) for (const p of profs) rows.push({ b, inst, prof: p, isDef: false });
  }
  rows.sort((x, y) => (y.isDef ? 1 : 0) - (x.isDef ? 1 : 0));
  let shown = rows.filter((r) => matchesWords([r.b.name, r.b.short, r.prof ? r.prof.name : "", r.prof ? r.prof.email : ""], words));
  // text selected around a link ("see https://… today") isn't a filter
  if (!shown.length && typed) shown = rows;
  const items = [];
  if (url) items.push(info(`Open ${shorten(displayURL(url), 60)} in…`, from || "The typed link", "link", { quicklookurl: url }));
  else items.push(info("No link to open", "Type or copy a URL, or use the Universal Action on a link; ↩ below opens the browser", "link"));
  if (!rows.length) return { items: [info("No browsers found", "Install a browser to open links in it", "empty")] };
  if (!shown.length) items.push(info(`No browser matches “${shorten(oneLine(words.join(" ")), 40)}”`, "Try a browser or profile name", "empty"));
  for (const r of shown) {
    const base = { bh_browser: r.b.id, bh_profile: r.prof ? r.prof.profileId : "", bh_url: url };
    const title = r.prof ? `${r.b.short} · ${r.prof.name}` : r.b.name;
    const sub = r.prof ? (r.prof.email || "Profile") : r.isDef ? "Default browser" : "";
    items.push({
      title: oneLine(title),
      subtitle: oneLine([sub, url ? "↩ Open the link here" : "↩ Open the browser"].filter(Boolean).join(" · ")),
      arg: url || "",
      icon: r.prof && r.prof.avatar ? { path: r.prof.avatar } : { type: "fileicon", path: r.inst.path },
      variables: Object.assign({ bh_action: url ? "open" : "launch" }, base),
      mods: {
        cmd: r.b.private ? mod(url || "", url ? "Open it in a private window" : "Open a private window", Object.assign({ bh_action: "private" }, base))
          : mod("", `${r.b.short} can’t be opened in a private window from here`, {}, false),
      },
    });
  }
  const out = { items: items.slice(0, MAX_ROWS + 1) };
  if (front !== null) out.variables = { bh_front_url: front, bh_front_from: frontFrom };
  return out;
}

// ---------- status and maintenance ----------

function browserItems(query) {
  const cfg = config();
  const words = String(query || "").split(/\s+/).filter(Boolean).map(fold);
  const state = loadState();
  const stateBy = new Map(state ? state.sources.map((s) => [s.key, s]) : []);
  const items = [];
  const building = lockHeld("index", INDEX_STALE);
  const pages = state ? state.sources.reduce((n, s) => n + s.b + s.h, 0) : 0;
  items.push(info("Refresh the index", building ? "Indexing now…" : state ? `Updated ${relativeTime(state.built) || "just now"} · ${plural(pages, "entry", "entries")} · ↩ Read every browser again` : "Not indexed yet · ↩ Index your browsers now", "refresh",
    { valid: true, arg: "", variables: { bh_action: "refresh" } }));
  const kw = keyword("web", "web");
  for (const s of discover()) {
    const st = stateBy.get(s.key);
    const name = s.multi ? `${s.browser.name} · ${s.name}` : s.browser.name;
    let sub, extra = {};
    if (isExcluded(s.browser.id, s.name, cfg)) sub = "Not indexed: excluded in the Workflow’s Configuration";
    else if (!st) sub = building ? "Indexing…" : "Not indexed yet";
    else if (st.bs === "noaccess" || st.hs === "noaccess") {
      sub = "Needs Full Disk Access for Alfred · ↩ Open Privacy & Security";
      extra = { valid: true, arg: FDA_URL, variables: { bh_action: "fda" }, icon: { path: "icons/lock.png" } };
    } else {
      const errs = [st.bs, st.hs].filter((x) => x && x !== "ok" && x !== "noaccess");
      sub = `${plural(st.b, "bookmark", "bookmarks")}${state.history ? ` · ${plural(st.h, "history page", "history pages")}` : ""}` + (errs.length ? ` · ${errs[0]}` : "");
      const tok = s.multi ? `@${s.browser.id} @${profileToken(s)} ` : `@${s.browser.id} `;
      extra = { valid: true, arg: `${kw} ${tok}`, variables: { bh_action: "search" } };
      sub += " · ↩ Search it";
    }
    if (!matchesWords([name, s.browser.short], words)) continue;
    items.push(Object.assign({ title: oneLine(name), subtitle: oneLine(sub), valid: false, icon: appIcon(s.browser, "browser") }, extra));
  }
  if (!discover().length) items.push(info("No browser data found", "Supported: Chromium browsers, Firefox-based browsers and Safari", "empty"));
  items.push(info("Clear the index", "Delete the workflow’s copy of your bookmarks and history (it’s rebuilt at your next search)", "clear",
    { valid: true, arg: "", variables: { bh_action: "clear" } }));
  return { items };
}

// ---------- actions ----------

function pasteboard() {
  const name = env("BH_TEST_PASTEBOARD", "") || (isTest() ? `${BUNDLE}.test` : "");
  return name ? $.NSPasteboard.pasteboardWithName(name) : $.NSPasteboard.generalPasteboard;
}
function copyText(s) {
  const pb = pasteboard();
  pb.clearContents;
  return pb.setStringForType($(s), $.NSPasteboardTypeString);
}
function openArgs(args) {
  if (isTest() || env("BH_TEST_DRYRUN", "") === "1") return "open " + JSON.stringify(args);
  const r = runTask("/usr/bin/open", args, { stderr: true });
  return r.status === 0 ? "" : `Couldn’t open it: ${oneLine(r.stderr).trim() || "open failed"}`;
}
function openSystemURL(url) {
  if (isTest() || env("BH_TEST_DRYRUN", "") === "1") return `open ${JSON.stringify([url])}`;
  const u = $.NSURL.URLWithString(url);
  return !u.isNil() && $.NSWorkspace.sharedWorkspace.openURL(u) ? "" : "Couldn’t open System Settings";
}
function alfredSearch(text) {
  if (isTest() || env("BH_TEST_DRYRUN", "") === "1") return `alfred ${JSON.stringify(text)}`;
  Application("com.runningwithcrayons.Alfred").search(text);
  return "";
}

// open [-n] -b <bundle> [--args <profile and window flags>] [url]
function browserArgs(b, bundle, profileId, url, priv) {
  const flags = [];
  if (profileId) flags.push(b.family === "firefox" ? "-P" : `--profile-directory=${profileId}`);
  if (profileId && b.family === "firefox") flags.push(profileId);
  if (priv && b.private) flags.push(b.private);
  if (!flags.length) return url ? ["-b", bundle, url] : ["-b", bundle];
  // a second instance hands the arguments to the running browser (Chromium) or opens the profile
  const args = ["-n", "-b", bundle, "--args", ...flags];
  if (url) args.push(url);
  return args;
}

function doAction(arg) {
  const action = env("bh_action", "open");
  const url = asURL(env("bh_url", "") || "") || (indexable(arg) ? arg : "");
  switch (action) {
    case "open":
    case "launch":
    case "private": {
      const id = env("bh_browser", "");
      if (!id) {
        if (!url) return "Couldn’t open it: no link";
        // "open file:///…/Some.app" would launch it, and other schemes (tel:, ftp:, an app's own
        // links) would go to whatever app claims them: only web links are handed to LaunchServices,
        // everything else from browser data goes to the default browser, like clicking it there
        if (!/^https?$/.test(schemeOf(url))) return openArgs(["-b", defaultBrowserBundle() || "com.apple.Safari", url]);
        return openArgs([url]);
      }
      const b = BROWSER_BY_ID.get(id);
      if (!b) return "Couldn’t open it: unknown browser";
      const inst = installed(b);
      if (!inst) return `Couldn’t open ${b.name}: it isn’t installed`;
      const profile = b.family === "safari" ? "" : env("bh_profile", "");
      return openArgs(browserArgs(b, inst.bundle, profile, action === "launch" ? "" : url, action === "private"));
    }
    case "choose":
      return alfredSearch(`${keyword("openin", "openin")} ${url}`);
    case "search":
      return alfredSearch(arg);
    case "copy":
      copyText(arg);
      return "";
    case "fda":
      return openSystemURL(FDA_URL);
    case "refresh": {
      if (isTest()) {
        runIndexer(true);
        return "Refreshed the index";
      }
      return spawnIndexer(true) > 0 || lockHeld("index", INDEX_STALE) ? "Refreshing the index…" : "Couldn’t start the indexer";
    }
    case "clear":
      clearIndex();
      return "Cleared the index";
    default:
      return `Unknown action: ${oneLine(action)}`;
  }
}

// Every modifier is connected to the action, so a row without its own entry for one would run
// its ↩ action; make such modifiers do nothing instead (the subtitle stays).
const ALL_MODS = ["cmd", "alt", "ctrl"];
function fillMods(items) {
  for (const it of items) {
    if (it.valid === false) continue;
    it.mods = it.mods || {};
    for (const k of ALL_MODS) if (!it.mods[k]) it.mods[k] = { arg: it.arg || "", subtitle: it.subtitle || "", valid: false };
  }
}

// ---------- entry ----------

function run(argv) {
  const [cmd, ...rest] = argv;
  const query = rest.join(" ");
  const guard = testGuardError();
  if (guard) {
    // nothing is read, written or opened
    if (cmd === "action" || cmd === "index" || cmd === "index-now") return `Refused: ${guard}`;
    return JSON.stringify({ items: [{ title: "Refused to run", subtitle: guard, valid: false }] });
  }
  try {
    let res;
    switch (cmd) {
      case "web": res = searchItems(query, null); break;
      case "bmk": res = searchItems(query, "b"); break;
      case "hist": res = searchItems(query, "h"); break;
      case "prof": res = profileItems(query); break;
      case "openin": res = openInItems(query); break;
      case "browsers": res = browserItems(query); break;
      case "index":
        runIndexer(query === "force");
        return undefined;
      case "index-now": // tests: build synchronously
        refreshIndex(query === "force");
        cleanTmp();
        return undefined;
      // an empty result prints nothing, so the Notification (only when populated) stays quiet
      case "action": return doAction(query) || undefined;
      default: res = { items: [info(`Unknown command: ${cmd}`, "", "error")] };
    }
    stableUids(res.items || []);
    fillMods(res.items || []);
    return JSON.stringify(Object.assign({ skipknowledge: true }, res));
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (cmd === "action") return `Couldn’t finish: ${msg}`;
    if (cmd === "index" || cmd === "index-now") return undefined;
    return JSON.stringify({ items: [info("Couldn’t search your browsers", msg, "error")] });
  }
}
