/*
 * Stage 13: pre-commit credential scan for the snapshot data files.
 *
 * Usage (CI, from repo root):
 *   git add data/news.json data/db
 *   node scripts/pipeline/check-secrets.js
 *
 * Scans whatever is STAGED under data/news.json and data/db/ (via
 * `git diff --cached --name-only` + `git show :<path>`), so it checks exactly
 * what the upcoming commit would write. Exits non-zero (failing the workflow
 * BEFORE the commit/push step) if any credential-shaped string is found, and
 * prints file / JSON-field / pattern diagnostics for each hit.
 *
 * Zero deps: Node built-ins + ../pipeline/store.js pattern source.
 */
"use strict";

const { execFileSync } = require("child_process");
const { findCredentialMatches } = require("./store.js");

const TARGETS = ["data/news.json", "data/db"];

function stagedNames(targets) {
  const out = execFileSync("git", ["diff", "--cached", "--name-only", "-z", "--", ...targets], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split("\0").filter(Boolean);
}

function stagedBlob(path) {
  return execFileSync("git", ["show", ":" + path], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/* Try to deserialize one staged file into a flat list of {field, line, text}
 * entries. Falls back to a raw line scan when the file is not JSON. */
function entriesFor(path, text) {
  const out = [];
  let parsed;
  if (path.endsWith(".ndjson")) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      try {
        parsed = JSON.parse(line);
      } catch (e) {
        out.push({ field: "line:" + (i + 1), text: line });
        continue;
      }
      flatten(parsed, out, "line:" + (i + 1) + ".");
    }
    return out;
  }
  if (path.endsWith(".json")) {
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      return text.split(/\r?\n/).map((line, i) => ({ field: "line:" + (i + 1), text: line }));
    }
  }
  if (parsed && typeof parsed === "object") {
    flatten(parsed, out, "");
    return out;
  }
  return text.split(/\r?\n/).map((line, i) => ({ field: "line:" + (i + 1), text: line }));
}

function flatten(value, out, prefix) {
  if (value == null) return;
  if (typeof value === "string") {
    const seg = prefix.replace(/\.+$/, "");
    out.push({ field: seg || "(root)", text: value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, out, prefix + "[" + i + "]."));
    return;
  }
  if (typeof value === "object") {
    for (const k of Object.keys(value)) {
      flatten(value[k], out, prefix + k + ".");
    }
  }
}

function main() {
  const names = stagedNames(TARGETS);
  if (!names.length) {
    console.log("[check-secrets] no staged changes under data/news.json or data/db/ - nothing to scan.");
    return 0;
  }

  let total = 0;
  for (const path of names.sort()) {
    let text;
    try {
      text = stagedBlob(path);
    } catch (e) {
      console.warn("[check-secrets] cannot read staged blob " + path + ": " + e.message);
      continue;
    }
    const hits = [];
    for (const e of entriesFor(path, text)) {
      const found = findCredentialMatches(e.text);
      for (const m of found) {
        hits.push({ field: e.field, pattern: m.pattern, snippet: e.text.slice(Math.max(0, m.index - 40), m.index + 60) });
        total++;
      }
    }
    if (!hits.length) continue;
    console.log("[check-secrets] CREDENTIAL-SHAPED STRING(S) staged in " + path);
    for (const h of hits) {
      console.log("  file: " + path);
      console.log("  field: " + h.field);
      console.log("  pattern: " + h.pattern);
      console.log("  snippet: ..." + h.snippet.replace(/[\r\n]+/g, " ") + "...");
    }
  }

  if (total > 0) {
    console.log("[check-secrets] FAIL: " + total + " credential-shaped string(s) staged - refusing to proceed.");
    console.log("[check-secrets] Run the Stage 13 scrubber (build-news.js scrubs at the persistence boundary) and re-add.");
    return 1;
  }
  console.log("[check-secrets] PASS: no credential-shaped strings staged in data files.");
  return 0;
}

if (require.main === module) {
  process.exitCode = main();
}