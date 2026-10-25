/* Front-end behaviour: autocomplete, lightbox with zoom, zoomable compare panels,
 * compare basket, upload previews. No external libraries, so the site works offline. */
(function () {
  "use strict";

  var TYPE_LABEL = { family: "科", genus: "屬", species: "種" };

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  /* ---------- autocomplete ---------- */
  function attachAutocomplete(input, list, opts) {
    var items = [], active = -1, lastQuery = null;

    function render() {
      list.innerHTML = "";
      if (!items.length) { list.hidden = true; return; }
      items.forEach(function (it, i) {
        var row = document.createElement("div");
        row.className = "ac-item" + (i === active ? " active" : "");
        row.dataset.type = it.type || "";
        if (it.type) {
          var ty = document.createElement("span");
          ty.className = "ac-type"; ty.textContent = TYPE_LABEL[it.type] || "";
          row.appendChild(ty);
        }
        var lb = document.createElement("span");
        lb.className = "ac-label"; lb.textContent = it.label;
        row.appendChild(lb);
        if (it.sub) {
          var sb = document.createElement("span");
          sb.className = "ac-sub"; sb.textContent = it.sub;
          row.appendChild(sb);
        }
        row.addEventListener("mousedown", function (e) { e.preventDefault(); pick(i); });
        list.appendChild(row);
      });
      list.hidden = false;
    }

    function pick(i) {
      var it = items[i];
      if (!it) return;
      list.hidden = true;
      opts.onPick(it);
    }

    var fetchItems = debounce(function () {
      var q = input.value.trim();
      if (q.length < 2) { items = []; render(); return; }
      if (q === lastQuery) return;
      lastQuery = q;
      fetch(opts.url + "?q=" + encodeURIComponent(q) + (opts.extra || ""), { credentials: "same-origin" })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (input.value.trim() !== q) return;
          items = data.results || []; active = -1; render();
        })
        .catch(function () { items = []; render(); });
    }, 180);

    input.addEventListener("input", function () {
      if (opts.onType) opts.onType();
      fetchItems();
    });
    input.addEventListener("keydown", function (e) {
      if (list.hidden) return;
      if (e.key === "ArrowDown") { active = Math.min(active + 1, items.length - 1); render(); e.preventDefault(); }
      else if (e.key === "ArrowUp") { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
      else if (e.key === "Enter" && active >= 0) { pick(active); e.preventDefault(); }
      else if (e.key === "Escape") { list.hidden = true; }
    });
    input.addEventListener("blur", function () { setTimeout(function () { list.hidden = true; }, 150); });
    input.addEventListener("focus", function () { if (items.length) list.hidden = false; });
  }

  // Global search boxes: picking a suggestion goes straight to that page.
  document.querySelectorAll("[data-search-box]").forEach(function (input) {
    var list = input.parentNode.querySelector(".ac-list");
    attachAutocomplete(input, list, {
      url: "/api/autocomplete/",
      onPick: function (it) { window.location.href = it.url; }
    });
  });

  // Form widgets: picking fills the hidden id field.
  document.querySelectorAll(".ac-widget").forEach(function (w) {
    var hidden = w.querySelector("input[type=hidden]");
    var input = w.querySelector(".ac-input");
    var list = w.querySelector(".ac-list");
    var kind = w.dataset.kind;
    attachAutocomplete(input, list, {
      url: kind === "reference" ? "/api/references/" : "/api/autocomplete/",
      extra: kind === "species" ? "&kinds=species" : "",
      onType: function () { hidden.value = ""; },
      onPick: function (it) {
        hidden.value = it.id;
        input.value = it.label;
        if (w.hasAttribute("data-submit-on-pick")) w.closest("form").submit();
      }
    });
  });

  /* ---------- pan & zoom helper ---------- */
  function PanZoom(box, img) {
    var s = 1, x = 0, y = 0, drag = null;
    function apply() {
      img.style.transform = "translate(" + x + "px," + y + "px) scale(" + s + ")";
      box.classList.toggle("zoomed", s > 1.001);
    }
    function reset() { s = 1; x = 0; y = 0; apply(); }
    box.addEventListener("wheel", function (e) {
      e.preventDefault();
      var r = img.getBoundingClientRect();
      // cursor position relative to the untransformed image origin
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
    box.addEventListener("pointermove", function (e) {
      if (!drag) return;
      x = drag.x + e.clientX - drag.px; y = drag.y + e.clientY - drag.py; apply();
    });
    box.addEventListener("pointerup", function () { drag = null; });
    box.addEventListener("dblclick", function (e) {
      if (s > 1) { reset(); return; }
      var r = img.getBoundingClientRect();
      var px = e.clientX - r.left, py = e.clientY - r.top;
      s = 3; x = px * (1 - s); y = py * (1 - s); apply();
    });
    return { reset: reset };
  }

  document.querySelectorAll(".zoom-box").forEach(function (box) {
    var img = box.querySelector("img");
    if (img) PanZoom(box, img);
  });

  /* ---------- lightbox ---------- */
  var lb = document.querySelector(".lightbox");
  if (lb) {
    var stage = lb.querySelector(".lb-stage");
    var lbImg = stage.querySelector("img");
    var cap = lb.querySelector(".lb-caption");
    var pz = PanZoom(stage, lbImg);
    var group = [], idx = 0;

    function show(i) {
      idx = (i + group.length) % group.length;
      var a = group[idx];
      pz.reset();
      lbImg.src = a.getAttribute("href");
      cap.textContent = a.dataset.caption || "";
      if (a.dataset.detail) {
        var d = document.createElement("a");
        d.href = a.dataset.detail; d.textContent = "詳細資料";
        cap.appendChild(d);
      }
      if (a.dataset.original) {
        var o = document.createElement("a");
        o.href = a.dataset.original; o.target = "_blank"; o.textContent = "原始檔";
        cap.appendChild(o);
      }
      var multi = group.length > 1;
      lb.querySelector(".lb-prev").hidden = !multi;
      lb.querySelector(".lb-next").hidden = !multi;
    }
    function close() { lb.hidden = true; lbImg.src = ""; document.body.style.overflow = ""; }

    document.addEventListener("click", function (e) {
      var a = e.target.closest("a.lb");
      if (!a || e.ctrlKey || e.metaKey) return;
      e.preventDefault();
      group = Array.prototype.slice.call(
        document.querySelectorAll('a.lb[data-group="' + (a.dataset.group || "") + '"]'));
      lb.hidden = false;
      document.body.style.overflow = "hidden";
      show(group.indexOf(a));
    });
    lb.querySelector(".lb-close").addEventListener("click", close);
    lb.querySelector(".lb-prev").addEventListener("click", function () { show(idx - 1); });
    lb.querySelector(".lb-next").addEventListener("click", function () { show(idx + 1); });
    lb.addEventListener("click", function (e) { if (e.target === lb) close(); });
    document.addEventListener("keydown", function (e) {
      if (lb.hidden) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft" && group.length > 1) show(idx - 1);
      else if (e.key === "ArrowRight" && group.length > 1) show(idx + 1);
    });
  }

  /* ---------- compare basket (per-browser convenience only) ---------- */
  var KEY = "spiderfig.compare";
  function loadBasket() {
    try { return (localStorage.getItem(KEY) || "").split(",").filter(Boolean); } catch (e) { return []; }
  }
  function saveBasket(ids) {
    try { localStorage.setItem(KEY, ids.join(",")); } catch (e) { /* storage unavailable */ }
    updateNav(ids);
  }
  function updateNav(ids) {
    var badge = document.querySelector("[data-compare-count]");
    var link = document.querySelector("[data-compare-link]");
    if (badge) { badge.textContent = ids.length; badge.hidden = !ids.length; }
    if (link && ids.length) link.href = "/compare/?species=" + ids.join(",");
  }
  if (typeof window.COMPARE_IDS === "string") {
    saveBasket(window.COMPARE_IDS.split(",").filter(Boolean));  // compare page URL is the source of truth
  } else {
    updateNav(loadBasket());
  }
  document.querySelectorAll("[data-compare-add]").forEach(function (btn) {
    var id = btn.dataset.compareAdd;
    function refresh() {
      var inBasket = loadBasket().indexOf(id) >= 0;
      btn.textContent = inBasket ? "已在比較清單（點此移除）" : "加入比較清單";
    }
    refresh();
    btn.addEventListener("click", function () {
      var ids = loadBasket(), i = ids.indexOf(id);
      if (i >= 0) ids.splice(i, 1); else ids.push(id);
      saveBasket(ids); refresh();
    });
  });
  var clear = document.querySelector("[data-compare-clear]");
  if (clear) clear.addEventListener("click", function () { saveBasket([]); });

  /* ---------- misc ---------- */
  document.querySelectorAll("[data-toggle]").forEach(function (cb) {
    var target = document.querySelector(cb.dataset.toggle);
    cb.addEventListener("change", function () { target.hidden = !cb.checked; });
  });

  document.querySelectorAll("[data-copy]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = document.querySelector(btn.dataset.copy).textContent.trim();
      var done = function () { btn.textContent = "已複製"; setTimeout(function () { btn.textContent = "複製引用"; }, 1500); };
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).then(done);
      } else {
        // intranet over plain http: clipboard API unavailable, fall back to a temporary textarea
        var ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (e) { /* ignore */ }
        document.body.removeChild(ta);
      }
    });
  });

  document.querySelectorAll("[data-dropzone]").forEach(function (dz) {
    var input = dz.querySelector("input[type=file]");
    var previews = dz.querySelector(".previews");
    var hint = dz.querySelector("p");
    function showPreviews() {
      previews.innerHTML = "";
      Array.prototype.forEach.call(input.files, function (f) {
        var img = document.createElement("img");
        img.src = URL.createObjectURL(f); img.title = f.name;
        previews.appendChild(img);
      });
      hint.textContent = input.files.length ? "已選擇 " + input.files.length + " 個檔案（再點一次可重新選擇）" : hint.textContent;
    }
    input.addEventListener("change", showPreviews);
    ["dragenter", "dragover"].forEach(function (ev) { dz.addEventListener(ev, function () { dz.classList.add("over"); }); });
    ["dragleave", "drop"].forEach(function (ev) { dz.addEventListener(ev, function () { dz.classList.remove("over"); }); });
  });
})();
