#!/usr/bin/env python3
"""End-to-end tests: run the Script Filters and actions the way Alfred does and validate the JSON.

Every test builds fake browser data in a temporary folder: Chrome-style Bookmarks JSON and History
databases, Firefox places.sqlite files and Safari plists, all created here. BH_TEST_ROOT replaces the
home folder, so the real browser data on this Mac is never read. In test mode the workflow also
never looks up real apps (BH_TEST_APPS lists fake ones), never scripts a browser, never opens
anything (actions print what they would run) and uses a private named pasteboard.
"""
import json, os, plistlib, shutil, sqlite3, stat, subprocess, tempfile, time, unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "src")
PASTEBOARD = "io.github.x-o-r-r-o.browserhub.test"
CONFIG_VARS = ("excluded_browsers", "index_history", "history_limit", "open_with")
NOW = 1790000000  # 2026-09-21
AS = ("Library", "Application Support")


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb" if isinstance(data, bytes) else "w", **({} if isinstance(data, bytes) else {"encoding": "utf-8"})) as f:
        f.write(data)
    return path


def chrome_time(unix):
    return int((unix + 11644473600) * 1e6)


def make_chrome_history(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE urls(id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0 NOT NULL,"
               " typed_count INTEGER DEFAULT 0 NOT NULL, last_visit_time INTEGER NOT NULL, hidden INTEGER DEFAULT 0 NOT NULL)")
    for url, title, visits, ago, *hidden in rows:
        db.execute("INSERT INTO urls(url, title, visit_count, last_visit_time, hidden) VALUES(?,?,?,?,?)",
                   (url, title, visits, chrome_time(NOW - ago), hidden[0] if hidden else 0))
    db.commit()
    db.close()


def chrome_bookmarks(bar, other=(), synced=()):
    def node(x):
        if isinstance(x, tuple) and isinstance(x[1], list):
            return {"type": "folder", "name": x[0], "children": [node(c) for c in x[1]]}
        return {"type": "url", "name": x[0], "url": x[1]}
    return json.dumps({"version": 1, "roots": {
        "bookmark_bar": {"type": "folder", "name": "Bookmarks bar", "children": [node(c) for c in bar]},
        "other": {"type": "folder", "name": "Other bookmarks", "children": [node(c) for c in other]},
        "synced": {"type": "folder", "name": "Mobile bookmarks", "children": [node(c) for c in synced]}}})


def make_places(path, places, bookmarks, wal_rows=()):
    """places: [(id, url, title, visits, ago)], bookmarks: [(id, type, fk, parent, title)] after the roots"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url LONGVARCHAR, title LONGVARCHAR, visit_count INTEGER DEFAULT 0,"
               " hidden INTEGER DEFAULT 0 NOT NULL, frecency INTEGER DEFAULT -1, last_visit_date INTEGER)")
    db.execute("CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER DEFAULT NULL, parent INTEGER,"
               " position INTEGER, title LONGVARCHAR, guid TEXT)")
    roots = [(1, 2, None, 0, "", "root________"), (2, 2, None, 1, "menu", "menu________"), (3, 2, None, 1, "toolbar", "toolbar_____"),
             (4, 2, None, 1, "tags", "tags________"), (5, 2, None, 1, "unfiled", "unfiled_____"), (6, 2, None, 1, "mobile", "mobile______")]
    for r in roots:
        db.execute("INSERT INTO moz_bookmarks(id, type, fk, parent, title, guid) VALUES(?,?,?,?,?,?)", r)
    for pid, url, title, visits, ago in places:
        db.execute("INSERT INTO moz_places(id, url, title, visit_count, last_visit_date) VALUES(?,?,?,?,?)",
                   (pid, url, title, visits, None if ago is None else int((NOW - ago) * 1e6)))
    for bid, typ, fk, parent, title in bookmarks:
        db.execute("INSERT INTO moz_bookmarks(id, type, fk, parent, title, guid) VALUES(?,?,?,?,?,?)", (bid, typ, fk, parent, title, "g%09d" % bid))
    db.commit()
    if wal_rows:
        db.execute("PRAGMA wal_autocheckpoint=0")
        for pid, url, title, visits, ago in wal_rows:
            db.execute("INSERT INTO moz_places(id, url, title, visit_count, last_visit_date) VALUES(?,?,?,?,?)",
                       (pid, url, title, visits, int((NOW - ago) * 1e6)))
        db.commit()
        # keep the connection's WAL: copy the files while it is open (like a running Firefox)
        return db
    db.close()
    return None


def make_safari_history(path, rows):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    db = sqlite3.connect(path)
    db.execute("CREATE TABLE history_items(id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, visit_count INTEGER NOT NULL)")
    db.execute("CREATE TABLE history_visits(id INTEGER PRIMARY KEY, history_item INTEGER NOT NULL, visit_time REAL NOT NULL, title TEXT)")
    for i, (url, title, visits, ago) in enumerate(rows, 1):
        db.execute("INSERT INTO history_items VALUES(?,?,?)", (i, url, visits))
        db.execute("INSERT INTO history_visits(history_item, visit_time, title) VALUES(?,?,?)", (i, NOW - ago - 978307200 - 500, "old title"))
        db.execute("INSERT INTO history_visits(history_item, visit_time, title) VALUES(?,?,?)", (i, NOW - ago - 978307200, title))
    db.commit()
    db.close()


def safari_bookmarks():
    leaf = lambda title, url: {"WebBookmarkType": "WebBookmarkTypeLeaf", "URLString": url, "URIDictionary": {"title": title}}
    lst = lambda title, children: {"WebBookmarkType": "WebBookmarkTypeList", "Title": title, "Children": children}
    return plistlib.dumps(lst("", [
        {"WebBookmarkType": "WebBookmarkTypeProxy", "Title": "History"},
        lst("BookmarksBar", [leaf("Apple Developer", "https://developer.apple.com/"), lst("Cooking", [leaf("Sourdough Starter", "https://bread.example/starter")])]),
        lst("BookmarksMenu", [leaf("GitHub from Safari", "https://github.com")]),
        lst("com.apple.ReadingList", [leaf("Long Read", "https://read.example/article")]),
    ]), fmt=plistlib.FMT_BINARY)


def read_pasteboard():
    script = "ObjC.import('AppKit'); function run(argv) { const s = $.NSPasteboard.pasteboardWithName(argv[0]).stringForType($.NSPasteboardTypeString); return s.isNil() ? '' : s.js; }"
    return subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", script, PASTEBOARD], capture_output=True, text=True).stdout.rstrip("\n")


def set_pasteboard(text):
    script = "ObjC.import('AppKit'); function run(argv) { const pb = $.NSPasteboard.pasteboardWithName(argv[0]); pb.clearContents; pb.setStringForType($(argv[1]), $.NSPasteboardTypeString); }"
    subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", script, PASTEBOARD, text], capture_output=True)


def validate(data):
    assert isinstance(data.get("items"), list) and data["items"], data
    assert data.get("skipknowledge") is True, data
    uids = set()
    for it in data["items"]:
        assert isinstance(it.get("title"), str) and it["title"], it
        for k in ("title", "subtitle"):
            v = it.get(k, "")
            assert "\n" not in v and "‮" not in v and "\x00" not in v, it
        icon = it.get("icon")
        if icon and icon.get("type") != "fileicon":
            p = icon["path"]
            assert os.path.exists(p if p.startswith("/") else os.path.join(SRC, p)), icon
        if it.get("valid", True) is not False:
            assert "arg" in it, it
            for k in ("cmd", "alt", "ctrl"):
                assert k in it.get("mods", {}), it
        for m in (it.get("mods") or {}).values():
            assert "subtitle" in m and "arg" in m, m
        assert it["uid"] not in uids, it
        uids.add(it["uid"])


class Base(unittest.TestCase):
    """Chrome (Personal + Work), Brave (no Local State), Opera (profile in the data folder), Firefox
    (two profiles, one only in the WAL), Zen, and Safari."""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="bh-test-"))
        self.root = os.path.join(self.tmp, "home dir ü")
        self.cache = os.path.join(self.tmp, "Alfred cache 'x' ü")
        self.keep = []
        self.apps = {"com.google.Chrome": "/Applications/Google Chrome.app", "org.mozilla.firefox": "/Applications/Firefox.app",
                     "com.apple.Safari": "/Applications/Safari.app", "app.zen-browser.zen": "/Applications/Zen.app",
                     "com.brave.Browser": "/Applications/Brave Browser.app"}
        self.make_chrome()
        self.make_brave_opera()
        self.make_firefox()
        self.make_safari()

    def tearDown(self):
        for db in self.keep:
            db.close()
        for base, dirs, files in os.walk(self.tmp):
            for d in dirs:
                os.chmod(os.path.join(base, d), 0o755)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def A(self, *parts):
        return os.path.join(self.root, *AS, *parts)

    def make_chrome(self):
        c = self.A("Google", "Chrome")
        write(os.path.join(c, "Local State"), json.dumps({"profile": {
            "info_cache": {"Default": {"name": "Personal", "user_name": "me@example.com"},
                           "Profile 1": {"name": "Work", "user_name": "me@work.example"}},
            "profiles_order": ["Default", "Profile 1"]}}))
        write(os.path.join(c, "Default", "Bookmarks"), chrome_bookmarks(
            [("GitHub", "https://github.com/"), ("Dev", [("Python Docs", "https://docs.python.org/3/"), ("Bookmarklet", "javascript:alert(1)")])],
            [("Zürich Travel Guide", "https://zurich.example/guide")]))
        write(os.path.join(c, "Default", "Google Profile Picture.png"), b"\x89PNG")
        make_chrome_history(os.path.join(c, "Default", "History"), [
            ("https://github.com/", "GitHub: Let’s build from here", 40, 3600),
            ("https://news.example/today", "Daily News", 5, 60),
            ("chrome://settings/", "Settings", 3, 30),
            ("https://hidden.example/", "Hidden", 1, 30, 1),
            ("https://old.example/", "Old Page", 1, 86400 * 90),
        ])
        write(os.path.join(c, "Profile 1", "Bookmarks"), chrome_bookmarks([("Invoices", "https://billing.work.example/invoices")]))
        make_chrome_history(os.path.join(c, "Profile 1", "History"), [
            ("https://jira.work.example/browse/X-1", "X-1 Fix the invoice export", 12, 7200),
            ("https://github.com", "GitHub", 3, 100),
        ])
        write(os.path.join(c, "System Profile", "Bookmarks"), chrome_bookmarks([("System", "https://system.example/")]))

    def make_brave_opera(self):
        write(self.A("BraveSoftware", "Brave-Browser", "Default", "Bookmarks"), chrome_bookmarks([("Brave Search", "https://search.brave.com/")]))
        o = self.A("com.operasoftware.Opera")
        write(os.path.join(o, "Bookmarks"), chrome_bookmarks([("Opera Addons", "https://addons.opera.com/")]))
        make_chrome_history(os.path.join(o, "History"), [("https://opera.example/", "Opera News", 2, 500)])

    def make_firefox(self):
        f = self.A("Firefox")
        self.outside = os.path.join(self.tmp, "outside-profile")
        make_places(os.path.join(self.outside, "places.sqlite"), [(1, "https://outside.example/", "Outside", 1, 10)], [])
        write(os.path.join(f, "profiles.ini"), "[Install4F96D1932A9F858E]\nDefault=Profiles/abc.default-release\nLocked=1\n\n"
              "[Profile1]\nName=default\nIsRelative=1\nPath=Profiles/xyz.default\nDefault=1\n\n"
              "[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\n\n"
              f"[Profile2]\nName=Outside\nIsRelative=0\nPath={self.outside}\n\n[General]\nStartWithLastProfile=1\nVersion=2\n")
        db = make_places(os.path.join(f, "Profiles", "abc.default-release", "places.sqlite"),
                         [(1, "https://cooking.example/carbonara", "Carbonara Recipe", 7, 7200),
                          (2, "https://github.com/", "GitHub", 9, 1800),
                          (3, "place:sort=8&maxResults=10", "Most Visited", 0, None),
                          (4, "https://ünicode.example/straße", "Straße ÄÖÜ", 1, 400),
                          (5, "https://bookmark-never-visited.example/", "Never Visited", 0, None)],
                         [(10, 2, None, 3, "Recipes"), (20, 1, 1, 10, "Pasta Carbonara"), (11, 2, None, 4, "cooking"),
                          (21, 1, 1, 11, None), (22, 1, 3, 2, "Most Visited"), (23, 1, 5, 5, "Never Visited")],
                         wal_rows=[(6, "https://wal-only.example/", "Only In The WAL", 2, 90)])
        self.keep.append(db)
        make_places(os.path.join(f, "Profiles", "xyz.default", "places.sqlite"), [(1, "https://second.example/", "Second Profile Page", 1, 50)], [])
        z = self.A("zen")
        write(os.path.join(z, "profiles.ini"), "[Profile0]\nName=Default (release)\nIsRelative=1\nPath=Profiles/zzz.release\nDefault=1\n")
        make_places(os.path.join(z, "Profiles", "zzz.release", "places.sqlite"),
                    [(1, "https://zen.example/space", "Zen Spaces", 4, 300)], [(10, 1, 1, 3, "Zen Spaces Docs")])

    def make_safari(self):
        s = os.path.join(self.root, "Library", "Safari")
        write(os.path.join(s, "Bookmarks.plist"), safari_bookmarks())
        make_safari_history(os.path.join(s, "History.db"), [
            ("https://developer.apple.com/", "Apple Developer Docs", 3, 20000),
            ("https://safari-only.example/", "Safari Only Page", 1, 10),
        ])

    # ----- running the workflow -----

    def env(self, extra):
        e = {k: v for k, v in os.environ.items() if k not in CONFIG_VARS and not k.startswith(("bh_", "BH_", "keyword_"))}
        e.update(BH_TEST_ROOT=self.root, alfred_workflow_cache=self.cache, BH_TEST_NO_SPAWN="1", BH_TEST_NOW=str(NOW),
                 BH_TEST_PASTEBOARD=PASTEBOARD, BH_TEST_APPS=",".join(f"{k}={v}" for k, v in self.apps.items()),
                 BH_TEST_DEFAULT_BROWSER="com.apple.Safari")
        e.update({k: str(v) for k, v in extra.items()})
        assert e["BH_TEST_ROOT"].startswith(self.tmp)  # never the real browser data
        return e

    def js(self, args, **env):
        out = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "./browserhub.js", *args], cwd=SRC, env=self.env(env),
                             capture_output=True, text=True, timeout=120)
        self.assertEqual(out.returncode, 0, out.stderr)
        return out.stdout.rstrip("\n")

    def index(self, force=True, **env):
        self.js(["index-now", "force" if force else ""], **env)

    def sf(self, cmd, query="", index=True, **env):
        if index:
            self.index(**env)
        data = json.loads(self.js([cmd, query], **env))
        validate(data)
        return data

    def items(self, cmd, query="", **env):
        return self.sf(cmd, query, **env)["items"]

    def titles(self, cmd, query="", **env):
        return [i["title"] for i in self.items(cmd, query, **env)]

    def action(self, arg="", **env):
        return self.js(["action", arg], **env)

    def find(self, items, title):
        for i in items:
            if i["title"] == title:
                return i
        self.fail(f"{title!r} not in {[i['title'] for i in items]}")

    def cache_files(self):
        return sorted(os.listdir(self.cache)) if os.path.isdir(self.cache) else []


# ---------- search ----------

class SearchTests(Base):
    def test_empty_query_lists_recent_pages(self):
        t = self.titles("web")
        self.assertEqual(t[0], "Safari Only Page")  # 10 s ago
        self.assertEqual(t[1], "Second Profile Page")
        self.assertIn("Daily News", t)
        self.assertNotIn("Settings", t)  # chrome:// pages are skipped
        self.assertNotIn("Hidden", t)

    def test_every_browser_is_indexed(self):
        t = self.titles("web", "e")  # broad
        for title in ("Python Docs", "Invoices", "Brave Search", "Opera Addons", "Opera News", "Pasta Carbonara",
                      "Zen Spaces Docs", "Sourdough Starter", "Long Read", "Only In The WAL", "Second Profile Page"):
            self.assertIn(title, self.titles("web", title.split()[0].lower()), title)
        self.assertTrue(t)

    def test_item_shape_and_mods(self):
        it = self.find(self.items("web", "python"), "Python Docs")
        self.assertEqual(it["arg"], "https://docs.python.org/3/")
        self.assertEqual(it["quicklookurl"], "https://docs.python.org/3/")
        self.assertEqual(it["text"]["copy"], "https://docs.python.org/3/")
        self.assertIn("★ Bookmarks bar/Dev", it["subtitle"])
        self.assertIn("docs.python.org/3/", it["subtitle"])
        self.assertIn("Chrome (Personal)", it["subtitle"])
        self.assertEqual(it["icon"], {"type": "fileicon", "path": "/Applications/Google Chrome.app"})
        self.assertEqual(it["variables"], {"bh_action": "open", "bh_url": "https://docs.python.org/3/", "bh_browser": "chrome", "bh_profile": "Default"})
        self.assertEqual(it["mods"]["cmd"]["variables"]["bh_browser"], "")
        self.assertEqual(it["mods"]["cmd"]["subtitle"], "Open in the default browser")
        self.assertEqual(it["mods"]["alt"]["variables"]["bh_action"], "choose")
        self.assertEqual(it["mods"]["ctrl"]["arg"], "[Python Docs](https://docs.python.org/3/)")

    def test_open_with_default_setting(self):
        it = self.find(self.items("web", "python", open_with=" default "), "Python Docs")
        self.assertEqual(it["variables"]["bh_browser"], "")
        self.assertEqual(it["mods"]["cmd"]["variables"]["bh_browser"], "chrome")
        self.assertEqual(it["mods"]["cmd"]["subtitle"], "Open in Chrome (Personal)")

    def test_dedupe_across_browsers(self):
        items = [i for i in self.items("web", "github") if "github.com" in i["arg"]]
        self.assertEqual(len(items), 1, [i["title"] for i in items])
        it = items[0]
        self.assertEqual(it["title"], "GitHub")  # the bookmark's title wins
        self.assertTrue(it["subtitle"].startswith("★"))
        self.assertIn("+", it["subtitle"])  # Chrome, Firefox, Safari… more than two sources
        self.assertEqual(it["arg"], "https://github.com/")

    def test_ranking(self):
        t = self.titles("web", "git")
        self.assertEqual(t[0], "GitHub")
        t = self.titles("web", "carbonara")
        self.assertEqual(t[0], "Pasta Carbonara")  # bookmark title, Firefox folder

    def test_folder_and_url_search(self):
        self.assertIn("Sourdough Starter", self.titles("web", "cooking"))  # Safari folder
        self.assertIn("X-1 Fix the invoice export", self.titles("web", "jira.work"))
        self.assertEqual(self.titles("web", "recipes pasta")[0], "Pasta Carbonara")

    def test_unicode_folding(self):
        self.assertIn("Zürich Travel Guide", self.titles("web", "zurich"))
        self.assertIn("Zürich Travel Guide", self.titles("web", "ZÜRICH"))
        self.assertIn("Straße ÄÖÜ", self.titles("web", "aou"))

    def test_firefox_details(self):
        t = self.titles("web", "")
        all_titles = self.titles("web", "example")
        self.assertNotIn("Most Visited", all_titles)  # place: query
        self.assertNotIn("Outside", self.titles("web", "outside"))  # profile outside the test root: never read
        it = self.find(self.items("web", "carbonara"), "Pasta Carbonara")
        self.assertIn("★ Bookmarks Toolbar/Recipes", it["subtitle"])
        self.assertNotIn("Recipes/cooking", it["subtitle"])  # tags aren't folders
        self.assertNotIn("★ cooking", self.titles("web", "cooking"))
        self.assertTrue(t)

    def test_safari_details(self):
        it = self.find(self.items("web", "sourdough"), "Sourdough Starter")
        self.assertIn("★ Favorites/Cooking", it["subtitle"])
        it = self.find(self.items("web", "long read"), "Long Read")
        self.assertIn("★ Reading List", it["subtitle"])
        it = self.find(self.items("webh" if False else "hist", "safari only"), "Safari Only Page")
        self.assertEqual(it["variables"]["bh_browser"], "safari")
        self.assertEqual(it["icon"]["path"], "/Applications/Safari.app")

    def test_bookmarks_only_and_history_only(self):
        b = self.titles("bmk", "")
        self.assertIn("Python Docs", b)
        self.assertNotIn("Daily News", b)
        h = self.titles("hist", "")
        self.assertIn("Daily News", h)
        self.assertNotIn("Python Docs", h)
        self.assertNotIn("Invoices", self.titles("hist", "invoices"))
        self.assertIn("No history match “invoices”", self.titles("hist", "invoices"))

    def test_filters(self):
        t = self.titles("web", "@chrome @work ")
        self.assertIn("Invoices", t)
        self.assertNotIn("Python Docs", t)
        t = self.titles("web", "@work invoice")
        self.assertEqual(t[:2], ["Invoices", "X-1 Fix the invoice export"])
        t = self.titles("web", "@safari")
        self.assertIn("Sourdough Starter", t)
        self.assertNotIn("Python Docs", t)
        t = self.titles("web", "@firefox github")
        it = self.items("web", "@firefox github")[0]
        self.assertEqual(it["variables"]["bh_browser"], "firefox")  # opened where the filter points
        self.assertNotIn("Chrome", it["subtitle"])
        self.assertTrue(t)
        t = self.titles("web", "@nope ")
        self.assertEqual(t, ["No browser or profile matches “@nope”"])

    def test_filter_suggestions(self):
        items = self.items("web", "invoice @")
        titles = [i["title"] for i in items]
        self.assertIn("Google Chrome", titles)
        self.assertIn("Chrome · Work", titles)
        self.assertIn("Safari", titles)
        it = self.find(items, "Chrome · Work")
        self.assertEqual(it["autocomplete"], "invoice @chrome @work ")
        t = self.titles("web", "@saf")
        self.assertEqual(t, ["Safari"])
        self.assertEqual(self.titles("web", "@zz"), ["No browser or profile matches “@zz”"])
        # a finished filter (trailing space), or one naming a browser or profile exactly, searches
        self.assertIn("Sourdough Starter", self.titles("web", "@safari "))
        self.assertIn("Sourdough Starter", self.titles("web", "@safari"))
        self.assertIn("Invoices", self.titles("web", "@chrome @work"))
        self.assertEqual(self.titles("web", "@chrome @wo"), ["Chrome · Work"])
        self.assertEqual(self.titles("web", "@firefox @d"), ["Firefox · default-release", "Firefox · default"])
        self.assertEqual(self.titles("web", "@firefox @wo"), ["No browser or profile matches “@wo”"])
        self.assertEqual(self.titles("web", "@firefox @"), ["Firefox", "Firefox · default-release", "Firefox · default"])

    def test_no_results(self):
        items = self.items("web", "qwertyuiop")
        self.assertEqual(items[0]["title"], "No bookmarks or history match “qwertyuiop”")
        self.assertIs(items[0]["valid"], False)
        it = self.items("web", "example.org/page")[0]
        self.assertEqual(it["arg"], "https://example.org/page")  # a typed link can be opened

    def test_injection_and_odd_input(self):
        for q in ["'", "' OR 1=1 --", "%", "_", "\\", "\"", "a'); DROP TABLE items; --", "$(touch /tmp/bh-pwned)", "`id`", "‮evil", "@'", "@%"]:
            data = self.sf("web", q, index=False) if q != "'" else self.sf("web", q)
            self.assertTrue(data["items"])
        self.assertFalse(os.path.exists("/tmp/bh-pwned"))
        # % and _ are literal
        self.assertEqual(self.titles("web", "%")[0], "No bookmarks or history match “%”")

    def test_odd_titles(self):
        c = self.A("Google", "Chrome", "Default", "Bookmarks")
        write(c, chrome_bookmarks([("Quote ' \" and\nnewline ‮RTL", "https://odd.example/?q='x'&y=%20"),
                                   ("", "https://untitled.example/path"), ("Lone \ud800 surrogate", "https://lone.example/"),
                                   ("Paren (x) [y]", "https://paren.example/a_(b)")]))
        items = self.items("web", "odd")
        it = self.find(items, "Quote ' \" and newline RTL")
        self.assertEqual(it["arg"], "https://odd.example/?q='x'&y=%20")
        self.assertIn("untitled.example/path", self.titles("web", "untitled"))
        self.assertIn("Lone � surrogate", self.titles("web", "lone"))
        it = self.find(self.items("web", "paren"), "Paren (x) [y]")
        self.assertEqual(it["mods"]["ctrl"]["arg"], "[Paren (x) \\[y\\]](https://paren.example/a_%28b%29)")

    def test_uids_are_stable(self):
        a = [i["uid"] for i in self.items("web", "github")]
        b = [i["uid"] for i in self.items("web", "github", index=False)]
        self.assertEqual(a, b)

    def test_safari_without_full_disk_access(self):
        s = os.path.join(self.root, "Library", "Safari")
        os.chmod(s, 0)
        try:
            items = self.items("web", "")
            it = self.find(items, "Safari needs Full Disk Access")
            self.assertEqual(it["variables"]["bh_action"], "fda")
            self.assertIs(it["valid"], True)
            self.assertEqual(items[-1]["title"], "Safari needs Full Disk Access")  # below the results
            self.assertNotIn("Safari needs Full Disk Access", self.titles("web", "github"))
            b = self.find(self.items("browsers", "", index=False), "Safari")
            self.assertIn("Needs Full Disk Access", b["subtitle"])
        finally:
            os.chmod(s, 0o755)

    def test_unreadable_safari_files(self):
        s = os.path.join(self.root, "Library", "Safari")
        os.chmod(os.path.join(s, "Bookmarks.plist"), 0)
        os.chmod(os.path.join(s, "History.db"), 0)
        self.assertIn("Safari needs Full Disk Access", self.titles("web", ""))

    def test_no_browsers(self):
        shutil.rmtree(os.path.join(self.root, "Library"))
        self.assertEqual(self.titles("web", "x"), ["No browser data found"])

    def test_missing_index_says_indexing(self):
        data = json.loads(self.js(["web", "x"]))
        self.assertEqual(data["items"][0]["title"], "Couldn’t index your browsers")  # the spawn is off in tests
        os.makedirs(os.path.join(self.cache, "index.lock"))
        write(os.path.join(self.cache, "index.lock", "pid"), str(os.getpid()))
        # a live owner that isn't the indexer: the lock is stale
        data = json.loads(self.js(["web", "x"]))
        self.assertEqual(data["items"][0]["title"], "Couldn’t index your browsers")


# ---------- index ----------

class IndexTests(Base):
    def test_temp_copies_are_removed(self):
        self.index()
        files = self.cache_files()
        self.assertFalse([f for f in files if f.startswith(("tmp-", "index.tmp"))], files)
        self.assertIn("index.sqlite", files)
        self.assertIn("state.json", files)

    def test_locked_database_is_read_through_a_copy(self):
        path = self.A("Google", "Chrome", "Default", "History")
        db = sqlite3.connect(path)
        db.execute("PRAGMA locking_mode=EXCLUSIVE")
        db.execute("BEGIN EXCLUSIVE")
        try:
            self.assertIn("Daily News", self.titles("web", "daily"))
        finally:
            db.rollback()
            db.close()

    def test_source_files_are_never_modified(self):
        paths = [self.A("Google", "Chrome", "Default", "History"), self.A("Google", "Chrome", "Default", "Bookmarks"),
                 os.path.join(self.root, "Library", "Safari", "History.db")]
        before = [(os.stat(p).st_mtime_ns, os.stat(p).st_size) for p in paths]
        listing = sorted(os.listdir(self.A("Google", "Chrome", "Default")))
        self.index()
        self.assertEqual(before, [(os.stat(p).st_mtime_ns, os.stat(p).st_size) for p in paths])
        self.assertEqual(listing, sorted(os.listdir(self.A("Google", "Chrome", "Default"))))  # no -shm/-journal left

    def test_bookmark_changes_are_picked_up(self):
        self.assertNotIn("New Bookmark", self.titles("web", "new"))
        p = self.A("Google", "Chrome", "Default", "Bookmarks")
        write(p, chrome_bookmarks([("New Bookmark", "https://new.example/")]))
        os.utime(p, (time.time() + 5, time.time() + 5))
        self.index(force=False)
        self.assertIn("New Bookmark", self.titles("web", "new", index=False))
        self.assertNotIn("Python Docs", self.titles("web", "python", index=False))

    def test_history_is_throttled_unless_forced(self):
        self.index()
        make_chrome_history(self.A("Google", "Chrome", "Default", "History2"), [])
        db = sqlite3.connect(self.A("Google", "Chrome", "Default", "History"))
        db.execute("INSERT INTO urls(url, title, visit_count, last_visit_time) VALUES('https://fresh.example/', 'Fresh Page', 1, ?)", (chrome_time(NOW),))
        db.commit()
        db.close()
        self.index(force=False)
        self.assertNotIn("Fresh Page", self.titles("web", "fresh", index=False))
        self.index(force=False, BH_TEST_NOW=NOW + 200)
        self.assertIn("Fresh Page", self.titles("web", "fresh", index=False))

    def test_refresh_action_forces(self):
        self.index()
        db = sqlite3.connect(self.A("Google", "Chrome", "Default", "History"))
        db.execute("INSERT INTO urls(url, title, visit_count, last_visit_time) VALUES('https://forced.example/', 'Forced Page', 1, ?)", (chrome_time(NOW),))
        db.commit()
        db.close()
        self.assertEqual(self.action("", bh_action="refresh"), "Refreshed the index")
        self.assertIn("Forced Page", self.titles("web", "forced", index=False))

    def test_excluded_browsers(self):
        self.index()
        # immediately, before the index is rebuilt
        t = self.titles("web", "github", index=False, excluded_browsers=" Chrome , safari")
        it = [i for i in self.items("web", "github", index=False, excluded_browsers="Chrome, safari") if "github" in i["arg"]][0]
        self.assertNotIn("Chrome", it["subtitle"])
        self.assertNotIn("Python Docs", self.titles("web", "python", index=False, excluded_browsers="Chrome"))
        self.assertTrue(t)
        # then the copies are deleted
        self.index(excluded_browsers="Chrome, safari")
        state = json.load(open(os.path.join(self.cache, "state.json")))
        self.assertFalse([s for s in state["sources"] if s["browser"] in ("chrome", "safari")])
        self.assertEqual(len([f for f in self.cache_files() if f.startswith("src-")]), len(state["sources"]))

    def test_exclude_one_profile(self):
        t = self.titles("web", "invoice", excluded_browsers="Chrome/Work")
        self.assertNotIn("Invoices", t)
        self.assertIn("Python Docs", self.titles("web", "python", excluded_browsers="Chrome/Work"))
        self.assertIn("Python Docs", self.titles("web", "python", excluded_browsers="Google Chrome Beta, chromebeta"))

    def test_everything_excluded(self):
        t = self.titles("web", "x", excluded_browsers="chrome,brave,opera,firefox,zen,safari")
        self.assertEqual(t, ["No browser data found"])

    def test_history_can_be_turned_off(self):
        for v in ("0", " 0 ", "false"):
            t = self.titles("web", "", index_history=v)
            self.assertIn("Python Docs", t)
            self.assertNotIn("Daily News", t, v)
            self.assertNotIn("Only In The WAL", t)
        self.assertEqual(self.titles("hist", "", index_history="0"), ["History isn’t indexed"])
        self.assertIn("Daily News", self.titles("web", "", index_history="1"))
        self.assertIn("Daily News", self.titles("web", "", index_history=""))  # empty = default (on)

    def test_history_limit(self):
        rows = [(f"https://many.example/{i}", f"Many {i}", 1, 1000 + i) for i in range(150)]
        make_chrome_history(self.A("Google", "Chrome Beta", "Default", "History"), rows)
        t = self.titles("hist", "@chromebeta many", history_limit="100")
        self.assertEqual(len(t), 50)
        state_rows = [s for s in json.load(open(os.path.join(self.cache, "state.json")))["sources"] if s["browser"] == "chromebeta"][0]["h"]
        self.assertEqual(state_rows, 100)
        for v in ("junk", "", "-5"):
            self.index(history_limit=v)
            s = [s for s in json.load(open(os.path.join(self.cache, "state.json")))["sources"] if s["browser"] == "chromebeta"][0]
            self.assertEqual(s["h"], 150, v)

    def test_clear_index(self):
        self.index()
        self.assertTrue([f for f in self.cache_files() if f.startswith("src-")])
        self.assertEqual(self.action("", bh_action="clear"), "Cleared the index")
        left = [f for f in self.cache_files() if f not in ("gen",)]
        self.assertEqual(left, [])
        data = json.loads(self.js(["web", "x"]))
        self.assertEqual(data["items"][0]["title"], "Couldn’t index your browsers")

    def test_indexer_started_before_clear_discards_its_work(self):
        # simulate: the generation changes while an indexer runs
        self.index()
        write(os.path.join(self.cache, "gen"), "old")
        self.action("", bh_action="clear")
        self.assertNotIn("index.sqlite", self.cache_files())

    def test_stale_tmp_copies_are_pruned(self):
        d = os.path.join(self.cache, "tmp-99999-1")
        os.makedirs(d)
        write(os.path.join(d, "History"), b"x")
        os.utime(d, (NOW - 4000, NOW - 4000))
        self.index()
        self.assertNotIn("tmp-99999-1", self.cache_files())

    def test_corrupt_database(self):
        write(self.A("Google", "Chrome", "Profile 1", "History"), b"not a database at all" * 100)
        t = self.titles("web", "invoices")
        self.assertIn("Invoices", t)  # bookmarks still indexed
        b = self.find(self.items("browsers", "", index=False), "Google Chrome · Work")
        self.assertIn("1 bookmark", b["subtitle"])

    def test_background_indexer(self):
        env = self.env({})
        env.pop("BH_TEST_NO_SPAWN")
        out = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "./browserhub.js", "web", "github"], cwd=SRC, env=env, capture_output=True, text=True)
        data = json.loads(out.stdout)
        self.assertEqual(data["items"][0]["title"], "Indexing your browsers…")
        self.assertEqual(data["rerun"], 0.5)
        for _ in range(100):
            if "state.json" in self.cache_files() and "index.lock" not in self.cache_files():
                break
            time.sleep(0.2)
        out = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "./browserhub.js", "web", "github"], cwd=SRC, env=env, capture_output=True, text=True)
        self.assertEqual(json.loads(out.stdout)["items"][0]["title"], "GitHub")

    def test_large_index_performance(self):
        rows = [(f"https://site{i % 997}.example/page/{i}", f"Page number {i} about topic {i % 50}", i % 30, 100 + i) for i in range(60000)]
        os.remove(self.A("Google", "Chrome", "Profile 1", "History"))
        make_chrome_history(self.A("Google", "Chrome", "Profile 1", "History"), rows)
        self.index()
        timings = []
        for q in ("", "topic 7", "page number", "site12", "@work topic", "zzzz"):
            t0 = time.time()
            self.sf("web", q, index=False)
            timings.append(time.time() - t0)
        print("\n  keystroke timings (60k pages):", ", ".join(f"{t * 1000:.0f} ms" for t in timings))
        self.assertLess(max(timings), 1.5)


# ---------- profiles ----------

class ProfileTests(Base):
    def test_lists_profiles(self):
        items = self.items("prof", "", index=False)
        titles = [i["title"] for i in items]
        self.assertEqual(titles[:2], ["Personal", "Work"])
        self.assertIn("default-release", titles)
        self.assertIn("default", titles)
        self.assertIn("Default (release)", titles)  # Zen
        self.assertNotIn("Outside", titles)  # outside the test root
        self.assertNotIn("System Profile", titles)
        self.assertNotIn("Opera", " ".join(titles))  # not installed
        p = self.find(items, "Personal")
        self.assertEqual(p["subtitle"], "Google Chrome · me@example.com · default")
        self.assertTrue(p["icon"]["path"].endswith("Default/Google Profile Picture.png"))
        w = self.find(items, "Work")
        self.assertEqual(w["icon"], {"type": "fileicon", "path": "/Applications/Google Chrome.app"})
        self.assertEqual(w["variables"], {"bh_action": "launch", "bh_url": "", "bh_browser": "chrome", "bh_profile": "Profile 1"})
        self.assertIs(w["mods"]["cmd"]["valid"], False)
        ff = [i for i in items if i["subtitle"].startswith("Firefox")]
        self.assertEqual(ff[0]["title"], "default-release")  # the Install section's default first

    def test_filter_and_url(self):
        items = self.items("prof", "work https://example.com/a", index=False)
        self.assertEqual([i["title"] for i in items], ["Work"])
        self.assertEqual(items[0]["mods"]["cmd"]["variables"]["bh_url"], "https://example.com/a")
        self.assertEqual(self.titles("prof", "firefox release", index=False), ["default-release"])
        self.assertEqual(self.titles("prof", "zzz", index=False), ["No profile matches “zzz”"])

    def test_clipboard_url(self):
        set_pasteboard("  https://copied.example/x  ")
        it = self.find(self.items("prof", "", index=False), "Work")
        self.assertEqual(it["arg"], "https://copied.example/x")
        self.assertEqual(it["mods"]["cmd"]["variables"]["bh_url"], "https://copied.example/x")
        set_pasteboard("not a url")
        self.assertIs(self.find(self.items("prof", "", index=False), "Work")["mods"]["cmd"]["valid"], False)

    def test_actions(self):
        base = dict(bh_browser="chrome", bh_profile="Profile 1")
        self.assertEqual(self.action("", bh_action="launch", **base), 'open ["-n","-b","com.google.Chrome","--args","--profile-directory=Profile 1"]')
        self.assertEqual(self.action("https://x.example/", bh_action="open", bh_url="https://x.example/", **base),
                         'open ["-n","-b","com.google.Chrome","--args","--profile-directory=Profile 1","https://x.example/"]')
        self.assertEqual(self.action("", bh_action="private", bh_url="https://x.example/", **base),
                         'open ["-n","-b","com.google.Chrome","--args","--profile-directory=Profile 1","--incognito","https://x.example/"]')
        self.assertEqual(self.action("", bh_action="open", bh_url="https://x.example/", bh_browser="firefox", bh_profile="default-release"),
                         'open ["-n","-b","org.mozilla.firefox","--args","-P","default-release","https://x.example/"]')
        self.assertEqual(self.action("", bh_action="open", bh_url="https://x.example/", bh_browser="safari", bh_profile=""),
                         'open ["-b","com.apple.Safari","https://x.example/"]')
        self.assertEqual(self.action("", bh_action="open", bh_url="https://x.example/", bh_browser="", bh_profile=""), 'open ["https://x.example/"]')
        self.assertEqual(self.action("", bh_action="open", bh_url="https://x.example/", bh_browser="edge"), "Couldn’t open Microsoft Edge: it isn’t installed")
        self.assertEqual(self.action("", bh_action="open", bh_url="javascript:alert(1)", bh_browser=""), "Couldn’t open it: no link")
        # a profile name that looks like a flag stays one argument
        self.assertEqual(self.action("", bh_action="launch", bh_browser="firefox", bh_profile="--foo; rm -rf ~"),
                         'open ["-n","-b","org.mozilla.firefox","--args","-P","--foo; rm -rf ~"]')

    def test_no_profiles(self):
        self.apps = {}
        self.assertEqual(self.titles("prof", "", index=False), ["No browser profiles found"])


# ---------- open in ----------

class OpenInTests(Base):
    def test_typed_url(self):
        data = self.sf("openin", "https://example.com/a?b=1", index=False)
        items = data["items"]
        self.assertEqual(items[0]["title"], "Open example.com/a?b=1 in…")
        titles = [i["title"] for i in items[1:]]
        self.assertEqual(titles[0], "Safari")  # the default browser first
        self.assertIn("Google Chrome", titles)
        self.assertIn("Chrome · Work", titles)
        self.assertIn("Firefox · default-release", titles)
        self.assertNotIn("Zen · Default (release)", titles)  # one profile: just the browser
        w = self.find(items, "Chrome · Work")
        self.assertEqual(w["variables"], {"bh_action": "open", "bh_browser": "chrome", "bh_profile": "Profile 1", "bh_url": "https://example.com/a?b=1"})
        self.assertEqual(w["mods"]["cmd"]["variables"]["bh_action"], "private")
        self.assertIs(self.find(items, "Safari")["mods"]["cmd"]["valid"], False)
        self.assertNotIn("variables", data)  # a typed URL isn't remembered

    def test_universal_action_bare_domain_and_filter(self):
        items = self.items("openin", "example.com fire", index=False)
        self.assertEqual(items[0]["title"], "Open example.com in…")
        self.assertEqual([i["title"] for i in items[1:]], ["Firefox", "Firefox · default-release", "Firefox · default"])
        self.assertEqual(items[1]["arg"], "https://example.com")

    def test_front_browser_url(self):
        data = self.sf("openin", "", index=False, BH_TEST_FRONT="com.google.Chrome\thttps://front.example/tab")
        self.assertEqual(data["items"][0]["title"], "Open front.example/tab in…")
        self.assertEqual(data["items"][0]["subtitle"], "From Google Chrome")
        self.assertEqual(data["variables"], {"bh_front_url": "https://front.example/tab", "bh_front_from": "From Google Chrome"})
        # the next run in the same session uses the remembered URL (not the frontmost app again)
        data = self.sf("openin", "saf", index=False, BH_TEST_FRONT="", bh_front_url="https://front.example/tab", bh_front_from="From Google Chrome")
        self.assertEqual(data["items"][0]["title"], "Open front.example/tab in…")
        self.assertEqual([i["title"] for i in data["items"][1:]], ["Safari"])

    def test_clipboard_fallback(self):
        set_pasteboard("https://clip.example/")
        data = self.sf("openin", "", index=False)
        self.assertEqual(data["items"][0]["title"], "Open clip.example in…")
        self.assertEqual(data["items"][0]["subtitle"], "From the clipboard")
        self.assertEqual(data["variables"]["bh_front_url"], "-")
        data = self.sf("openin", "", index=False, bh_front_url="-", bh_front_from="")
        self.assertEqual(data["items"][0]["subtitle"], "From the clipboard")

    def test_no_url(self):
        set_pasteboard("hello world")
        items = self.items("openin", "", index=False)
        self.assertEqual(items[0]["title"], "No link to open")
        c = self.find(items, "Google Chrome")
        self.assertEqual(c["variables"]["bh_action"], "launch")

    def test_choose_action_jumps_to_open_in(self):
        self.assertEqual(self.action("https://x.example/", bh_action="choose", bh_url="https://x.example/"), 'alfred "openin https://x.example/"')
        self.assertEqual(self.action("https://x.example/", bh_action="choose", bh_url="https://x.example/", keyword_openin="  "), 'alfred "openin https://x.example/"')
        self.assertEqual(self.action("https://x.example/", bh_action="choose", bh_url="https://x.example/", keyword_openin="oi"), 'alfred "oi https://x.example/"')

    def test_non_urls_are_rejected(self):
        for q in ("javascript:alert(1)", "file with spaces", "mailto:a@b.c"):
            items = self.items("openin", q, index=False)
            self.assertEqual(items[0]["title"], "No link to open", q)


# ---------- status, actions ----------

class BrowsersTests(Base):
    def test_status_rows(self):
        items = self.items("browsers", "")
        self.assertEqual(items[0]["title"], "Refresh the index")
        self.assertEqual(items[-1]["title"], "Clear the index")
        c = self.find(items, "Google Chrome · Personal")
        self.assertIn("3 bookmarks", c["subtitle"])
        self.assertIn("3 history pages", c["subtitle"])
        self.assertEqual(c["arg"], "web @chrome @personal ")
        self.assertEqual(self.find(items, "Safari")["arg"], "web @safari ")
        self.assertIn("Opera", [i["title"] for i in items])  # data, even without the app
        items = self.items("browsers", "", excluded_browsers="Safari")
        self.assertIn("excluded", self.find(items, "Safari")["subtitle"])
        self.assertEqual(self.action("web @safari ", bh_action="search"), 'alfred "web @safari "')

    def test_copy_and_fda_actions(self):
        self.assertIsNone(self.action_or_none("[a](b)", bh_action="copy"))
        self.assertEqual(read_pasteboard(), "[a](b)")
        self.assertEqual(self.action("", bh_action="fda"), 'open ["x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"]')
        self.assertEqual(self.action("", bh_action="bogus"), "Unknown action: bogus")

    def action_or_none(self, arg, **env):
        out = self.action(arg, **env)
        return out or None


class Audit1Tests(Base):
    """Regression tests for the first audit"""

    def test_selected_text_around_a_link(self):
        items = self.items("openin", "see https://example.com/x today", index=False)
        self.assertEqual(items[0]["title"], "Open example.com/x in…")
        self.assertIn("Google Chrome", [i["title"] for i in items])

    def test_localhost_is_http(self):
        items = self.items("openin", "localhost:3000/app", index=False)
        self.assertEqual(self.find(items, "Safari")["arg"], "http://localhost:3000/app")

    def test_killed_build_leftovers_are_pruned(self):
        for name in ("index.tmp-99999.sql", "index.tmp-99999.sqlite"):
            write(os.path.join(self.cache, name), "private")
            os.utime(os.path.join(self.cache, name), (NOW - 4000, NOW - 4000))
        self.index()
        self.assertFalse([f for f in self.cache_files() if f.startswith("index.tmp")])

    def test_firefox_folder_loop(self):
        path = self.A("Firefox", "Profiles", "xyz.default", "places.sqlite")
        db = sqlite3.connect(path)
        db.execute("INSERT INTO moz_bookmarks(id, type, fk, parent, title, guid) VALUES(50, 2, NULL, 51, 'Loop A', 'loopa'), (51, 2, NULL, 50, 'Loop B', 'loopb')")
        db.execute("INSERT INTO moz_bookmarks(id, type, fk, parent, title, guid) VALUES(52, 2, NULL, 3, 'Deep', 'deep0')")
        for i in range(53, 93):
            db.execute("INSERT INTO moz_bookmarks(id, type, fk, parent, title, guid) VALUES(?, 2, NULL, ?, 'D', ?)", (i, i - 1, "d%d" % i))
        db.execute("INSERT INTO moz_bookmarks(id, type, fk, parent, title, guid) VALUES(99, 1, 1, 60, 'Deep Bookmark', 'deepbm')")
        db.commit()
        db.close()
        t0 = time.time()
        self.assertIn("Deep Bookmark", self.titles("web", "deep bookmark"))
        self.assertLess(time.time() - t0, 30)

    def test_suggestions_dont_repeat_the_browser(self):
        items = self.items("web", "@chrome @")
        self.assertEqual([i["title"] for i in items], ["Chrome · Personal", "Chrome · Work"])
        self.assertEqual(items[1]["autocomplete"], "@chrome @work ")

    def test_profile_name_without_letters(self):
        c = self.A("Google", "Chrome", "Local State")
        write(c, json.dumps({"profile": {"info_cache": {"Default": {"name": "😀"}, "Profile 1": {"name": "Work"}}}}))
        items = self.items("web", "@chrome @")
        it = self.find(items, "Chrome · 😀")
        self.assertEqual(it["autocomplete"], "@chrome @default ")
        self.assertIn("Python Docs", self.titles("web", "@chrome @default python"))

    def test_long_query(self):
        q = " ".join("word%d" % i for i in range(400))
        self.assertTrue(self.titles("web", q)[0].startswith("No bookmarks or history match"))


class RuntimeTests(Base):
    def test_bare_alfred_environment(self):
        """Alfred's runtime: no LANG, bare PATH, cache path with spaces and quotes, fresh install"""
        env = {"HOME": os.environ.get("HOME", "/tmp"), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "BH_TEST_ROOT": self.root,
               "alfred_workflow_cache": os.path.join(self.cache, "new sub"), "BH_TEST_NO_SPAWN": "1", "BH_TEST_NOW": str(NOW),
               "BH_TEST_PASTEBOARD": PASTEBOARD, "BH_TEST_APPS": "com.google.Chrome=/Applications/Google Chrome.app"}
        for args in (["index-now", "force"], ["web", "zürich"], ["bmk", ""], ["hist", ""], ["prof", ""], ["openin", "x.com"], ["browsers", ""]):
            out = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "./browserhub.js", *args], cwd=SRC, env=env, capture_output=True, text=True)
            self.assertEqual(out.returncode, 0, out.stderr)
            if args[0] != "index-now":
                validate(json.loads(out.stdout))
        out = subprocess.run(["/usr/bin/osascript", "-l", "JavaScript", "./browserhub.js", "web", "zürich"], cwd=SRC, env=env, capture_output=True, text=True)
        self.assertEqual(json.loads(out.stdout)["items"][0]["title"], "Zürich Travel Guide")

    def test_sqliterc_is_ignored(self):
        home = os.path.join(self.tmp, "fakehome")
        write(os.path.join(home, ".sqliterc"), ".mode csv\n.headers off\n")
        self.assertIn("GitHub", self.titles("web", "github", HOME=home))

    def test_unknown_command(self):
        self.assertEqual(self.titles("nope", "", index=False), ["Unknown command: nope"])

    def test_info_plist(self):
        subprocess.run(["/usr/bin/python3", os.path.join(ROOT, "tools", "build.py"), "--check"], check=True, capture_output=True)
        with open(os.path.join(SRC, "info.plist"), "rb") as f:
            info = plistlib.load(f)
        self.assertEqual(info["bundleid"], "io.github.x-o-r-r-o.browserhub")
        cfg = {c["variable"]: c for c in info["userconfigurationconfig"]}
        filters = [o for o in info["objects"] if o["type"] == "alfred.workflow.input.scriptfilter"]
        self.assertEqual(len(filters), 6)
        taken = set("aitext anc ask audio bright case dev diff dls enc epoch font fredo gcal gdoc goo gtask gws hash hist icon img json jwt layout lin linact logo m365 media meet mic models nadd new nnew notes obb obd obm obn obs obv onenote outlook pomo race regex res shot ssh stock teams tldr tomd tra track trh uuid vid warp ytt".split())
        for o in filters:
            kw = o["config"]["keyword"]
            var = kw[5:-1]
            self.assertTrue(kw.startswith("{var:keyword_"), kw)
            default = cfg[var]["config"]["default"]
            self.assertGreaterEqual(len(default), 3)
            self.assertNotIn(default, taken)
            self.assertFalse(default.startswith(("bu", "brew")))
            mods = sorted(c["modifiers"] for c in info["connections"][o["uid"]])
            self.assertEqual(len(mods), 4)  # ↩, ⌘, ⌥, ⌃
        search = [o for o in filters if "browserhub.js web" in o["config"]["script"]][0]
        self.assertEqual(search["config"]["argumenttrimmode"], 1)  # "@chrome " keeps its space
        ua = [o for o in info["objects"] if o["type"] == "alfred.workflow.trigger.universalaction"][0]
        self.assertTrue(ua["config"]["acceptsurls"])
        self.assertIn("## Usage", info["readme"])
        import re
        with open(os.path.join(SRC, "browserhub.js"), encoding="utf-8") as f:
            js = f.read()
        icons = set(os.listdir(os.path.join(SRC, "icons")))
        used = set(re.findall(r'"(bookmark|history|browser|filter|refresh|clear|lock|info|error|empty|link|profile)"', js))
        used |= set(re.findall(r'icons/([a-z]+)\.png', js)) - {"x"}
        for name in used:
            self.assertIn(name + ".png", icons)

    def test_package_contains_only_src(self):
        subprocess.run(["/usr/bin/python3", os.path.join(ROOT, "tools", "build.py"), "--package"], check=True, capture_output=True)
        import zipfile
        with open(os.path.join(ROOT, "workflow.json")) as f:
            version = json.load(f)["version"]
        z = zipfile.ZipFile(os.path.join(ROOT, "dist", f"alfred-browser-hub-{version}.alfredworkflow"))
        names = z.namelist()
        self.assertIn("info.plist", names)
        self.assertIn("browserhub.js", names)
        for n in names:
            self.assertTrue(os.path.exists(os.path.join(SRC, n)), n)
            self.assertFalse(n.endswith((".py", ".sqlite", ".json")) and n != "info.plist", n)


if __name__ == "__main__":
    unittest.main()
