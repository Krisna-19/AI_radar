/*
 * AI RADAR - Stage 12: per-route SEO metadata.
 *
 * Static GitHub Pages single page: there is no server-side routing, so an
 * entity "page" is #/radar/<group>/<slug>. We still advertise the right title,
 * description and OpenGraph metadata for the CURRENT route and emit a canonical
 * URL (base + fragment) so social/share tools and crawlers see coherent data.
 * When a non-radar view is active the metadata is restored to the site default.
 * This module touches only document.head and is idempotent.
 */
(function (root) {
  "use strict";

  const SITE_BASE = "https://krisna-19.github.io/AI_radar/";

  const DEFAULT_TITLE = "AI RADAR • Daily AI Intelligence";
  const DEFAULT_DESCRIPTION =
    "AI RADAR - Your daily briefing of AI research, products, funding and policy, aggregated from leading sources.";

  function q(sel) {
    return document.head.querySelector(sel);
  }

  function metaByProperty(prop, content) {
    let el = q('meta[property="' + prop + '"]');
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute("property", prop);
      document.head.appendChild(el);
    }
    el.setAttribute("content", content == null ? "" : String(content));
    return el;
  }

  function metaByName(name, content) {
    let el = q('meta[name="' + name + '"]');
    if (!el) {
      el = document.createElement("meta");
      el.setAttribute("name", name);
      document.head.appendChild(el);
    }
    el.setAttribute("content", content == null ? "" : String(content));
    return el;
  }

  function linkCanonical(href) {
    let el = q('link[rel="canonical"]');
    if (!el) {
      el = document.createElement("link");
      el.setAttribute("rel", "canonical");
      document.head.appendChild(el);
    }
    el.setAttribute("href", href);
    return el;
  }

  /* Apply metadata for a route. `hash` is the full fragment ("" for default). */
  function setRouteMeta(title, description, hash) {
    document.title = title || DEFAULT_TITLE;
    metaByName("description", description || DEFAULT_DESCRIPTION);
    metaByProperty("og:title", title || DEFAULT_TITLE);
    metaByProperty("og:description", description || DEFAULT_DESCRIPTION);
    metaByProperty("og:type", "article");
    linkCanonical(SITE_BASE + (hash || ""));
  }

  /* Restore the site default and remove radar-specific OG/canonical tags so a
   * later crawl of the live view is not confused by entity metadata. */
  function reset() {
    document.title = DEFAULT_TITLE;
    const d = q('meta[name="description"]');
    if (d) d.setAttribute("content", DEFAULT_DESCRIPTION);
    document.head.querySelectorAll('meta[property^="og:"]').forEach((el) => el.remove());
    const c = q('link[rel="canonical"]');
    if (c) c.remove();
  }

  const api = {
    SITE_BASE,
    setRouteMeta,
    reset,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AIRadarSEO = api;
})(typeof window !== "undefined" ? window : this);