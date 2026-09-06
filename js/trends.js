(function (root) {
  "use strict";

  const CATEGORY_ORDER = ["research", "product", "funding", "policy", "news"];

  function pad(n) {
    return String(n).padStart(2, "0");
  }

  function toDayStr(d) {
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }

  function parseDay(s) {
    const p = String(s).split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }

  function shiftDay(dayStr, days) {
    const d = parseDay(dayStr);
    return toDayStr(new Date(d.getTime() + days * 86400000));
  }

  function spanDays(start, end) {
    if (!start || !end) return 0;
    return Math.round((parseDay(end).getTime() - parseDay(start).getTime()) / 86400000) + 1;
  }

  function utcDayOf(rec) {
    const cand = rec && (rec.publishedAt || rec.discoveredAt);
    if (!cand) return null;
    const t = new Date(cand).getTime();
    if (Number.isNaN(t)) return null;
    return toDayStr(new Date(t));
  }

  function dayRange(records) {
    let min = null;
    let max = null;
    for (const r of records || []) {
      const d = utcDayOf(r);
      if (!d) continue;
      if (!min || d < min) min = d;
      if (!max || d > max) max = d;
    }
    return { min, max };
  }

  function windowBounds(records, range) {
    const { min, max } = dayRange(records);
    if (!max) return { start: null, end: null, mode: range };
    if (range === "7d") return { start: shiftDay(max, -6), end: max, mode: range };
    if (range === "30d") return { start: shiftDay(max, -29), end: max, mode: range };
    return { start: min, end: max, mode: "all" };
  }

  function isScore(s) {
    return typeof s === "number" && !Number.isNaN(s);
  }

  function bandOf(score) {
    if (!isScore(score)) return "unknown";
    if (score >= 70) return "high";
    if (score >= 40) return "medium";
    return "low";
  }

  function avgScore(items) {
    let sum = 0;
    let n = 0;
    for (const it of items || []) {
      if (isScore(it.radarScore)) {
        sum += it.radarScore;
        n++;
      }
    }
    return n ? Math.round((sum / n) * 10) / 10 : null;
  }

  function bucketByDay(records) {
    const map = Object.create(null);
    for (const r of records || []) {
      const d = utcDayOf(r);
      if (!d) continue;
      (map[d] = map[d] || []).push(r);
    }
    return map;
  }

  function walkDays(start, end, cb) {
    let d = new Date(parseDay(start).getTime());
    const e = parseDay(end).getTime();
    while (d.getTime() <= e) {
      cb(toDayStr(d));
      d = new Date(d.getTime() + 86400000);
    }
  }

  function series(records, range) {
    const { start, end } = windowBounds(records, range);
    if (!end) return [];
    const map = bucketByDay(records);
    const out = [];
    walkDays(start, end, (day) => {
      const items = map[day] || [];
      let high = 0;
      let medium = 0;
      let low = 0;
      let unknown = 0;
      for (const it of items) {
        const b = bandOf(it.radarScore);
        if (b === "high") high++;
        else if (b === "medium") medium++;
        else if (b === "low") low++;
        else unknown++;
      }
      out.push({
        day,
        count: items.length,
        avgScore: avgScore(items),
        high,
        medium,
        low,
        unknown,
      });
    });
    return out;
  }

  function windowItems(records, range) {
    const { start, end } = windowBounds(records, range);
    if (!start) return [];
    return (records || []).filter((r) => {
      const d = utcDayOf(r);
      return d && d >= start && d <= end;
    });
  }

  function distribution(records) {
    const out = { high: 0, medium: 0, low: 0, unknown: 0 };
    for (const r of records || []) out[bandOf(r.radarScore)]++;
    return out;
  }

  function categoryMix(records) {
    const counts = Object.create(null);
    let total = 0;
    for (const r of records || []) {
      const id = r && typeof r.category === "string" && r.category ? r.category : "other";
      counts[id] = (counts[id] || 0) + 1;
      total++;
    }
    const ids = CATEGORY_ORDER.concat(Object.keys(counts).filter((id) => CATEGORY_ORDER.indexOf(id) === -1));
    const out = [];
    const seen = new Set();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const count = counts[id] || 0;
      if (!count) continue;
      out.push({ id, count, pct: total ? Math.round((count / total) * 1000) / 10 : 0 });
    }
    return out;
  }

  function countBy(records, key) {
    const counts = Object.create(null);
    for (const r of records || []) {
      const arr = Array.isArray(r && r[key]) ? r[key] : [];
      for (const v of arr) {
        const name = String(v).trim();
        if (!name) continue;
        counts[name] = (counts[name] || 0) + 1;
      }
    }
    const out = [];
    for (const name in counts) out.push({ name, count: counts[name] });
    out.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  function sourceCounts(records) {
    const map = Object.create(null);
    for (const r of records || []) {
      const src = r && r.source && typeof r.source === "object" ? r.source : null;
      if (!src || !src.id) continue;
      const id = String(src.id);
      const name = src.name || id;
      const e = map[id] || (map[id] = { id, name, count: 0 });
      e.count++;
    }
    const out = [];
    for (const id in map) out.push(map[id]);
    out.sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  function trendingFor(records, key) {
    const span = dayRange(records);
    if (!span.max) return [];
    const curStart = shiftDay(span.max, -6);
    const prevStart = shiftDay(span.max, -13);
    const curMap = Object.create(null);
    const prevMap = Object.create(null);
    for (const r of records || []) {
      const d = utcDayOf(r);
      const arr = Array.isArray(r && r[key]) ? r[key] : [];
      for (const v of arr) {
        const name = String(v).trim();
        if (!name) continue;
        if (d >= curStart) curMap[name] = (curMap[name] || 0) + 1;
        else if (d >= prevStart) prevMap[name] = (prevMap[name] || 0) + 1;
      }
    }
    const names = new Set();
    for (const k in curMap) names.add(k);
    for (const k in prevMap) names.add(k);
    const out = [];
    for (const name of names) {
      const current = curMap[name] || 0;
      const previous = prevMap[name] || 0;
      if (current === 0 && previous === 0) continue;
      let pct = null;
      let direction = "flat";
      if (previous === 0 && current > 0) {
        pct = null;
        direction = "new";
      } else if (current === 0) {
        pct = -100;
        direction = "down";
      } else {
        pct = Math.round(((current - previous) / previous) * 100);
        direction = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
      }
      out.push({ name, current, previous, pct, direction });
    }
    out.sort((a, b) => {
      const ra = a.direction === "new" ? 1 : a.pct;
      const rb = b.direction === "new" ? 1 : b.pct;
      if (ra !== rb) return rb - ra;
      if (a.current !== b.current) return b.current - a.current;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });
    return out;
  }

  function topN(list, n) {
    return (list || []).slice(0, n);
  }

  function aggregate(records, opts) {
    const range = opts && (opts.range === "30d" || opts.range === "7d") ? opts.range : "all";
    const win = windowItems(records, range);
    const s = series(records, range);
    const { start, end } = windowBounds(records, range);
    const dist = distribution(win);
    const cats = categoryMix(win);
    const entities = {
      companies: topN(countBy(win, "companies"), 8),
      models: topN(countBy(win, "models"), 8),
      people: topN(countBy(win, "people"), 8),
      technologies: topN(countBy(win, "technologies"), 8),
      tags: topN(countBy(win, "tags"), 8),
    };
    const sources = topN(sourceCounts(win), 8);
    const trending = {
      companies: topN(trendingFor(win, "companies"), 8),
      models: topN(trendingFor(win, "models"), 8),
      tags: topN(trendingFor(win, "tags"), 8),
    };
    const peak = s.reduce((best, d) => (best && best.count >= d.count ? best : d), null);
    const activeDays = s.filter((d) => d.count > 0).length;
    const avg = avgScore(win);
    const bandNames = ["high", "medium", "low", "unknown"];
    const domBand = bandNames.reduce((b1, b2) => (dist[b2] > dist[b1] ? b2 : b1), "high");
    const days = spanDays(start, end);
    const facts = [];
    if (win.length) {
      facts.push({ label: "Stories in view", value: String(win.length) });
      facts.push({ label: "Days covered", value: activeDays + " active of " + days });
      facts.push({ label: "Avg stories per day", value: String(Math.round((win.length / (days || 1)) * 10) / 10) });
      if (peak) facts.push({ label: "Peak day", value: peak.day + " (" + peak.count + " stories)" });
      facts.push({ label: "Avg Radar Score", value: avg == null ? "n/a" : String(avg) });
      facts.push({ label: "Dominant band", value: domBand + " (" + dist[domBand] + " stories)" });
      if (cats.length) facts.push({ label: "Top category", value: cats[0].id + " (" + cats[0].count + ")" });
      if (trending.companies.length) facts.push({ label: "Top company (last 7d)", value: trending.companies[0].name });
    }
    return {
      range,
      start,
      end,
      days,
      total: win.length,
      activeDays,
      peak: peak && { day: peak.day, count: peak.count },
      avgScore: avg,
      variance: dist,
      series: s,
      categories: cats,
      entities,
      sources,
      trending,
      facts,
    };
  }

  const api = {
    utcDayOf,
    windowBounds,
    spanDays,
    series,
    windowItems,
    distribution,
    categoryMix,
    countBy,
    sourceCounts,
    trendingFor,
    topN,
    avgScore,
    bandOf,
    aggregate,
  };

  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.AIRadarTrends = api;
})(typeof window !== "undefined" ? window : this);