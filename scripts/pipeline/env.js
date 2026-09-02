/*
 * AI RADAR - minimal environment loader (zero dependencies).
 *
 * Reads <repo>/.env into process.env (without overwriting real env vars) if
 * the file exists. Used only by Node scripts (never the browser). Supports
 * KEY=VALUE lines, # comments, and double-quoted values.
 */

"use strict";

const fs = require("fs");
const path = require("path");

let loaded = false;

function loadEnv(file) {
  const candidates = file
    ? [file]
    : [path.join(__dirname, "..", "..", ".env")];
  if (loaded) return;
  for (const f of candidates) {
    let txt;
    try {
      txt = fs.readFileSync(f, "utf8");
    } catch (e) {
      continue;
    }
    txt.split(/\r?\n/).forEach((line) => {
      const t = line.trim();
      if (!t || t.startsWith("#")) return;
      const eq = t.indexOf("=");
      if (eq <= 0) return;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        val.length >= 2 &&
        val.startsWith('"') &&
        val.endsWith('"')
      ) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    });
  }
  loaded = true;
}

function envNumber(key, fallback) {
  const v = process.env[key];
  if (v == null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = { loadEnv, envNumber };