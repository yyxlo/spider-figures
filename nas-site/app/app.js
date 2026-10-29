/* 蜘蛛文獻圖片庫：single-page app opened straight from a shared folder (file://).
 *
 * Read side: data/taxa.js (checklist) and data/index.js (all records) are loaded with <script>
 * tags, because fetch() is blocked on file:// pages. Viewing therefore needs no permission.
 *
 * Write side: after the user grants access to the library folder (File System Access API,
 * Edge/Chrome), every record is written as its own JSON file under data/records/<type>/, so
 * two people adding figures at the same time never overwrite each other. data/index.js is
 * then rebuilt from those files.
 */
(function () {
  "use strict";

  /* ================= utilities ================= */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function Raw(s) { this.s = s; }
  function raw(s) { return new Raw(s); }
  // Tagged template: interpolated values are escaped unless wrapped with raw(); arrays are joined.
  function html(strings) {
    var out = strings[0];
    for (var i = 1; i < arguments.length; i++) {
      out += fmt(arguments[i]) + strings[i];
    }
    return raw(out);
  }
  function fmt(v) {
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(fmt).join("");
    if (v === false || v == null) return "";
    return esc(v);
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function debounce(fn, ms) {
    var t;
    return function () {
      var a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, a); }, ms);
    };
  }
  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function filePart(s) {
    return String(s || "x").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 40) || "x";
  }
  function srcPath(p) {
    return p ? p.split("/").map(encodeURIComponent).join("/") : "";
  }
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { /* storage unavailable */ }
    return null;
  }
  function toast(msg, isError) {
    var t = $(".toast");
    t.textContent = msg;
    t.classList.toggle("toast-error", !!isError);
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { t.hidden = true; }, isError ? 7000 : 3000);
  }
  function fmtDate(ms) {
    if (!ms) return "—";
    var d = new Date(ms);
    function p(n) { return (n < 10 ? "0" : "") + n; }
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  }

  /* ================= data model ================= */

  var SEX = [["", "未指定"], ["M", "♂ 雄"], ["F", "♀ 雌"], ["J", "幼體"]];
  var VIEW = [["", "未指定"], ["dorsal", "背面"], ["ventral", "腹面"], ["lateral", "側面"],
    ["prolateral", "前側面"], ["retrolateral", "後側面"], ["frontal", "正面"], ["posterior", "後面"], ["other", "其他"]];
  var DEFAULT_STRUCTURES = [
    ["s-habitus", "整體外觀", "habitus", 10], ["s-prosoma", "頭胸部與眼區", "prosoma / eye region", 20],
    ["s-chelicerae", "螯肢", "chelicerae", 30], ["s-legs", "步足", "legs", 40],
    ["s-opisthosoma", "腹部", "opisthosoma", 50], ["s-spinnerets", "紡器", "spinnerets", 60],
    ["s-palp", "雄觸肢", "male palp", 70], ["s-palp-detail", "觸肢器細部", "palpal sclerites", 80],
    ["s-epigyne", "雌外生殖器", "epigyne", 90], ["s-vulva", "雌內生殖器", "vulva", 100],
    ["s-other", "其他", "other", 900],
  ];
  function label(list, v) {
    for (var i = 0; i < list.length; i++) if (list[i][0] === (v || "")) return list[i][1];
    return v;
  }

  var M = {}; // the in-memory model, rebuilt by buildModel()

  function spName(genus, epithet, sub) {
    return [genus, epithet, sub].filter(Boolean).join(" ");
  }

  function buildModel() {
    var taxa = window.SPIDER_TAXA || { families: {}, genera: {}, species: [] };
    var idx = window.SPIDER_INDEX || { records: [] };
    M = {
      generated: idx.generated || 0,
      records: {},             // id -> record (all types)
      families: new Map(),     // name -> {name, author, zh}
      genera: new Map(),       // name -> {name, family, author, zh}
      species: new Map(),      // name -> {name, genus, epithet, subspecies, author, zh, valid, lsid, record}
      synonyms: new Map(),     // accepted name -> [synonym names]
      figures: new Map(),
      figsBySpecies: new Map(),
      references: new Map(),
      structures: new Map(),
    };
    Object.keys(taxa.families || {}).forEach(function (n) {
      var f = taxa.families[n] || {};
      M.families.set(n, { name: n, author: f.author || "", zh: f.zh || "" });
    });
    Object.keys(taxa.genera || {}).forEach(function (n) {
      var g = taxa.genera[n] || {};
      M.genera.set(n, { name: n, family: g.family || "", author: g.author || "", zh: g.zh || "" });
    });
    (taxa.species || []).forEach(function (row) {
      // [genus, epithet, subspecies, author, lsid, zh, valid]
      var name = spName(row[0], row[1], row[2]);
      M.species.set(name, { name: name, genus: row[0], epithet: row[1], subspecies: row[2] || "",
        author: row[3] || "", lsid: row[4] || "", zh: row[5] || "", valid: row[6] || "" });
    });
    DEFAULT_STRUCTURES.forEach(function (s) {
      M.structures.set(s[0], { id: s[0], name: s[1], name_en: s[2], order: s[3] });
    });
    (idx.records || []).forEach(addRecordToModel);
    finishModel();
  }

  function addRecordToModel(r) {
    M.records[r.id] = r;
    if (r.type === "figure") M.figures.set(r.id, r);
    else if (r.type === "reference") M.references.set(r.id, r);
    else if (r.type === "structure") M.structures.set(r.id, r);
    else if (r.type === "species") {
      var name = spName(r.genus, r.epithet, r.subspecies);
      var base = M.species.get(name) || { name: name, genus: r.genus, epithet: r.epithet,
        subspecies: r.subspecies || "", author: "", lsid: "", zh: "", valid: "" };
      // a species record overrides the checklist entry field by field
      ["author", "zh", "valid"].forEach(function (k) { if (r[k] != null && r[k] !== "") base[k] = r[k]; });
      if (r.valid === "") base.valid = "";
      base.record = r.id;
      M.species.set(name, base);
      if (!M.genera.has(r.genus)) M.genera.set(r.genus, { name: r.genus, family: r.family || "", author: "", zh: "" });
      if (r.family && !M.families.has(r.family)) M.families.set(r.family, { name: r.family, author: "", zh: "" });
    }
  }

  function finishModel() {
    M.synonyms = new Map();
    M.species.forEach(function (s) {
      if (s.valid && s.valid !== s.name && M.species.has(s.valid)) {
        if (!M.synonyms.has(s.valid)) M.synonyms.set(s.valid, []);
        M.synonyms.get(s.valid).push(s.name);
      }
    });
    M.figsBySpecies = new Map();
    M.figures.forEach(function (f) {
      if (!M.species.has(f.species)) {
        // figure under a name missing from the checklist: keep it visible anyway
        var p = f.species.split(" ");
        M.species.set(f.species, { name: f.species, genus: p[0], epithet: p[1] || "", subspecies: p[2] || "",
          author: "", lsid: "", zh: "", valid: "" });
        if (!M.genera.has(p[0])) M.genera.set(p[0], { name: p[0], family: "", author: "", zh: "" });
      }
      if (!M.figsBySpecies.has(f.species)) M.figsBySpecies.set(f.species, []);
      M.figsBySpecies.get(f.species).push(f);
    });
    M.sortedStructures = Array.from(M.structures.values()).sort(function (a, b) {
      return (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name);
    });
  }

  function accepted(name) {
    var s = M.species.get(name);
    return s && s.valid && M.species.has(s.valid) ? s.valid : name;
  }
  function nameGroup(name) {
    var acc = accepted(name);
    return [acc].concat(M.synonyms.get(acc) || []);
  }
  function figureSort(a, b) {
    var sa = M.structures.get(a.structure), sb = M.structures.get(b.structure);
    var oa = sa ? sa.order : 9999, ob = sb ? sb.order : 9999;
    if (oa !== ob) return oa - ob;
    if ((a.sex || "") !== (b.sex || "")) return (a.sex || "z") < (b.sex || "z") ? -1 : 1;
    var ra = M.references.get(a.reference), rb = M.references.get(b.reference);
    var ya = ra ? ra.year : "", yb = rb ? rb.year : "";
    if (ya !== yb) return ya < yb ? -1 : 1;
    return (a.figure_number || "").localeCompare(b.figure_number || "", undefined, { numeric: true });
  }
  function figuresFor(name, filt) {
    var out = [];
    nameGroup(name).forEach(function (n) { (M.figsBySpecies.get(n) || []).forEach(function (f) { out.push(f); }); });
    return applyFilter(out, filt).sort(figureSort);
  }
  function applyFilter(figs, filt) {
    if (!filt) return figs;
    return figs.filter(function (f) {
      return (!filt.structure || f.structure === filt.structure) && (!filt.sex || f.sex === filt.sex);
    });
  }
  function familyOf(genus) {
    var g = M.genera.get(genus);
    return g ? g.family : "";
  }

  /* ----- references ----- */

  var INITIALS = /^(?:[A-ZÀ-Þ][a-zà-ÿ]?\.\s*-?\s*)+$/;
  function shortAuthors(authors) {
    var tokens = String(authors || "").split(/,\s*|\s*&\s*|\s+and\s+|;\s*/);
    var sur = tokens.map(function (t) { return t.trim(); }).filter(function (t) { return t && !INITIALS.test(t); });
    if (!sur.length) return authors || "";
    if (sur.length === 1) return sur[0];
    if (sur.length === 2) return sur[0] + " & " + sur[1];
    return sur[0] + " et al.";
  }
  function refShort(r) { return r ? shortAuthors(r.authors) + " " + r.year : "（文獻已刪除）"; }
  function citation(r) {
    if (!r) return "";
    var s = r.authors + " (" + r.year + "). " + String(r.title || "").replace(/\.$/, "") + ".";
    if (r.journal) {
      s += " " + r.journal;
      if (r.volume) { s += " " + r.volume; if (r.issue) s += "(" + r.issue + ")"; }
      if (r.pages) s += r.volume ? ": " + r.pages : ", " + r.pages;
      s += ".";
    }
    if (r.publisher) s += " " + r.publisher + ".";
    if (r.doi) s += " doi:" + r.doi;
    return s;
  }
  function bibtex(r) {
    var key = (shortAuthors(r.authors).split(" ")[0] + r.year).replace(/[^A-Za-z0-9]/g, "");
    var f = { author: r.authors, year: r.year, title: "{" + r.title + "}", journal: r.journal, volume: r.volume,
      number: r.issue, pages: (r.pages || "").replace(/-/g, "--"), publisher: r.publisher, doi: r.doi, url: r.url };
    var kind = r.publisher && !r.volume ? "book" : "article";
    var body = Object.keys(f).filter(function (k) { return f[k]; }).map(function (k) { return "  " + k + " = {" + f[k] + "}"; });
    return "@" + kind + "{" + key + ",\n" + body.join(",\n") + "\n}";
  }
  function sourceLabel(f) {
    var s = refShort(M.references.get(f.reference));
    if (f.page) s += ": " + f.page;
    if (f.figure_number) s += ", " + f.figure_number;
    return s;
  }

  /* ================= search ================= */

  function searchNames(q, limit) {
    limit = limit || 200;
    q = q.trim().replace(/\s+/g, " ");
    var res = { families: [], genera: [], species: [], fuzzy: false };
    if (!q) return res;
    var lq = q.toLowerCase(), parts = lq.split(" ");
    if (parts.length >= 2) {
      var g = parts[0].replace(/\.$/, "");
      M.species.forEach(function (s) {
        if (res.species.length >= limit) return;
        var hit = s.genus.toLowerCase().indexOf(g) === 0 && s.epithet.toLowerCase().indexOf(parts[1]) === 0 &&
          (!parts[2] || s.subspecies.toLowerCase().indexOf(parts[2]) === 0);
        if (hit || (s.zh && s.zh.indexOf(q) >= 0)) res.species.push(s);
      });
    } else {
      M.families.forEach(function (f) {
        if (f.name.toLowerCase().indexOf(lq) === 0 || (f.zh && f.zh.indexOf(q) >= 0)) res.families.push(f);
      });
      M.genera.forEach(function (g) {
        if (res.genera.length < limit && (g.name.toLowerCase().indexOf(lq) === 0 || (g.zh && g.zh.indexOf(q) >= 0))) res.genera.push(g);
      });
      M.species.forEach(function (s) {
        if (res.species.length < limit && (s.epithet.toLowerCase().indexOf(lq) === 0 || (s.zh && s.zh.indexOf(q) >= 0))) res.species.push(s);
      });
    }
    if (!res.families.length && !res.genera.length && !res.species.length && /[a-z]/i.test(q)) {
      res = fuzzySearch(lq, Math.min(limit, 30));
      res.fuzzy = true;
    }
    var byName = function (a, b) { return a.name.localeCompare(b.name); };
    res.families.sort(byName); res.genera.sort(byName);
    if (!res.fuzzy) res.species.sort(byName);
    return res;
  }

  function trigrams(s) {
    s = "  " + s + " ";
    var set = new Set();
    for (var i = 0; i < s.length - 2; i++) set.add(s.substr(i, 3));
    return set;
  }
  function similarity(a, b) {
    var inter = 0;
    a.forEach(function (t) { if (b.has(t)) inter++; });
    return inter / (a.size + b.size - inter);
  }
  // Misspelling fallback, similar to PostgreSQL pg_trgm similarity()
  function fuzzySearch(q, limit) {
    var qt = trigrams(q), th = 0.3;
    function top(items) {
      return items.map(function (x) { return [similarity(qt, trigrams(x.name.toLowerCase())), x]; })
        .filter(function (p) { return p[0] >= th; })
        .sort(function (a, b) { return b[0] - a[0]; }).slice(0, limit).map(function (p) { return p[1]; });
    }
    return { families: top(Array.from(M.families.values())), genera: top(Array.from(M.genera.values())),
      species: top(Array.from(M.species.values())) };
  }

  function suggest(q, kinds) {
    var r = searchNames(q, 15), items = [];
    if (kinds.indexOf("family") >= 0) r.families.forEach(function (f) {
      items.push({ type: "family", label: f.name, sub: "科 " + f.zh, value: f.name, url: "#/family/" + encodeURIComponent(f.name) });
    });
    if (kinds.indexOf("genus") >= 0) r.genera.forEach(function (g) {
      items.push({ type: "genus", label: g.name, sub: ("屬 · " + g.family + " " + g.zh).trim(), value: g.name, url: "#/genus/" + encodeURIComponent(g.name) });
    });
    if (kinds.indexOf("species") >= 0) r.species.forEach(function (s) {
      var n = (M.figsBySpecies.get(s.name) || []).length;
      var sub = s.valid ? "→ " + s.valid : s.zh;
      if (n) sub = (sub ? sub + " · " : "") + n + " 圖";
      items.push({ type: "species", label: (s.name + " " + s.author).trim(), sub: sub, value: s.name, url: "#/species/" + encodeURIComponent(s.name) });
    });
    return items.slice(0, 30);
  }

  function refSearch(q) {
    var terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return Array.from(M.references.values()).filter(function (r) {
      var hay = [r.authors, r.year, r.title, r.journal, r.doi].join(" ").toLowerCase();
      return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    }).sort(function (a, b) { return (a.authors + a.year).localeCompare(b.authors + b.year); });
  }

  /* ================= folder access (write side) ================= */

  // Path-based wrapper around a FileSystemDirectoryHandle. Tests can replace it with
  // window.__SPIDER_TEST_FS__, which implements the same methods.
  function HandleFS(root) { this.root = root; }
  HandleFS.prototype._dir = async function (parts, create) {
    var d = this.root;
    for (var i = 0; i < parts.length; i++) d = await d.getDirectoryHandle(parts[i], { create: !!create });
    return d;
  };
  HandleFS.prototype._split = function (path) {
    var parts = path.split("/").filter(Boolean);
    return { dir: parts.slice(0, -1), name: parts[parts.length - 1] };
  };
  HandleFS.prototype.list = async function (path) {
    var d = await this._dir(path.split("/").filter(Boolean), true), out = [];
    for await (var entry of d.values()) out.push({ name: entry.name, kind: entry.kind });
    return out;
  };
  HandleFS.prototype.readText = async function (path) {
    var p = this._split(path);
    var fh = await (await this._dir(p.dir)).getFileHandle(p.name);
    return (await fh.getFile()).text();
  };
  HandleFS.prototype.mtime = async function (path) {
    var p = this._split(path);
    var fh = await (await this._dir(p.dir)).getFileHandle(p.name);
    return (await fh.getFile()).lastModified;
  };
  HandleFS.prototype.exists = async function (path) {
    try { await this.mtime(path); return true; } catch (e) { return false; }
  };
  HandleFS.prototype.write = async function (path, data) {
    var p = this._split(path);
    var fh = await (await this._dir(p.dir, true)).getFileHandle(p.name, { create: true });
    var w = await fh.createWritable();
    await w.write(data);
    await w.close();
  };
  HandleFS.prototype.remove = async function (path) {
    var p = this._split(path);
    try { await (await this._dir(p.dir)).removeEntry(p.name); } catch (e) { /* already gone */ }
  };

  var FS = null; // set when connected

  function idbHandle(mode, value) {
    return new Promise(function (resolve) {
      try {
        var open = indexedDB.open("spider-figures", 1);
        open.onupgradeneeded = function () { open.result.createObjectStore("kv"); };
        open.onerror = function () { resolve(null); };
        open.onsuccess = function () {
          var tx = open.result.transaction("kv", mode === "set" ? "readwrite" : "readonly");
          var st = tx.objectStore("kv");
          var req = mode === "set" ? st.put(value, "root") : st.get("root");
          req.onsuccess = function () { resolve(req.result || null); };
          req.onerror = function () { resolve(null); };
        };
      } catch (e) { resolve(null); }
    });
  }

  async function useFolder(fs) {
    var ok = false;
    try { ok = JSON.parse(await fs.readText("data/library.json")).app === "spider-figures"; } catch (e) { ok = false; }
    if (!ok) throw new Error("選擇的資料夾不是蜘蛛文獻圖片庫。請選擇含有 index.html 的那個資料夾本身。");
    FS = fs;
    renderModebar();
    await syncFromDisk(true, true);
  }

  async function connectFolder() {
    if (!window.showDirectoryPicker) {
      toast("這個瀏覽器不支援資料夾存取，請改用 Edge 或 Chrome。", true);
      return false;
    }
    try {
      var handle = await window.showDirectoryPicker({ id: "spider-figures", mode: "readwrite" });
      await useFolder(new HandleFS(handle));
      await idbHandle("set", handle);
      toast("已連接資料夾，可以新增與編輯。");
      return true;
    } catch (e) {
      if (e && e.name === "AbortError") return false;
      toast(e.message || String(e), true);
      return false;
    }
  }

  // Re-use the folder granted last time; the browser may ask the user to confirm with one click.
  async function reconnect(interactive) {
    var handle = await idbHandle("get");
    if (!handle || !handle.queryPermission) return false;
    var perm = await handle.queryPermission({ mode: "readwrite" });
    if (perm !== "granted" && interactive) perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") return false;
    try {
      await useFolder(new HandleFS(handle));
      return true;
    } catch (e) {
      toast(e.message, true);
      return false;
    }
  }

  var RECORD_TYPES = ["figure", "reference", "species", "structure"];

  // Bring the in-memory index up to date with the per-record files on disk.
  // full=true also re-reads files whose modification time changed (edits by others).
  async function syncFromDisk(full, rerender) {
    var current = (window.SPIDER_INDEX && window.SPIDER_INDEX.records) || [];
    var byKey = {};
    current.forEach(function (r) { byKey[r.type + "/" + r.id + ".json"] = r; });
    var next = [], changed = false;
    for (var t = 0; t < RECORD_TYPES.length; t++) {
      var type = RECORD_TYPES[t], dir = "data/records/" + type;
      var entries = (await FS.list(dir)).filter(function (e) {
        return e.kind === "file" && /\.json$/.test(e.name) && e.name[0] !== ".";
      });
      for (var i = 0; i < entries.length; i++) {
        var key = type + "/" + entries[i].name, known = byKey[key], path = dir + "/" + entries[i].name;
        delete byKey[key];
        var mtime = known && !full ? known._mtime : await FS.mtime(path);
        if (known && known._mtime === mtime) { next.push(known); continue; }
        try {
          var rec = JSON.parse(await FS.readText(path));
          rec.type = type;
          rec.id = entries[i].name.replace(/\.json$/, "");
          rec._mtime = mtime;
          next.push(rec);
          changed = true;
        } catch (e) {
          console.warn("無法讀取", path, e);
        }
      }
    }
    if (Object.keys(byKey).length) changed = true; // records deleted by someone else
    if (changed) {
      window.SPIDER_INDEX = { generated: Date.now(), records: next };
      await writeIndex();
      buildModel();
      if (rerender) route();
    }
    return changed;
  }

  async function writeIndex() {
    var idx = window.SPIDER_INDEX;
    idx.generated = Date.now();
    await FS.write("data/index.js", "window.SPIDER_INDEX = " + JSON.stringify(idx) + ";\n");
    M.generated = idx.generated;
  }

  async function saveRecord(rec) {
    if (!FS) throw new Error("尚未連接資料夾");
    rec.updated = Date.now();
    var clean = {};
    Object.keys(rec).forEach(function (k) { if (k !== "_mtime" && k !== "type" && k !== "id") clean[k] = rec[k]; });
    var path = "data/records/" + rec.type + "/" + rec.id + ".json";
    await FS.write(path, JSON.stringify(clean, null, 1));
    rec._mtime = await FS.mtime(path);
    var recs = window.SPIDER_INDEX.records.filter(function (r) { return !(r.type === rec.type && r.id === rec.id); });
    recs.push(rec);
    window.SPIDER_INDEX.records = recs;
  }

  async function deleteRecord(rec) {
    await FS.remove("data/records/" + rec.type + "/" + rec.id + ".json");
    window.SPIDER_INDEX.records = window.SPIDER_INDEX.records.filter(function (r) { return !(r.type === rec.type && r.id === rec.id); });
  }

  // Save changed records, pick up other people's new files, rewrite the index, refresh the view.
  async function commit(records, deleted) {
    for (var i = 0; i < (deleted || []).length; i++) await deleteRecord(deleted[i]);
    for (var j = 0; j < records.length; j++) await saveRecord(records[j]);
    var picked = await syncFromDisk(false);
    if (!picked) {
      await writeIndex();
      buildModel();
    }
  }

  function requireFolder() {
    if (FS) return null;
    return html`<div class="card narrow center">
      <h1>需要連接資料夾</h1>
      <p>新增或編輯資料前，要先授權瀏覽器存取這個圖片庫的資料夾。</p>
      <p class="muted small">在彈出的視窗中，選擇放有 index.html 的那個資料夾本身，再按「選取資料夾」並允許編輯。</p>
      <p><button class="btn" data-action="connect">連接資料夾</button></p>
      ${!window.showDirectoryPicker ? html`<p class="error">這個瀏覽器不支援，請改用 Edge 或 Chrome。</p>` : ""}
    </div>`;
  }

  /* ================= images ================= */

  var THUMB = 360, MEDIUM = 1400;

  async function derivative(blob, size) {
    var bmp = await createImageBitmap(blob);
    var scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
    var w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    var c = document.createElement("canvas");
    c.width = w; c.height = h;
    var ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    return new Promise(function (resolve, reject) {
      c.toBlob(function (b) { b ? resolve(b) : reject(new Error("無法產生縮圖")); }, "image/jpeg", 0.88);
    });
  }

  async function storeImages(file, genus, epithet, id) {
    var ext = (file.name.match(/\.[A-Za-z0-9]+$/) || [".png"])[0].toLowerCase();
    if (ext === ".jpeg") ext = ".jpg";
    var base = filePart(genus) + "/" + filePart(epithet) + "_" + id;
    var files = {
      original: "images/original/" + base + ext,
      medium: "images/medium/" + base + ".jpg",
      thumb: "images/thumb/" + base + ".jpg",
    };
    var medium = await derivative(file, MEDIUM); // also validates that the file is a readable image
    var thumb = await derivative(file, THUMB);
    await FS.write(files.original, file);
    await FS.write(files.medium, medium);
    await FS.write(files.thumb, thumb);
    return files;
  }

  /* ================= CSV checklist import ================= */

  var ALIASES = {
    family: ["family", "familyname", "family_name"],
    genus: ["genus", "genusname", "genus_name"],
    species: ["species", "epithet", "specificepithet", "species_epithet", "speciesname", "species_name"],
    subspecies: ["subspecies", "infraspecificepithet", "subspecies_epithet"],
    author: ["author", "authors", "authorship", "scientificnameauthorship", "species_author"],
    year: ["year", "species_year", "namepublishedinyear"],
    parens: ["parens", "parentheses", "brackets"],
    lsid: ["species_lsid", "speciesid_lsid", "lsid", "taxonid", "taxon_id"],
    zh: ["common_name", "vernacularname", "chinese_name", "中文名"],
    rank: ["taxonrank", "rank"],
    status: ["taxonomicstatus", "status"],
  };
  var FIELD_LABEL = { family: "科（必要）", genus: "屬（必要）", species: "種小名（必要）", subspecies: "亞種名",
    author: "命名者", year: "年份", parens: "是否加括號", lsid: "LSID", zh: "中文名", rank: "分類階層", status: "分類狀態" };
  function normHeader(h) { return String(h || "").trim().toLowerCase().replace(/[\s_\-]+/g, ""); }

  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    var first = text.split(/\r?\n/, 1)[0];
    var delim = [",", "\t", ";", "|"].sort(function (a, b) { return first.split(b).length - first.split(a).length; })[0];
    var rows = [], row = [], field = "", inQ = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (inQ) {
        if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += c;
      } else if (c === '"') inQ = true;
      else if (c === delim) { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0] !== "") rows.push(row);
        row = [];
      } else field += c;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return { header: rows.shift() || [], rows: rows, delim: delim };
  }

  function detectMapping(header) {
    var byNorm = {}, map = {};
    header.forEach(function (h, i) { byNorm[normHeader(h)] = i; });
    Object.keys(ALIASES).forEach(function (f) {
      for (var i = 0; i < ALIASES[f].length; i++) {
        var k = normHeader(ALIASES[f][i]);
        if (k in byNorm) { map[f] = byNorm[k]; break; }
      }
    });
    return map;
  }

  function formatAuthor(author, year, parens) {
    if (!author) return "";
    var t = author;
    if (year && author.indexOf(year) < 0) t = author + ", " + year;
    if (/^(1|true|yes|y)$/i.test(parens || "") && t[0] !== "(") t = "(" + t + ")";
    return t;
  }

  function buildTaxa(csv, map, onlyFamilies, mergeWith) {
    var taxa = mergeWith ? JSON.parse(JSON.stringify(mergeWith)) : { families: {}, genera: {}, species: [] };
    var index = {};
    taxa.species.forEach(function (row, i) { index[spName(row[0], row[1], row[2])] = i; });
    var stats = { rows: 0, added: 0, updated: 0, skipped: 0 };
    function get(row, f) { return map[f] == null ? "" : String(row[map[f]] || "").trim(); }
    csv.rows.forEach(function (row) {
      stats.rows++;
      if (map.rank != null && ["species", "subspecies"].indexOf(get(row, "rank").toLowerCase()) < 0) { stats.skipped++; return; }
      if (map.status != null && ["", "accepted", "valid", "accepted name"].indexOf(get(row, "status").toLowerCase()) < 0) { stats.skipped++; return; }
      var fam = get(row, "family"), gen = get(row, "genus"), ep = get(row, "species").toLowerCase();
      if (!fam || !gen || !ep) { stats.skipped++; return; }
      if (onlyFamilies.length && onlyFamilies.indexOf(fam.toLowerCase()) < 0) { stats.skipped++; return; }
      if (!taxa.families[fam]) taxa.families[fam] = {};
      if (!taxa.genera[gen]) taxa.genera[gen] = { family: fam };
      var sub = get(row, "subspecies").toLowerCase();
      var entry = [gen, ep, sub, formatAuthor(get(row, "author"), get(row, "year"), get(row, "parens")), get(row, "lsid"), get(row, "zh"), ""];
      var name = spName(gen, ep, sub);
      if (name in index) {
        var old = taxa.species[index[name]];
        entry[5] = entry[5] || old[5] || "";
        entry[6] = old[6] || "";
        taxa.species[index[name]] = entry;
        stats.updated++;
      } else {
        index[name] = taxa.species.length;
        taxa.species.push(entry);
        stats.added++;
      }
    });
    return { taxa: taxa, stats: stats };
  }

  /* ================= router & pages ================= */

  var app = document.getElementById("app");

  function parseHash() {
    var h = location.hash.replace(/^#/, "") || "/";
    var qi = h.indexOf("?");
    var path = qi >= 0 ? h.slice(0, qi) : h;
    var params = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : "");
    return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), params: params };
  }
  function go(hash) { location.hash = hash; }
  function hashWith(params) {
    var r = parseHash(), p = new URLSearchParams(r.params);
    Object.keys(params).forEach(function (k) { if (params[k]) p.set(k, params[k]); else p.delete(k); });
    var qs = p.toString();
    return "#/" + r.parts.map(encodeURIComponent).join("/") + (qs ? "?" + qs : "");
  }

  var dirty = false; // unsaved form on screen
  window.addEventListener("beforeunload", function (e) { if (dirty) { e.preventDefault(); e.returnValue = ""; } });

  function route() {
    var r = parseHash(), p = r.parts, page;
    try {
      if (!p.length) page = pageHome();
      else if (p[0] === "search") page = pageSearch(r.params.get("q") || "");
      else if (p[0] === "taxa") page = pageTaxa();
      else if (p[0] === "family") page = pageFamily(p[1], r.params);
      else if (p[0] === "genus") page = pageGenus(p[1], r.params);
      else if (p[0] === "species" && p[1] === "new") page = pageSpeciesForm(null, r.params);
      else if (p[0] === "species" && p[2] === "edit") page = pageSpeciesForm(p[1], r.params);
      else if (p[0] === "species") page = pageSpecies(p[1], r.params);
      else if (p[0] === "compare") page = pageCompare(r.params);
      else if (p[0] === "figure" && p[2] === "edit") page = pageFigureEdit(p[1]);
      else if (p[0] === "figure") page = pageFigure(p[1]);
      else if (p[0] === "references") page = pageReferences(r.params.get("q") || "");
      else if (p[0] === "reference" && p[1] === "new") page = pageReferenceForm(null, r.params);
      else if (p[0] === "reference" && p[2] === "edit") page = pageReferenceForm(p[1], r.params);
      else if (p[0] === "reference") page = pageReference(p[1]);
      else if (p[0] === "add") page = pageAdd(r.params);
      else if (p[0] === "settings") page = pageSettings();
      else page = html`<p class="empty">找不到頁面。<a href="#/">回首頁</a></p>`;
    } catch (e) {
      console.error(e);
      page = html`<p class="error">頁面發生錯誤：${e.message}</p>`;
    }
    dirty = false;
    lastHash = location.hash;
    app.innerHTML = page.s;
    window.scrollTo(0, 0);
    afterRender();
  }
  var lastHash = location.hash, skipNext = false;
  window.addEventListener("hashchange", function () {
    if (skipNext) { skipNext = false; return; }
    if (dirty && !confirm("有尚未儲存的資料，確定離開這一頁？")) {
      skipNext = true;
      location.hash = lastHash;
      return;
    }
    lastHash = location.hash;
    route();
  });

  function renderModebar() {
    var bar = $("[data-modebar]");
    if (FS) {
      bar.className = "modebar modebar-on";
      bar.innerHTML = html`已連接資料夾：可以新增與編輯。 <span class="muted">資料更新：${fmtDate(M.generated)}</span>`.s;
    } else {
      bar.className = "modebar";
      bar.innerHTML = html`瀏覽模式。要新增或編輯資料，請
        <button class="linkbtn" data-action="connect">連接資料夾</button>。
        <span class="muted">資料更新：${fmtDate(M.generated)}（其他人新增的圖，重新整理頁面後才會出現）</span>`.s;
    }
  }

  /* ----- shared fragments ----- */

  function figCard(f, opts) {
    opts = opts || {};
    var st = M.structures.get(f.structure), sp = M.species.get(f.species);
    var cap = [f.species, f.sex ? label(SEX, f.sex) : "", st ? "· " + st.name : "", f.view ? "· " + label(VIEW, f.view) : "", "— " + sourceLabel(f)].join(" ");
    return html`<figure class="fig-card">
      <a href="${srcPath(f.files.medium)}" class="lb" data-group="${opts.group || "all"}" data-caption="${cap}"
         data-detail="#/figure/${f.id}" data-original="${srcPath(f.files.original)}">
        <img src="${srcPath(f.files.thumb)}" alt="${f.species} ${sourceLabel(f)}" loading="lazy">
      </a>
      <figcaption>
        ${opts.showSpecies ? html`<a class="sp" href="#/species/${encodeURIComponent(f.species)}"><i>${f.species}</i></a>` : ""}
        ${!opts.showSpecies && sp && sp.valid ? html`<span class="tag tag-syn" title="文獻中使用的名稱">as <i>${f.species}</i></span>` : ""}
        <span class="meta">${f.sex ? html`<span class="sex sex-${f.sex}">${label(SEX, f.sex)}</span>` : ""}
          ${opts.showStructure && st ? st.name : ""} ${f.view ? html`<span class="muted">${label(VIEW, f.view)}</span>` : ""}</span>
        <a class="src" href="#/figure/${f.id}">${sourceLabel(f)}</a>
      </figcaption>
    </figure>`;
  }

  function filters(params, extra) {
    var s = params.get("structure") || "", x = params.get("sex") || "";
    return html`<div class="filters">
      <label>構造 <select data-filter="structure"><option value="">全部</option>
        ${M.sortedStructures.map(function (st) { return html`<option value="${st.id}" ${st.id === s ? raw("selected") : ""}>${st.name}</option>`; })}
      </select></label>
      <label>性別 <select data-filter="sex"><option value="">全部</option>
        ${SEX.slice(1).map(function (o) { return html`<option value="${o[0]}" ${o[0] === x ? raw("selected") : ""}>${o[1]}</option>`; })}
      </select></label>${extra || ""}</div>`;
  }
  function filtOf(params) { return { structure: params.get("structure") || "", sex: params.get("sex") || "" }; }

  function speciesLink(name) {
    var s = M.species.get(name);
    return html`<a href="#/species/${encodeURIComponent(name)}"><i>${name}</i></a>${s && s.author ? " " + s.author : ""}`;
  }

  function opts(list, val) {
    return list.map(function (o) { return html`<option value="${o[0]}" ${o[0] === (val || "") ? raw("selected") : ""}>${o[1]}</option>`; });
  }
  function structureOpts(val) {
    return [html`<option value="">（未指定）</option>`].concat(M.sortedStructures.map(function (s) {
      return html`<option value="${s.id}" ${s.id === val ? raw("selected") : ""}>${s.name}${s.name_en ? "（" + s.name_en + "）" : ""}</option>`;
    }));
  }
  function acWidget(kind, name, value, placeholder) {
    var lbl = "";
    if (value && kind === "species") { var s = M.species.get(value); lbl = s ? (s.name + " " + s.author).trim() : value; }
    if (value && kind === "reference") { var r = M.references.get(value); lbl = r ? refShort(r) + ". " + r.title : ""; }
    return html`<div class="ac-widget" data-kind="${kind}">
      <input type="hidden" name="${name}" value="${value || ""}">
      <input type="text" class="ac-input" value="${lbl}" placeholder="${placeholder || ""}" autocomplete="off">
      <div class="ac-list" hidden></div></div>`;
  }

  /* ----- pages ----- */

  function pageHome() {
    var figs = Array.from(M.figures.values());
    var recent = figs.slice().sort(function (a, b) { return (b.created || 0) - (a.created || 0); }).slice(0, 12);
    var famCount = {};
    figs.forEach(function (f) { var fam = familyOf(M.species.get(f.species).genus) || "（未分科）"; famCount[fam] = (famCount[fam] || 0) + 1; });
    var spWithFig = new Set(figs.map(function (f) { return accepted(f.species); })).size;
    return html`<section class="hero">
      <h1>查詢物種，直接比對文獻圖</h1>
      <form class="bigsearch" data-search-form>
        <input type="search" name="q" placeholder="例如 Araneus、Araneus ventricosus、Argiope 或中文名" autocomplete="off" data-search-box>
        <div class="ac-list" hidden></div>
        <button class="btn">搜尋</button>
      </form>
      <p class="stats">名錄 ${M.families.size} 科 · ${M.genera.size} 屬 · ${M.species.size} 種名　｜
        已收錄 <b>${figs.length}</b> 張圖、${spWithFig} 個物種、${M.references.size} 篇文獻</p>
    </section>
    ${Object.keys(famCount).length ? html`<section><h2>已有圖片的科</h2><ul class="chips">
      ${Object.keys(famCount).sort().map(function (f) {
        var fam = M.families.get(f);
        return html`<li><a href="#/family/${encodeURIComponent(f)}">${f}${fam && fam.zh ? " " + fam.zh : ""} <span class="muted">${famCount[f]}</span></a></li>`;
      })}</ul></section>` : ""}
    <section><h2>最近新增</h2>
      ${recent.length ? html`<div class="fig-grid">${recent.map(function (f) { return figCard(f, { showSpecies: 1, showStructure: 1, group: "recent" }); })}</div>`
        : html`<p class="empty">還沒有圖片。<a href="#/add">新增第一張</a>${!M.species.size ? html`，或先到<a href="#/settings">設定</a>匯入名錄` : ""}。</p>`}
    </section>`;
  }

  function pageSearch(q) {
    var r = searchNames(q);
    var total = r.families.length + r.genera.length + r.species.length;
    if (total === 1 && !r.fuzzy) {
      var one = r.families[0] ? "#/family/" + encodeURIComponent(r.families[0].name)
        : r.genera[0] ? "#/genus/" + encodeURIComponent(r.genera[0].name) : "#/species/" + encodeURIComponent(r.species[0].name);
      setTimeout(function () { location.replace(one); }, 0);
    }
    return html`<h1>搜尋「${q}」</h1>
      ${r.fuzzy && total ? html`<p class="note">沒有完全符合的名稱，以下是拼寫相近的結果。</p>` : ""}
      ${!total ? html`<p class="empty">找不到符合的名稱。<a href="#/species/new">新增物種名</a></p>` : ""}
      ${r.families.length ? html`<h2>科</h2><ul class="list">${r.families.map(function (f) {
        return html`<li><a href="#/family/${encodeURIComponent(f.name)}"><b>${f.name}</b></a> ${f.author} ${f.zh}</li>`; })}</ul>` : ""}
      ${r.genera.length ? html`<h2>屬</h2><ul class="list">${r.genera.map(function (g) {
        return html`<li><a href="#/genus/${encodeURIComponent(g.name)}"><i><b>${g.name}</b></i></a> ${g.author} ${g.zh} <span class="muted">· ${g.family}</span></li>`; })}</ul>` : ""}
      ${r.species.length ? html`<h2>種</h2><ul class="list">${r.species.map(function (s) {
        var n = figuresFor(s.name).length;
        return html`<li>${speciesLink(s.name)} ${s.zh}
          ${s.valid ? html`<span class="tag tag-syn">→ <i>${s.valid}</i></span>` : ""}
          <span class="muted">· ${familyOf(s.genus)}</span> ${n ? html`<span class="badge">${n} 圖</span>` : ""}</li>`; })}</ul>` : ""}`;
  }

  function figCountByGenus() {
    var c = {};
    M.figures.forEach(function (f) { var g = M.species.get(accepted(f.species)).genus; c[g] = (c[g] || 0) + 1; });
    return c;
  }

  function pageTaxa() {
    var byGenus = figCountByGenus(), fams = {};
    M.genera.forEach(function (g) {
      var f = g.family || "（未分科）";
      fams[f] = fams[f] || { genera: 0, figs: 0 };
      fams[f].genera++;
      fams[f].figs += byGenus[g.name] || 0;
    });
    var names = Object.keys(fams).sort();
    return html`<h1>分類瀏覽</h1><table class="table">
      <thead><tr><th>科</th><th>中文名</th><th class="num">屬數</th><th class="num">圖片數</th></tr></thead><tbody>
      ${names.length ? names.map(function (f) {
        var fam = M.families.get(f) || {};
        return html`<tr class="${fams[f].figs ? "" : "dim"}"><td><a href="#/family/${encodeURIComponent(f)}">${f}</a> <span class="muted">${fam.author || ""}</span></td>
          <td>${fam.zh || ""}</td><td class="num">${fams[f].genera}</td><td class="num">${fams[f].figs}</td></tr>`;
      }) : html`<tr><td colspan="4" class="empty">名錄是空的，請到<a href="#/settings">設定</a>匯入名錄，或直接<a href="#/species/new">新增物種名</a>。</td></tr>`}
      </tbody></table>`;
  }

  function pageFamily(name, params) {
    var fam = M.families.get(name) || { name: name, author: "", zh: "" };
    var byGenus = figCountByGenus(), all = params.get("all") === "1";
    var gens = Array.from(M.genera.values()).filter(function (g) { return (g.family || "（未分科）") === name; })
      .filter(function (g) { return all || byGenus[g.name]; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    var nValid = {};
    M.species.forEach(function (s) { if (!s.valid) nValid[s.genus] = (nValid[s.genus] || 0) + 1; });
    return html`<p class="crumbs"><a href="#/taxa">分類瀏覽</a> › ${name}</p>
      <h1>${name} <small>${fam.author} ${fam.zh}</small></h1>
      <p>${all ? html`顯示全部屬 · <a href="${hashWith({ all: "" })}">只顯示有圖片的屬</a>` : html`只顯示有圖片的屬 · <a href="${hashWith({ all: "1" })}">顯示全部屬</a>`}</p>
      <table class="table"><thead><tr><th>屬</th><th>中文名</th><th class="num">有效種數</th><th class="num">圖片數</th></tr></thead><tbody>
      ${gens.length ? gens.map(function (g) {
        return html`<tr class="${byGenus[g.name] ? "" : "dim"}"><td><a href="#/genus/${encodeURIComponent(g.name)}"><i>${g.name}</i></a> <span class="muted">${g.author}</span></td>
          <td>${g.zh}</td><td class="num">${nValid[g.name] || 0}</td><td class="num">${byGenus[g.name] || 0}</td></tr>`;
      }) : html`<tr><td colspan="4" class="empty">此科還沒有圖片。<a href="${hashWith({ all: "1" })}">顯示全部屬</a></td></tr>`}
      </tbody></table>`;
  }

  function pageGenus(name, params) {
    var g = M.genera.get(name) || { name: name, family: "", author: "", zh: "" };
    var filt = filtOf(params), showEmpty = params.get("empty") === "1";
    var groups = new Map();
    M.figures.forEach(function (f) {
      var sp = M.species.get(f.species), acc = accepted(f.species);
      if (sp.genus !== name && M.species.get(acc).genus !== name) return;
      if (!applyFilter([f], filt).length) return;
      if (!groups.has(acc)) groups.set(acc, []);
      groups.get(acc).push(f);
    });
    var valid = Array.from(M.species.values()).filter(function (s) { return s.genus === name && !s.valid; })
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    var rows = [];
    valid.forEach(function (s) {
      var figs = groups.get(s.name) || [];
      groups.delete(s.name);
      if (figs.length || showEmpty) rows.push({ name: s.name, figs: figs });
    });
    groups.forEach(function (figs, acc) { rows.push({ name: acc, figs: figs }); }); // synonyms whose valid name is elsewhere
    rows.forEach(function (r) { r.figs.sort(figureSort); });
    return html`<p class="crumbs"><a href="#/taxa">分類瀏覽</a> › <a href="#/family/${encodeURIComponent(g.family || "（未分科）")}">${g.family || "（未分科）"}</a> › <i>${name}</i></p>
      <h1><i>${name}</i> <small>${g.author} ${g.zh}</small></h1>
      <div class="toolbar">${filters(params)}
        <span class="muted">名錄中 ${valid.length} 個有效種 ·
        ${showEmpty ? html`<a href="${hashWith({ empty: "" })}">隱藏沒有圖的種</a>` : html`<a href="${hashWith({ empty: "1" })}">顯示沒有圖的種</a>`}</span></div>
      <form data-genus-compare>
        <p class="muted small">勾選物種後按「並排比較」。</p>
        ${rows.length ? rows.map(function (r) {
          var s = M.species.get(r.name);
          return html`<section class="sp-row"><h2>
            <label class="cmp-check"><input type="checkbox" value="${r.name}"></label>
            <a href="#/species/${encodeURIComponent(r.name)}"><i>${r.name}</i></a>
            <small>${s.author} ${s.zh}</small><span class="muted small">${r.figs.length} 圖</span></h2>
            ${r.figs.length ? html`<div class="fig-strip">${r.figs.map(function (f) { return figCard(f, { showStructure: 1, group: r.name }); })}</div>`
              : html`<p class="empty small">尚無圖片 · <a href="#/add?species=${encodeURIComponent(r.name)}">新增</a></p>`}
          </section>`;
        }) : html`<p class="empty">這個條件下沒有圖片。</p>`}
        ${rows.length ? html`<div class="sticky-bar"><button class="btn" type="submit">並排比較勾選的物種</button></div>` : ""}
      </form>`;
  }

  function pageSpecies(name, params) {
    if (!M.species.has(name)) return html`<p class="empty">名錄中沒有 <i>${name}</i>。<a href="#/species/new">新增物種名</a></p>`;
    var sp = M.species.get(name), acc = accepted(name), a = M.species.get(acc), g = M.genera.get(a.genus) || {};
    var figs = figuresFor(acc, filtOf(params)), sections = [], bySt = {};
    figs.forEach(function (f) {
      var k = f.structure || "";
      if (!bySt[k]) { bySt[k] = []; sections.push(k); }
      bySt[k].push(f);
    });
    var syns = M.synonyms.get(acc) || [];
    var fam = g.family || "（未分科）";
    return html`<p class="crumbs"><a href="#/taxa">分類瀏覽</a> › <a href="#/family/${encodeURIComponent(fam)}">${fam}</a> › <a href="#/genus/${encodeURIComponent(a.genus)}"><i>${a.genus}</i></a> › <i>${acc}</i></p>
      ${sp.valid ? html`<p class="note"><i>${name}</i> ${sp.author} 是 ${speciesLink(acc)} 的同物異名或舊組合，以下顯示有效名下的所有圖片。</p>` : ""}
      <h1><i>${acc}</i> <small>${a.author} ${a.zh}</small></h1>
      ${syns.length ? html`<p class="muted">文獻中也使用過：${syns.map(function (s, i) {
        return html`${i ? "；" : ""}<a href="#/species/${encodeURIComponent(s)}"><i>${s}</i></a> ${M.species.get(s).author}`; })}</p>` : ""}
      <div class="toolbar">${filters(params)}
        <span class="actions">
          <button type="button" class="btn-small" data-compare-add="${acc}">加入比較清單</button>
          <a class="btn-small" href="#/add?species=${encodeURIComponent(name)}">新增此種的圖</a>
          <a class="btn-small" href="#/species/${encodeURIComponent(name)}/edit">編輯名稱資訊</a>
          ${a.lsid ? html`<span class="muted small">LSID ${a.lsid}</span>` : ""}
        </span></div>
      <p class="muted small">共 ${figs.length} 張圖</p>
      ${sections.length ? sections.map(function (k) {
        var st = M.structures.get(k);
        return html`<section><h2 class="section-h">${st ? html`${st.name} <small>${st.name_en}</small>` : "未分類"}</h2>
          <div class="fig-grid">${bySt[k].map(function (f) { return figCard(f, { group: "sp" }); })}</div></section>`;
      }) : html`<p class="empty">還沒有圖片。<a href="#/add?species=${encodeURIComponent(name)}">新增</a></p>`}`;
  }

  function compareIds(params) {
    return (params.get("sp") || "").split("|").filter(function (n) { return n && M.species.has(n); })
      .filter(function (n, i, a) { return a.indexOf(n) === i; });
  }

  function pageCompare(params) {
    var ids = compareIds(params), filt = filtOf(params);
    setBasket(ids);
    return html`<h1>並排比較</h1>
      <div class="toolbar">${filters(params)}
        <div class="cmp-add">${acWidget("species", "add_species", "", "加入物種…")}</div>
        ${ids.length ? html`<a class="btn-small" href="${hashWith({ sp: "" })}">清空</a>` : ""}</div>
      ${!ids.length ? html`<p class="empty">從上方加入物種，或在屬頁勾選物種、在物種頁按「加入比較清單」。</p>` : html`
      <p class="muted small">在圖上滾動滑鼠滾輪可放大，拖曳移動，雙擊放大或還原。</p>
      <div class="cmp-grid" style="--cols: ${ids.length}">${ids.map(function (n) {
        var figs = figuresFor(n, filt);
        var others = ids.filter(function (x) { return x !== n; }).join("|");
        return html`<div class="cmp-col"><div class="cmp-head"><a href="#/species/${encodeURIComponent(n)}"><i>${accepted(n)}</i></a>
          <a class="cmp-remove" title="移除" href="${hashWith({ sp: others })}">×</a></div>
          ${figs.length ? figs.map(function (f) {
            var st = M.structures.get(f.structure), sp = M.species.get(f.species);
            return html`<div class="cmp-item"><div class="zoom-box"><img src="${srcPath(f.files.medium)}" alt="" draggable="false"></div>
              <div class="cmp-cap">${f.sex ? html`<span class="sex sex-${f.sex}">${label(SEX, f.sex)}</span>` : ""} ${st ? st.name : ""}${f.view ? " " + label(VIEW, f.view) : ""}
              <a href="#/figure/${f.id}">${sourceLabel(f)}</a>${sp.valid ? html` <span class="tag tag-syn">as <i>${f.species}</i></span>` : ""}</div></div>`;
          }) : html`<p class="empty small">此條件下沒有圖</p>`}</div>`;
      })}</div>`}`;
  }

  function pageFigure(id) {
    var f = M.figures.get(id);
    if (!f) return html`<p class="empty">找不到這張圖（可能已被刪除）。</p>`;
    var r = M.references.get(f.reference), st = M.structures.get(f.structure), sp = M.species.get(f.species), acc = accepted(f.species);
    return html`<p class="crumbs"><a href="#/species/${encodeURIComponent(acc)}"><i>${acc}</i></a> › 圖片</p>
      <div class="fig-detail">
        <div class="zoom-box big"><img src="${srcPath(f.files.medium)}" alt="" draggable="false"></div>
        <aside class="card"><h1><i>${f.species}</i></h1>
          ${sp.valid ? html`<p class="note">現行有效名：${speciesLink(acc)}</p>` : ""}
          <dl class="kv"><dt>出處</dt><dd>${sourceLabel(f)}</dd>
            <dt>構造</dt><dd>${st ? st.name : "—"}</dd><dt>性別</dt><dd>${label(SEX, f.sex)}</dd>
            <dt>視角</dt><dd>${label(VIEW, f.view)}</dd>
            ${f.notes ? html`<dt>備註</dt><dd class="pre">${f.notes}</dd>` : ""}
            <dt>新增</dt><dd>${f.by || "—"} · ${fmtDate(f.created)}</dd></dl>
          <h2>文獻</h2><p class="citation">${r ? html`<a href="#/reference/${r.id}">${citation(r)}</a>` : "（文獻已刪除）"}</p>
          ${r && r.doi ? html`<p><a href="https://doi.org/${encodeURI(r.doi)}" target="_blank" rel="noopener">開啟 DOI</a></p>` : ""}
          <p><a href="${srcPath(f.files.original)}" target="_blank">原始檔</a></p>
          <p class="actions"><a class="btn-small" href="#/figure/${f.id}/edit">編輯</a>
            <button class="btn-small danger" data-action="delete-figure" data-id="${f.id}">刪除</button></p>
        </aside></div>`;
  }

  function pageFigureEdit(id) {
    var f = M.figures.get(id);
    if (!f) return html`<p class="empty">找不到這張圖。</p>`;
    var need = requireFolder();
    if (need) return need;
    return html`<h1>編輯圖片資訊</h1><img src="${srcPath(f.files.thumb)}" class="preview" alt="">
      <form class="card form" data-form="figure-edit" data-id="${f.id}">
        <div><label>物種（圖上使用的名稱）</label>${acWidget("species", "species", f.species)}</div>
        <div><label>出處文獻</label>${acWidget("reference", "reference", f.reference)}</div>
        <div class="grid4">
          <label>圖號<input type="text" name="figure_number" value="${f.figure_number || ""}"></label>
          <label>頁碼<input type="text" name="page" value="${f.page || ""}"></label>
          <label>構造<select name="structure">${structureOpts(f.structure)}</select></label>
          <label>性別<select name="sex">${opts(SEX, f.sex)}</select></label>
          <label>視角<select name="view">${opts(VIEW, f.view)}</select></label>
        </div>
        <div><label>備註</label><textarea name="notes" rows="2">${f.notes || ""}</textarea></div>
        <button class="btn" type="submit">儲存</button> <a href="#/figure/${f.id}">取消</a>
      </form>`;
  }

  function pageReferences(q) {
    var refs = q ? refSearch(q) : Array.from(M.references.values()).sort(function (a, b) { return (a.authors + a.year).localeCompare(b.authors + b.year); });
    var counts = {};
    M.figures.forEach(function (f) { counts[f.reference] = (counts[f.reference] || 0) + 1; });
    return html`<h1>文獻</h1><div class="toolbar">
      <form class="inline" data-ref-search><input type="search" name="q" value="${q}" placeholder="作者、年份、標題、DOI"> <button class="btn-small">搜尋</button></form>
      <a class="btn-small" href="#/reference/new">新增文獻</a></div>
      <table class="table"><thead><tr><th>文獻</th><th class="num">圖片數</th></tr></thead><tbody>
      ${refs.length ? refs.map(function (r) {
        return html`<tr><td><a href="#/reference/${r.id}">${citation(r)}</a></td><td class="num">${counts[r.id] || 0}</td></tr>`;
      }) : html`<tr><td colspan="2" class="empty">沒有文獻。</td></tr>`}</tbody></table>`;
  }

  function pageReference(id) {
    var r = M.references.get(id);
    if (!r) return html`<p class="empty">找不到這篇文獻。</p>`;
    var bySp = {}, order = [];
    Array.from(M.figures.values()).filter(function (f) { return f.reference === id; }).sort(function (a, b) {
      return a.species.localeCompare(b.species) || figureSort(a, b);
    }).forEach(function (f) {
      if (!bySp[f.species]) { bySp[f.species] = []; order.push(f.species); }
      bySp[f.species].push(f);
    });
    return html`<p class="crumbs"><a href="#/references">文獻</a> › ${refShort(r)}</p><h1>${refShort(r)}</h1>
      <div class="card"><p class="citation" id="cite">${citation(r)}</p>
        <p class="actions"><button type="button" class="btn-small" data-copy="cite">複製引用</button>
          <button type="button" class="btn-small" data-copy="bibtex">複製 BibTeX</button>
          ${r.doi ? html`<a class="btn-small" href="https://doi.org/${encodeURI(r.doi)}" target="_blank" rel="noopener">DOI</a>` : ""}
          ${r.url ? html`<a class="btn-small" href="${r.url}" target="_blank" rel="noopener">網址</a>` : ""}
          <a class="btn-small" href="#/reference/${r.id}/edit">編輯</a>
          <a class="btn-small" href="#/add?reference=${r.id}">從此文獻新增圖片</a>
          ${!order.length ? html`<button class="btn-small danger" data-action="delete-reference" data-id="${r.id}">刪除文獻</button>` : ""}</p>
        <pre class="bibtex" id="bibtex" hidden>${bibtex(r)}</pre>
        ${r.notes ? html`<p class="muted pre">${r.notes}</p>` : ""}</div>
      ${order.length ? order.map(function (n) {
        return html`<section><h2>${speciesLink(n)}</h2><div class="fig-grid">${bySp[n].map(function (f) { return figCard(f, { showStructure: 1, group: "ref" }); })}</div></section>`;
      }) : html`<p class="empty">此文獻還沒有圖片。</p>`}`;
  }

  var REF_FIELDS = [["authors", "作者", "例如 Ono, H. & Ogata, K.", 1], ["year", "年份", "允許 2009a、2009b", 1],
    ["title", "標題", "", 1], ["journal", "期刊或書名", ""], ["volume", "卷", ""], ["issue", "期", ""], ["pages", "頁碼", "例如 1-23"],
    ["publisher", "出版者", "書籍才需填寫"], ["doi", "DOI", "例如 10.11646/zootaxa.1234.1.1"], ["url", "網址", ""], ["notes", "備註", ""]];

  function refFields(r, prefix) {
    r = r || {};
    return REF_FIELDS.map(function (f) {
      var nm = (prefix || "") + f[0];
      var input = f[0] === "title" || f[0] === "notes"
        ? html`<textarea name="${nm}" rows="2">${r[f[0]] || ""}</textarea>`
        : html`<input type="text" name="${nm}" value="${r[f[0]] || ""}">`;
      return html`<div><label>${f[1]}${f[3] ? html` <span class="req">*</span>` : ""}</label>${input}${f[2] ? html`<span class="helptext">${f[2]}</span>` : ""}</div>`;
    });
  }
  function readRefFields(form, prefix) {
    var r = {};
    REF_FIELDS.forEach(function (f) { r[f[0]] = (form.elements[(prefix || "") + f[0]].value || "").trim(); });
    return r;
  }
  function refMissing(r) {
    return REF_FIELDS.filter(function (f) { return f[3] && !r[f[0]]; }).map(function (f) { return f[1]; });
  }

  function pageReferenceForm(id, params) {
    var need = requireFolder();
    if (need) return need;
    var r = id ? M.references.get(id) : null;
    return html`<h1>${r ? "編輯文獻" : "新增文獻"}</h1>
      <form class="card form" data-form="reference" data-id="${id || ""}" data-next="${params.get("next") || ""}">
        ${refFields(r)}<button class="btn" type="submit">儲存</button></form>`;
  }

  function pageSpeciesForm(name, params) {
    var need = requireFolder();
    if (need) return need;
    var s = name ? M.species.get(name) : null;
    if (name && !s) return html`<p class="empty">找不到 <i>${name}</i>。</p>`;
    var fams = Array.from(M.families.keys()).sort();
    return html`<h1>${s ? html`編輯名稱資訊：<i>${s.name}</i>` : "新增物種名"}</h1>
      ${!s ? html`<p class="muted">名錄中找不到時才需要新增，例如文獻使用的舊名、同物異名或尚未匯入的種。</p>` : ""}
      <form class="card form" data-form="species" data-name="${name || ""}" data-next="${params.get("next") || ""}">
        ${s ? "" : html`
        <div><label>屬名 <span class="req">*</span></label><input type="text" name="genus" value="${params.get("genus") || ""}"></div>
        <div><label>科（新增屬時需要）</label><input type="text" name="family" list="family-list" placeholder="例如 Araneidae">
          <datalist id="family-list">${fams.map(function (f) { return html`<option value="${f}">`; })}</datalist></div>
        <div><label>種小名 <span class="req">*</span></label><input type="text" name="epithet"></div>
        <div><label>亞種名</label><input type="text" name="subspecies"></div>`}
        <div><label>命名者與年代</label><input type="text" name="author" value="${s ? s.author : ""}" placeholder="例如 (Thorell, 1890)"></div>
        <div><label>中文名</label><input type="text" name="zh" value="${s ? s.zh : ""}"></div>
        <div><label>有效名（若此名為同物異名或舊組合）</label>${acWidget("species", "valid", s ? s.valid : "", "若是有效名請留空")}
          <span class="helptext">設定後，這個名稱下的圖會同時顯示在有效名的頁面。</span></div>
        <button class="btn" type="submit">儲存</button></form>`;
  }

  function pageAdd(params) {
    var need = requireFolder();
    if (need) return need;
    return html`<h1>新增文獻圖片</h1>
      <p class="muted">同一次新增的圖片共用相同的物種與文獻。可以拖放圖片檔，也可以在這個頁面直接按 <kbd>Ctrl</kbd>+<kbd>V</kbd> 貼上從 PDF 截取的圖。</p>
      <form class="card form" data-form="add">
        <fieldset><legend>1. 物種</legend>
          ${acWidget("species", "species", params.get("species") || "", "輸入學名或中文名，例如 Araneus ventricosus")}
          <p class="small muted">請選擇文獻圖上使用的名稱（舊名也可以）。名錄中找不到？<a href="#/species/new">新增物種名</a></p></fieldset>
        <fieldset><legend>2. 出處文獻</legend>
          ${acWidget("reference", "reference", params.get("reference") || "", "輸入作者、年份或標題")}
          <label class="check"><input type="checkbox" name="new_reference" data-toggle="new-ref"> 這是新文獻，在下面填寫</label>
          <div id="new-ref" class="subform" hidden>${refFields(null, "ref_")}</div></fieldset>
        <fieldset><legend>3. 圖片</legend>
          <div class="dropzone" data-dropzone><input type="file" accept="image/*" multiple>
            <p>把圖片拖到這裡、點擊選擇檔案，或按 Ctrl+V 貼上截圖</p></div>
          <div class="grid4 defaults"><span class="muted small">預設值（套用到之後加入的圖）：</span>
            <label>構造<select name="d_structure">${structureOpts("")}</select></label>
            <label>性別<select name="d_sex">${opts(SEX, "")}</select></label>
            <label>視角<select name="d_view">${opts(VIEW, "")}</select></label>
            <label>頁碼<input type="text" name="d_page"></label></div>
          <table class="table batch" hidden><thead><tr><th>圖</th><th>圖號</th><th>頁碼</th><th>構造</th><th>性別</th><th>視角</th><th>備註</th><th></th></tr></thead><tbody></tbody></table>
        </fieldset>
        <p><button class="btn" type="submit">儲存到圖片庫</button> <span class="muted small" data-progress></span></p>
      </form>`;
  }

  function pageSettings() {
    var user = store("spiderfig.user") || "";
    var custom = M.sortedStructures;
    return html`<h1>設定</h1>
      <section class="card"><h2>資料夾連接</h2>
        ${FS ? html`<p>已連接，可以新增與編輯。</p>` : html`<p>目前是瀏覽模式。</p><p><button class="btn" data-action="connect">連接資料夾</button></p>`}
        <p class="muted small">資料更新時間：${fmtDate(M.generated)}。共 ${M.figures.size} 張圖、${M.references.size} 篇文獻。</p>
        ${FS ? html`<p><button class="btn-small" data-action="rebuild">重新掃描並重建索引</button>
          <span class="muted small">其他人修改過的資料沒有出現時使用。</span></p>` : ""}</section>
      <section class="card"><h2>你的名字</h2>
        <p class="muted small">記錄在你新增的圖片上，方便日後知道是誰加的。只存在這台電腦的瀏覽器裡。</p>
        <form class="inline" data-form="user"><input type="text" name="user" value="${user}" placeholder="例如 王小明"> <button class="btn-small">儲存</button></form></section>
      <section class="card"><h2>匯入名錄（CSV / TSV）</h2>
        <p class="muted small">例如 World Spider Catalog 的匯出檔。會依欄位名稱自動對應；同名的種會更新，不會重複。已設定的中文名與同物異名會保留。</p>
        ${requireFolder() ? html`<p class="muted">需要先連接資料夾。</p>` : html`
        <p><input type="file" accept=".csv,.tsv,.txt" data-taxa-file></p><div data-taxa-preview></div>`}</section>
      <section class="card"><h2>構造類別</h2>
        <table class="table"><thead><tr><th>名稱</th><th>英文</th><th class="num">排序</th></tr></thead><tbody>
        ${custom.map(function (s) { return html`<tr><td>${s.name}</td><td>${s.name_en}</td><td class="num">${s.order}</td></tr>`; })}</tbody></table>
        ${FS ? html`<form class="inline" data-form="structure"><input type="text" name="name" placeholder="新類別名稱" required>
          <input type="text" name="name_en" placeholder="英文（選填）"> <input type="number" name="order" value="500" style="width:6em">
          <button class="btn-small">新增類別</button></form>` : ""}</section>`;
  }

  /* ================= behaviours after render ================= */

  var TYPE_LABEL = { family: "科", genus: "屬", species: "種" };

  function attachAutocomplete(input, list, o) {
    var items = [], active = -1;
    function render() {
      list.innerHTML = items.map(function (it, i) {
        return html`<div class="ac-item ${i === active ? "active" : ""}" data-type="${it.type || ""}" data-i="${i}">
          ${it.type ? html`<span class="ac-type">${TYPE_LABEL[it.type]}</span>` : ""}<span class="ac-label">${it.label}</span>
          ${it.sub ? html`<span class="ac-sub">${it.sub}</span>` : ""}</div>`.s;
      }).join("");
      list.hidden = !items.length;
    }
    function pick(i) { if (items[i]) { list.hidden = true; o.onPick(items[i]); } }
    list.addEventListener("mousedown", function (e) {
      var row = e.target.closest(".ac-item");
      if (row) { e.preventDefault(); pick(+row.dataset.i); }
    });
    var update = debounce(function () {
      var q = input.value.trim();
      items = q.length < 2 ? [] : o.source(q);
      active = -1;
      render();
    }, 120);
    input.addEventListener("input", function () { if (o.onType) o.onType(); update(); });
    input.addEventListener("keydown", function (e) {
      if (list.hidden) return;
      if (e.key === "ArrowDown") { active = Math.min(active + 1, items.length - 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
      else if (e.key === "Enter" && active >= 0) { pick(active); e.preventDefault(); }
      else if (e.key === "Escape") list.hidden = true;
    });
    input.addEventListener("blur", function () { setTimeout(function () { list.hidden = true; }, 150); });
  }

  function setupSearchBoxes(root) {
    $$("[data-search-box]", root).forEach(function (input) {
      if (input._ac) return;
      input._ac = true;
      attachAutocomplete(input, input.parentNode.querySelector(".ac-list"), {
        source: function (q) { return suggest(q, ["family", "genus", "species"]); },
        onPick: function (it) { input.value = ""; go(it.url); },
      });
    });
    $$("[data-search-form]", root).forEach(function (form) {
      if (form._bound) return;
      form._bound = true;
      form.addEventListener("submit", function (e) {
        e.preventDefault();
        var q = form.elements.q.value.trim();
        if (q) go("#/search?q=" + encodeURIComponent(q));
      });
    });
  }

  function setupWidgets(root) {
    $$(".ac-widget", root).forEach(function (w) {
      var hidden = w.querySelector("input[type=hidden]"), input = w.querySelector(".ac-input");
      var kind = w.dataset.kind;
      attachAutocomplete(input, w.querySelector(".ac-list"), {
        source: kind === "reference"
          ? function (q) { return refSearch(q).slice(0, 20).map(function (r) { return { label: refShort(r) + ". " + r.title, value: r.id, sub: r.journal }; }); }
          : function (q) { return suggest(q, ["species"]); },
        onType: function () { hidden.value = ""; },
        onPick: function (it) {
          hidden.value = it.value;
          input.value = it.label;
          hidden.dispatchEvent(new Event("change", { bubbles: true }));
        },
      });
    });
  }

  function afterRender() {
    setupSearchBoxes(app);
    setupWidgets(app);
    $$(".zoom-box", app).forEach(function (box) { var img = box.querySelector("img"); if (img) PanZoom(box, img); });
    $$("[data-filter]", app).forEach(function (sel) {
      sel.addEventListener("change", function () { var o = {}; o[sel.dataset.filter] = sel.value; go(hashWith(o)); });
    });
    $$("[data-toggle]", app).forEach(function (cb) {
      cb.addEventListener("change", function () { document.getElementById(cb.dataset.toggle).hidden = !cb.checked; });
    });
    $$("[data-compare-add]", app).forEach(setupCompareButton);
    var gc = $("[data-genus-compare]", app);
    if (gc) gc.addEventListener("submit", function (e) {
      e.preventDefault();
      var picked = $$("input[type=checkbox]:checked", gc).map(function (c) { return c.value; });
      if (!picked.length) { toast("請先勾選物種"); return; }
      var r = parseHash();
      go("#/compare?" + new URLSearchParams({ sp: picked.join("|"), structure: r.params.get("structure") || "", sex: r.params.get("sex") || "" }));
    });
    var cmp = $(".cmp-add input[type=hidden]", app);
    if (cmp) cmp.addEventListener("change", function () {
      var ids = compareIds(parseHash().params);
      if (ids.indexOf(cmp.value) < 0) ids.push(cmp.value);
      go(hashWith({ sp: ids.join("|") }));
    });
    var rs = $("[data-ref-search]", app);
    if (rs) rs.addEventListener("submit", function (e) { e.preventDefault(); go("#/references?q=" + encodeURIComponent(rs.elements.q.value.trim())); });
    $$("[data-copy]", app).forEach(function (btn) {
      btn.addEventListener("click", function () { copyText(document.getElementById(btn.dataset.copy).textContent.trim(), btn); });
    });
    var form = $("form[data-form]:not([data-form=user]):not([data-form=structure])", app);
    if (form) {
      form.addEventListener("input", function () { dirty = true; });
      form.addEventListener("submit", function (e) { e.preventDefault(); submitForm(form); });
      if (form.dataset.form === "add") setupAddForm(form);
    }
    var tf = $("[data-taxa-file]", app);
    if (tf) tf.addEventListener("change", function () { if (tf.files[0]) previewTaxa(tf.files[0]); });
    var uf = $("form[data-form=user]", app);
    if (uf) uf.addEventListener("submit", function (e) {
      e.preventDefault(); store("spiderfig.user", uf.elements.user.value.trim()); toast("已儲存");
    });
    var sf = $("form[data-form=structure]", app);
    if (sf) sf.addEventListener("submit", function (e) { e.preventDefault(); submitForm(sf); });
    renderModebar();
  }

  document.addEventListener("click", function (e) {
    var a = e.target.closest("[data-action]");
    if (!a) return;
    var act = a.dataset.action;
    if (act === "connect") {
      e.preventDefault();
      reconnect(true).then(function (ok) { return ok || connectFolder(); }).then(function (ok) { if (ok) route(); });
    } else if (act === "rebuild") {
      busy(a, syncFromDisk(true, true).then(function (ch) { if (!ch) writeIndex().then(renderModebar); toast(ch ? "已更新索引" : "資料已是最新"); }));
    } else if (act === "delete-figure") {
      if (!FS) { toast("請先連接資料夾", true); return; }
      var f = M.figures.get(a.dataset.id);
      if (!f || !confirm("確定刪除這張圖？圖片檔也會一併刪除。")) return;
      var sp = accepted(f.species);
      busy(a, Promise.all(["original", "medium", "thumb"].map(function (k) { return FS.remove(f.files[k]); }))
        .then(function () { return commit([], [f]); })
        .then(function () { toast("已刪除"); go("#/species/" + encodeURIComponent(sp)); }));
    } else if (act === "delete-reference") {
      if (!FS) { toast("請先連接資料夾", true); return; }
      var r = M.references.get(a.dataset.id);
      if (!r || !confirm("確定刪除這篇文獻？")) return;
      busy(a, commit([], [r]).then(function () { toast("已刪除"); go("#/references"); }));
    } else if (act === "remove-row") {
      var tr = a.closest("tr");
      if (tr._item) addItems.splice(addItems.indexOf(tr._item), 1);
      tr.remove();
      if (!addItems.length) $(".batch", app).hidden = true;
    }
  });

  function busy(el, promise) {
    el.disabled = true;
    return promise.catch(function (err) { console.error(err); toast("發生錯誤：" + (err.message || err), true); })
      .finally(function () { el.disabled = false; });
  }

  function copyText(text, btn) {
    var done = function () { var t = btn.textContent; btn.textContent = "已複製"; setTimeout(function () { btn.textContent = t; }, 1500); };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, function () { fallback(); });
    else fallback();
    function fallback() {
      var ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
      document.body.removeChild(ta);
    }
  }

  /* ----- add figures ----- */

  var addItems = [];

  function setupAddForm(form) {
    addItems = [];
    var dz = $("[data-dropzone]", form), input = dz.querySelector("input[type=file]"), tbody = $(".batch tbody", form);
    function addFiles(files) {
      Array.prototype.forEach.call(files, function (file) {
        if (!/^image\//.test(file.type)) { toast(file.name + " 不是圖片檔", true); return; }
        var item = { file: file, url: URL.createObjectURL(file) };
        addItems.push(item);
        var d = form.elements;
        var tr = document.createElement("tr");
        tr._item = item;
        tr.innerHTML = html`<td><img src="${item.url}" class="mini" alt=""><div class="small muted">${file.name}</div></td>
          <td><input type="text" data-k="figure_number" placeholder="Fig. 1A"></td>
          <td><input type="text" data-k="page" value="${d.d_page.value}"></td>
          <td><select data-k="structure">${structureOpts(d.d_structure.value)}</select></td>
          <td><select data-k="sex">${opts(SEX, d.d_sex.value)}</select></td>
          <td><select data-k="view">${opts(VIEW, d.d_view.value)}</select></td>
          <td><input type="text" data-k="notes"></td>
          <td><button type="button" class="btn-small" data-action="remove-row" title="移除">×</button></td>`.s;
        tbody.appendChild(tr);
        dirty = true;
      });
      $(".batch", form).hidden = !addItems.length;
      input.value = "";
    }
    input.addEventListener("change", function () { addFiles(input.files); });
    ["dragenter", "dragover"].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { dz.addEventListener(ev, function () { dz.classList.remove("over"); }); });
    dz.addEventListener("drop", function (e) { e.preventDefault(); addFiles(e.dataTransfer.files); });
    form._paste = function (e) {
      var files = Array.prototype.filter.call((e.clipboardData && e.clipboardData.files) || [], function (f) { return /^image\//.test(f.type); });
      if (!files.length) return;
      e.preventDefault();
      addFiles(files.map(function (f, i) {
        return new File([f], "貼上_" + new Date().toISOString().replace(/\D/g, "").slice(0, 14) + (i ? "_" + i : "") + ".png", { type: f.type });
      }));
    };
  }
  document.addEventListener("paste", function (e) {
    var form = $("form[data-form=add]", app);
    if (form && form._paste) form._paste(e);
  });

  /* ----- form submission ----- */

  async function submitForm(form) {
    var kind = form.dataset.form, btn = form.querySelector("button[type=submit], button:not([type])");
    if (!FS) { toast("請先連接資料夾", true); return; }
    try {
      btn.disabled = true;
      if (kind === "add") await submitAdd(form);
      else if (kind === "figure-edit") await submitFigureEdit(form);
      else if (kind === "reference") await submitReference(form);
      else if (kind === "species") await submitSpecies(form);
      else if (kind === "structure") await submitStructure(form);
    } catch (err) {
      console.error(err);
      toast(err.message || String(err), true);
    } finally {
      btn.disabled = false;
    }
  }

  function needSpecies(name) {
    if (!name) throw new Error("請從清單中選擇物種（輸入後點選建議項目）");
    return M.species.get(name);
  }

  async function submitAdd(form) {
    var el = form.elements, sp = needSpecies(el.species.value);
    var refId = el.reference.value, newRef = null;
    if (el.new_reference.checked) {
      newRef = readRefFields(form, "ref_");
      var miss = refMissing(newRef);
      if (miss.length) throw new Error("新文獻請填寫：" + miss.join("、"));
      newRef.type = "reference"; newRef.id = newId(); newRef.created = Date.now();
      refId = newRef.id;
    } else if (!refId) {
      throw new Error("請選擇既有文獻，或勾選「這是新文獻」並填寫資料");
    }
    if (!addItems.length) throw new Error("請加入至少一張圖片");
    var rows = $$(".batch tbody tr", form), progress = $("[data-progress]", form), recs = newRef ? [newRef] : [];
    var who = store("spiderfig.user") || "";
    for (var i = 0; i < rows.length; i++) {
      progress.textContent = "處理第 " + (i + 1) + " / " + rows.length + " 張…";
      var item = rows[i]._item, id = newId(), rec = { type: "figure", id: id };
      $$("[data-k]", rows[i]).forEach(function (inp) { rec[inp.dataset.k] = inp.value.trim(); });
      try {
        rec.files = await storeImages(item.file, sp.genus, sp.epithet, id);
      } catch (e) {
        if (recs.length) await commit(recs);
        throw new Error(item.file.name + " 無法讀取或儲存：" + String(e.message || e).replace(/[.。]\s*$/, "") + (i ? "。前 " + i + " 張已存入。" : ""));
      }
      rec.species = sp.name; rec.reference = refId; rec.created = Date.now(); rec.by = who;
      recs.push(rec);
      if (recs.length >= 20) { await commit(recs); recs = []; }
    }
    if (recs.length) await commit(recs);
    dirty = false;
    toast("已新增 " + rows.length + " 張圖片");
    go("#/species/" + encodeURIComponent(sp.name));
  }

  async function submitFigureEdit(form) {
    var el = form.elements, f = M.figures.get(form.dataset.id);
    var rec = Object.assign({}, f);
    rec.species = needSpecies(el.species.value).name;
    if (!el.reference.value) throw new Error("請選擇文獻");
    rec.reference = el.reference.value;
    ["figure_number", "page", "structure", "sex", "view", "notes"].forEach(function (k) { rec[k] = el[k].value.trim(); });
    await commit([rec]);
    dirty = false;
    toast("已儲存");
    go("#/figure/" + rec.id);
  }

  async function submitReference(form) {
    var r = readRefFields(form), miss = refMissing(r);
    if (miss.length) throw new Error("請填寫：" + miss.join("、"));
    var old = form.dataset.id ? M.references.get(form.dataset.id) : null;
    var rec = Object.assign({}, old || { created: Date.now() }, r, { type: "reference", id: old ? old.id : newId() });
    await commit([rec]);
    dirty = false;
    toast("已儲存文獻");
    go(form.dataset.next || "#/reference/" + rec.id);
  }

  async function submitSpecies(form) {
    var el = form.elements, name = form.dataset.name, rec;
    var valid = el.valid.value ? accepted(el.valid.value) : "";
    if (name) {
      var s = M.species.get(name);
      if (valid === name) throw new Error("有效名不能是自己");
      rec = Object.assign({}, s.record ? M.records[s.record] : { type: "species", id: newId(), genus: s.genus, epithet: s.epithet, subspecies: s.subspecies, created: Date.now() });
      rec.author = el.author.value.trim(); rec.zh = el.zh.value.trim(); rec.valid = valid;
    } else {
      var genus = el.genus.value.trim(), ep = el.epithet.value.trim().toLowerCase(), sub = el.subspecies.value.trim().toLowerCase();
      genus = genus.charAt(0).toUpperCase() + genus.slice(1).toLowerCase();
      if (!genus || !ep) throw new Error("請填寫屬名與種小名");
      if (!/^[A-Za-z-]+$/.test(genus) || !/^[a-z-]+$/.test(ep) || (sub && !/^[a-z-]+$/.test(sub))) throw new Error("學名只能包含英文字母");
      var fam = el.family.value.trim();
      if (!M.genera.has(genus) && !fam) throw new Error("名錄中沒有 " + genus + " 屬，請填寫所屬的科");
      name = spName(genus, ep, sub);
      if (M.species.has(name)) throw new Error("名錄中已有 " + name);
      rec = { type: "species", id: newId(), genus: genus, epithet: ep, subspecies: sub, family: fam || familyOf(genus),
        author: el.author.value.trim(), zh: el.zh.value.trim(), valid: valid, created: Date.now() };
    }
    await commit([rec]);
    dirty = false;
    toast("已儲存 " + name);
    go(form.dataset.next || "#/species/" + encodeURIComponent(name));
  }

  async function submitStructure(form) {
    var el = form.elements, nm = el.name.value.trim();
    if (!nm) return;
    await commit([{ type: "structure", id: "s-" + newId(), name: nm, name_en: el.name_en.value.trim(), order: +el.order.value || 500 }]);
    toast("已新增構造類別");
    route();
  }

  /* ----- checklist import ----- */

  async function previewTaxa(file) {
    var box = $("[data-taxa-preview]", app);
    var buf = await file.arrayBuffer();
    var text = new TextDecoder("utf-8").decode(buf);
    if (text.indexOf("�") >= 0) {
      try { text = new TextDecoder("big5").decode(buf); } catch (e) { /* keep utf-8 */ }
    }
    var csv = parseCSV(text), map = detectMapping(csv.header);
    var missing = ["family", "genus", "species"].filter(function (f) { return map[f] == null; });
    box.innerHTML = html`<p class="small">共 ${csv.rows.length} 列。欄位對應（可調整）：</p>
      <table class="table"><tbody>${Object.keys(ALIASES).map(function (f) {
        return html`<tr><td>${FIELD_LABEL[f]}</td><td><select data-map="${f}"><option value="">（無）</option>
          ${csv.header.map(function (h, i) { return html`<option value="${i}" ${map[f] === i ? raw("selected") : ""}>${h}</option>`; })}</select></td></tr>`;
      })}</tbody></table>
      ${missing.length ? html`<p class="error">找不到必要欄位，請在上面手動選擇。</p>` : ""}
      <p><label>只匯入這些科（逗號分隔，留空代表全部）<input type="text" data-only placeholder="例如 Araneidae, Theridiidae"></label></p>
      <p><button class="btn" data-taxa-go>匯入名錄</button> <span class="muted small" data-taxa-msg></span></p>`.s;
    $("[data-taxa-go]", box).addEventListener("click", function (e) {
      var btn = e.target;
      var m = {};
      $$("[data-map]", box).forEach(function (s) { if (s.value !== "") m[s.dataset.map] = +s.value; });
      if (["family", "genus", "species"].some(function (f) { return m[f] == null; })) { toast("科、屬、種小名欄位都必須指定", true); return; }
      var only = $("[data-only]", box).value.split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
      busy(btn, (async function () {
        var res = buildTaxa(csv, m, only, window.SPIDER_TAXA);
        await FS.write("data/taxa.js", "window.SPIDER_TAXA = " + JSON.stringify(res.taxa) + ";\n");
        window.SPIDER_TAXA = res.taxa;
        buildModel();
        $("[data-taxa-msg]", box).textContent = "完成：讀取 " + res.stats.rows + " 列，新增 " + res.stats.added + " 種、更新 " + res.stats.updated + " 種、略過 " + res.stats.skipped + " 列。";
        toast("名錄已匯入");
      })());
    });
  }

  /* ================= compare basket, zoom, lightbox ================= */

  var BASKET = "spiderfig.compare";
  function getBasket() { return (store(BASKET) || "").split("|").filter(Boolean); }
  function setBasket(ids) { store(BASKET, ids.join("|")); updateBasketNav(); }
  function updateBasketNav() {
    var ids = getBasket(), badge = $("[data-compare-count]"), link = $("[data-compare-link]");
    badge.textContent = ids.length;
    badge.hidden = !ids.length;
    link.href = ids.length ? "#/compare?sp=" + encodeURIComponent(ids.join("|")) : "#/compare";
  }
  function setupCompareButton(btn) {
    var id = btn.dataset.compareAdd;
    function refresh() { btn.textContent = getBasket().indexOf(id) >= 0 ? "已在比較清單（點此移除）" : "加入比較清單"; }
    refresh();
    btn.addEventListener("click", function () {
      var ids = getBasket(), i = ids.indexOf(id);
      if (i >= 0) ids.splice(i, 1); else ids.push(id);
      setBasket(ids); refresh();
    });
  }

  function PanZoom(box, img) {
    var s = 1, x = 0, y = 0, drag = null;
    function apply() { img.style.transform = "translate(" + x + "px," + y + "px) scale(" + s + ")"; box.classList.toggle("zoomed", s > 1.001); }
    function reset() { s = 1; x = 0; y = 0; apply(); }
    box.addEventListener("wheel", function (e) {
      e.preventDefault();
      var r = img.getBoundingClientRect();
      var px = (e.clientX - r.left) / s, py = (e.clientY - r.top) / s;
      var ns = Math.min(12, Math.max(1, s * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
      x += px * (s - ns); y += py * (s - ns); s = ns;
      if (s === 1) { x = 0; y = 0; }
      apply();
    }, { passive: false });
    box.addEventListener("pointerdown", function (e) {
      if (s <= 1) return;
      drag = { px: e.clientX, py: e.clientY, x: x, y: y };
      box.setPointerCapture(e.pointerId);
    });
    box.addEventListener("pointermove", function (e) { if (drag) { x = drag.x + e.clientX - drag.px; y = drag.y + e.clientY - drag.py; apply(); } });
    box.addEventListener("pointerup", function () { drag = null; });
    box.addEventListener("dblclick", function (e) {
      if (s > 1) { reset(); return; }
      var r = img.getBoundingClientRect();
      s = 3; x = (e.clientX - r.left) * (1 - s); y = (e.clientY - r.top) * (1 - s); apply();
    });
    return { reset: reset };
  }

  (function lightbox() {
    var lb = $(".lightbox"), stage = $(".lb-stage", lb), img = $("img", stage), cap = $(".lb-caption", lb);
    var pz = PanZoom(stage, img), group = [], idx = 0;
    function show(i) {
      idx = (i + group.length) % group.length;
      var a = group[idx];
      pz.reset();
      img.src = a.getAttribute("href");
      cap.textContent = a.dataset.caption || "";
      [["詳細資料", a.dataset.detail, false], ["原始檔", a.dataset.original, true]].forEach(function (l) {
        if (!l[1]) return;
        var el = document.createElement("a");
        el.href = l[1]; el.textContent = l[0];
        if (l[2]) el.target = "_blank";
        else el.addEventListener("click", close);
        cap.appendChild(el);
      });
      $(".lb-prev", lb).hidden = $(".lb-next", lb).hidden = group.length < 2;
    }
    function close() { lb.hidden = true; img.src = ""; document.body.style.overflow = ""; }
    document.addEventListener("click", function (e) {
      var a = e.target.closest("a.lb");
      if (!a || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      group = $$("a.lb").filter(function (x) { return x.dataset.group === a.dataset.group; });
      lb.hidden = false;
      document.body.style.overflow = "hidden";
      show(group.indexOf(a));
    });
    $(".lb-close", lb).addEventListener("click", close);
    $(".lb-prev", lb).addEventListener("click", function () { show(idx - 1); });
    $(".lb-next", lb).addEventListener("click", function () { show(idx + 1); });
    lb.addEventListener("click", function (e) { if (e.target === lb) close(); });
    document.addEventListener("keydown", function (e) {
      if (lb.hidden) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft" && group.length > 1) show(idx - 1);
      else if (e.key === "ArrowRight" && group.length > 1) show(idx + 1);
    });
  })();

  /* ================= start ================= */

  buildModel();
  setupSearchBoxes(document);
  updateBasketNav();
  route();
  if (window.__SPIDER_TEST_FS__) {
    useFolder(window.__SPIDER_TEST_FS__).then(route, function (e) { toast(e.message, true); });
  } else {
    reconnect(false).then(function (ok) { if (ok) route(); });
  }

  // exposed for tests
  window.__spider = { searchNames: searchNames, shortAuthors: shortAuthors, citation: citation, parseCSV: parseCSV,
    detectMapping: detectMapping, buildTaxa: buildTaxa, model: function () { return M; } };
})();
