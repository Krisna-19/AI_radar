(function (root) {
  "use strict";

  function esc(s) {
    return (s == null ? "" : String(s))
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function clean(s) {
    return typeof s === "string" ? s.trim() : "";
  }

  function categoryMeta(id) {
    const list = root && Array.isArray(root.CATEGORIES) ? root.CATEGORIES : [];
    const c = list.find((x) => x.id === id);
    return c || { label: "News", icon: "📰" };
  }

  function readerText(item) {
    if (!item) return "";
    return clean(item.content) || clean(item.description) || "";
  }

  function summaryText(item) {
    if (!item) return "";
    const ai = item.ai && typeof item.ai === "object" ? item.ai : null;
    return clean(ai && ai.summary);
  }

  function scoreValue(item) {
    if (!item) return null;
    if (typeof item.radarScore === "number") return Math.round(item.radarScore);
    if (typeof item.score === "number") return Math.round(item.score * 20);
    return null;
  }

  function collectChips(item) {
    const seen = new Set();
    const out = [];
    if (!item) return out;
    const add = (arr) => {
      if (!Array.isArray(arr)) return;
      for (const v of arr) {
        const n = clean(v);
        if (!n || seen.has(n)) continue;
        seen.add(n);
        out.push(n);
      }
    };
    add(item.companies);
    add(item.people);
    add(item.models);
    add(item.technologies);
    add(item.tags);
    return out;
  }

  function formatDate(d) {
    if (!d || isNaN(d.getTime())) return "";
    let base = "";
    try {
      base = d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
    } catch (e) {
      base = "";
    }
    let time = "";
    try {
      time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    } catch (e) {
      time = "";
    }
    return base + (time ? " at " + time : "");
  }

  function notFoundHtml() {
    return (
      '<div class="article-reader article-not-found" role="dialog" aria-modal="false" ' +
      'aria-label="Story not found">' +
      '<div class="article-reader-nav">' +
      '<button type="button" class="article-back" data-article-close>← Back to feed</button>' +
      "</div>" +
      '<span class="article-section-label">Story unavailable</span>' +
      '<p class="article-muted">This story could not be found in the current snapshot. ' +
      "Previous snapshot stories may have expired.</p>" +
      "</div>"
    );
  }

  function readerHtml(item, escFn) {
    escFn = typeof escFn === "function" ? escFn : esc;
    if (!item) return notFoundHtml();

    const meta = categoryMeta(item.category);
    const title = clean(item.title) || "Untitled";
    const srcName =
      clean((item.source && item.source.name) || null) || clean(item.sourceName) || "";
    const rawDate = item.publishedAt || item.date || "";
    const fullDate = rawDate ? formatDate(new Date(rawDate)) : "";
    const score = scoreValue(item);
    const aiSummary = summaryText(item);
    const body = readerText(item);
    const hasContent = Boolean(clean(item.content));
    const chips = collectChips(item);

    let html = "";

    html +=
      '<div class="article-reader" role="dialog" aria-modal="false" aria-label="Article detail">' +
      '<div class="article-reader-nav">' +
      '<button type="button" class="article-back" data-article-close>← Back to feed</button>' +
      '<span class="article-reader-meta">' +
      escFn(meta.icon + " " + meta.label) +
      "</span>" +
      "</div>" +
      '<h1 class="article-title">' +
      escFn(title) +
      "</h1>" +
      '<div class="article-facts">' +
      (srcName
        ? "<span><b>Source:</b> " + escFn(srcName) + "</span>"
        : "") +
      (fullDate
        ? "<span><b>Published:</b> " + escFn(fullDate) + "</span>"
        : "") +
      (score != null
        ? "<span><b>Signal:</b> " + escFn(String(score)) + "%</span>"
        : "") +
      "</div>";

    if (aiSummary) {
      html +=
        '<div class="article-summary">' +
        '<div class="article-section-label"><span class="ai-badge">AI</span> Summary</div>' +
        "<p>" +
        escFn(aiSummary) +
        "</p>" +
        "</div>";
    }

    if (body) {
      html +=
        '<div class="article-body">' +
        '<div class="article-section-label">' +
        (hasContent ? "Full story" : "Description") +
        "</div>" +
        '<div class="article-text"><p>' +
        escFn(body) +
        "</p></div>" +
        "</div>";
    } else if (!aiSummary) {
      html +=
        '<div class="article-body">' +
        '<p class="article-muted">Only the headline is available for this story in the current snapshot.</p>' +
        "</div>";
    }

    if (chips.length) {
      html +=
        '<div class="article-chips">' +
        '<span class="article-chips-label">Related entities</span>' +
        '<div class="article-chips-row">' +
        chips
          .slice(0, 12)
          .map((c) => '<span class="entity-chip">' + escFn(c) + "</span>")
          .join("") +
        "</div>" +
        "</div>";
    }

    html += "</div>";
    return html;
  }

  const api = {
    esc,
    readerText,
    summaryText,
    scoreValue,
    collectChips,
    formatDate,
    readerHtml,
    notFoundHtml,
  };

  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const els = {
      view: document.getElementById("article-view"),
      body: document.getElementById("article-body"),
    };
    const state = { active: false, previous: null };
    const VIEW_NAMES = ["history", "trends", "pipeline", "radar", "article"];

    function setView(active) {
      if (active && !state.active) {
        state.previous =
          VIEW_NAMES.find(
            (n) => n !== "article" && document.body.classList.contains(n + "-active")
          ) || null;
      }
      state.active = active;
      if (els.view) els.view.style.display = active ? "block" : "none";
      if (root.AIRadarHooks && typeof root.AIRadarHooks.activateView === "function") {
        root.AIRadarHooks.activateView(active ? "article" : state.previous || "live");
      }
      if (!active) state.previous = null;
    }

    function render(record) {
      if (!els.body) return;
      els.body.innerHTML = record && record.id ? readerHtml(record, esc) : notFoundHtml();
      const back = els.body.querySelector("[data-article-close]");
      if (back && typeof back.focus === "function") back.focus();
    }

    function open(record) {
      if (!els.view) return;
      if (!state.active) setView(true);
      render(record);
    }

    function openByCard(card) {
      const id = card && card.dataset ? card.dataset.storyId : "";
      if (!id) return;
      let record = null;
      const hooks = root.AIRadarHooks;
      if (hooks && typeof hooks.getState === "function") {
        const items = hooks.getState().items || [];
        for (const it of items) {
          if (it && it.id === id) {
            record = it;
            break;
          }
        }
      }
      open(record);
    }

    function close() {
      setView(false);
    }

    function bindViewEvents() {
      if (!els.view) return;
      els.view.addEventListener("click", (e) => {
        if (e.target.closest("[data-article-close]")) {
          e.preventDefault();
          close();
        }
      });
      els.view.addEventListener("keydown", (e) => {
        if (e.key === "Escape") close();
      });
    }

    const SKIP_SELECTOR =
      ".entity-chip, a, button, input, select, textarea, summary, [data-article-close]";
    function bindCardClicks() {
      document.addEventListener("click", (e) => {
        if (e.defaultPrevented) return;
        if (!e.target || e.target.closest(SKIP_SELECTOR)) return;
        const card = e.target.closest("[data-story-id]");
        if (!card) return;
        if (card.closest("#history-grid") || card.closest("#radar-view")) return;
        if (card.classList.contains("radar-card")) return;
        e.preventDefault();
        openByCard(card);
      });
      document.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (!e.target || e.target.closest(SKIP_SELECTOR) || e.target.closest("svg")) return;
        const card = e.target.closest("[data-story-id]");
        if (!card) return;
        if (card.closest("#history-grid") || card.closest("#radar-view")) return;
        if (card.classList.contains("radar-card")) return;
        e.preventDefault();
        openByCard(card);
      });
    }

    bindViewEvents();
    bindCardClicks();

    api.open = open;
    api.close = close;
  }

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AIRadarArticle = api;
})(typeof window !== "undefined" ? window : this);