/*
 * AI RADAR - Stage 12: single fragment owner.
 *
 * The ONLY code that reads location.hash for the radar feature. It routes
 * radar routes -> AIRadarRadarView.show() and every other hash (or no hash)
 * -> AIRadarRadarView.hide(). Non-radar toggles (history/trends/pipeline)
 * never write the hash; when they take over the view the radar hash is cleared
 * via history.replaceState (see AIRadarHooks.activateView), so state, hash and
 * the visible section can never disagree.
 */

(function (root) {
  "use strict";

  function navigate(hash) {
    if (typeof location === "undefined") return;
    if (hash == null || hash === "") hash = "#";
    if (location.hash !== hash) location.hash = hash;
  }

  function onHash() {
    const R = root.AIRadarRadar;
    const RV = root.AIRadarRadarView;
    const route = R ? R.parseHash(location.hash || "") : { kind: "none" };
    if (RV && typeof RV.show === "function" && typeof RV.hide === "function") {
      if (route.kind === "radar-global" || route.kind === "radar-entity") {
        RV.show(route);
      } else {
        RV.hide();
      }
    }
  }

  function boot() {
    if (typeof window === "undefined" || typeof document === "undefined") return;
    window.addEventListener("hashchange", onHash);
    /* Handle deep links on first load. */
    onHash();
  }

  const api = {
    navigate,
    onHash,
    boot,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AIRadarRouter = api;

  /* The document script order guarantees the radar views exist by the time
   * this file runs, so we can own the hash immediately (deep links included). */
  if (typeof window !== "undefined") boot();
})(typeof window !== "undefined" ? window : this);