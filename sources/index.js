/*
 * AI RADAR - Source configuration loader (Node).
 *
 * Reads the canonical source definitions from sources/sources.json,
 * validates every entry against the shared schema (js/shared.js
 * validateSourceConfig) and exposes:
 *   - sources:         all configured sources (sorted by priority)
 *   - enabledSources:  only enabled ones (what the pipeline ingests)
 *   - validationErrors: problems found while loading the configuration
 *   - configValid:     whether the configuration is usable
 *
 * Adding a source = adding one entry to sources/sources.json. No code
 * changes anywhere else.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const Core = require("../js/shared.js");

const SOURCES_FILE = path.join(__dirname, "sources.json");

function byPriority(a, b) {
  return (a.priority - b.priority) || a.name.localeCompare(b.name);
}

function loadSources(file = SOURCES_FILE) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return {
      sources: [],
      enabledSources: [],
      validationErrors: [
        { source: "", field: "file", message: "cannot read/parse " + file + ": " + e.message },
      ],
      configValid: false,
    };
  }

  const arr = Array.isArray(data) ? data : data.sources;
  if (!Array.isArray(arr)) {
    return {
      sources: [],
      enabledSources: [],
      validationErrors: [
        { source: "", field: "file", message: "expected a {sources:[...]} JSON structure" },
      ],
      configValid: false,
    };
  }

  const sources = [];
  const enabledSources = [];
  const validationErrors = [];
  const seen = new Set();

  arr.forEach((item, ix) => {
    const tag = (item && item.id) || "entry#" + ix;
    const result = Core.validateSourceConfig(item);
    if (!result.valid) {
      result.errors.forEach((e) =>
        validationErrors.push({ source: tag, field: e.field, message: e.message })
      );
      return;
    }
    const src = Core.applySourceDefaults(item);
    if (seen.has(src.id)) {
      validationErrors.push({ source: src.id, field: "id", message: "duplicate source id" });
      return;
    }
    seen.add(src.id);
    sources.push(src);
    if (src.enabled) enabledSources.push(src);
  });

  sources.sort(byPriority);
  enabledSources.sort(byPriority);

  return { sources, enabledSources, validationErrors, configValid: validationErrors.length === 0 };
}

const loaded = loadSources();

module.exports = {
  SOURCES_FILE,
  loadSources,
  sources: loaded.sources,
  enabledSources: loaded.enabledSources,
  validationErrors: loaded.validationErrors,
  configValid: loaded.configValid,
};