"use strict";

/*
 * Stage 12 one-time archive sweep.
 *
 * Re-keys every archived row onto its CLEAN identity (id derived from the
 * title after stripping a trailing known-publisher suffix) and collapses
 * duplicate copies of the same story that previously split across different
 * ids. Safety: rows are merged only when they share the same clean id AND the
 * same canonical url key; anything else is preserved under its legacy id and
 * reported. The sweep is deterministic and idempotent.
 *
 * Usage:
 *   node scripts/rekey-archive.js [--dry-run] [--backup <dir>] [dbDir]
 *
 * Exit code: 0 when the resulting archive passes both invariant gates
 * (no duplicate ids AND identity-consistent), 1 otherwise.
 */

const fs = require("fs");
const path = require("path");
const Store = require("./pipeline/store.js");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const positional = [];
let backupDir = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--backup") {
    backupDir = args[i + 1] ? path.resolve(args[i + 1]) : null;
    i++;
  } else if (!args[i].startsWith("--")) {
    positional.push(args[i]);
  }
}
const TARGET = positional[0] ? path.resolve(positional[0]) : Store.DEFAULT_DB_DIR;

function run() {
  console.log(`Target archive: ${TARGET}`);
  console.log(`Mode: ${dryRun ? "DRY-RUN (no files written)" : "apply"}`);

  if (backupDir) {
    const dayDir = path.join(TARGET, "days");
    const runsDir = path.join(TARGET, "runs");
    const indexFile = path.join(TARGET, "index.json");
    fs.mkdirSync(backupDir, { recursive: true });
    const copyTree = (src, rel) => {
      if (!fs.existsSync(src)) return;
      const target = path.join(backupDir, rel, path.basename(src));
      if (fs.statSync(src).isDirectory()) {
        fs.mkdirSync(target, { recursive: true });
        for (const n of fs.readdirSync(src)) copyTree(path.join(src, n), rel);
      } else {
        fs.copyFileSync(src, target);
      }
    };
    if (fs.existsSync(dayDir)) copyTree(dayDir, "days");
    if (fs.existsSync(runsDir)) copyTree(runsDir, "runs");
    if (fs.existsSync(indexFile)) copyTree(indexFile, ".");
    console.log(`Backup written to: ${backupDir}`);
  }

  const beforeIds = Store.assertNoDuplicateIds(TARGET);
  const beforeIdentity = Store.assertIdentityConsistent(TARGET);
  console.log(
    `Before: ${beforeIds.checked} rows, ${beforeIds.duplicates.length} duplicate-id groups, ` +
      `${beforeIdentity.inconsistent.length} identity-mismatched rows.`
  );

  if (!dryRun && backupDir) {
    fs.writeFileSync(
      path.join(backupDir, "before.json"),
      JSON.stringify({ duplicates: beforeIds.duplicates, inconsistent: beforeIdentity.inconsistent }, null, 2)
    );
  }

  const stats = Store.rekeyArchive(TARGET, { write: !dryRun });
  console.log("Sweep stats:", JSON.stringify(stats, null, 2));

  const afterIds = Store.assertNoDuplicateIds(TARGET);
  const afterIdentity = Store.assertIdentityConsistent(TARGET);
  console.log(
    `After: ${afterIds.checked} rows, ${afterIds.duplicates.length} duplicate-id groups, ` +
      `${afterIdentity.inconsistent.length} identity-mismatched rows.`
  );

  const clean = afterIds.duplicates.length === 0 && afterIdentity.inconsistent.length === 0;
  if (dryRun) {
    console.log(clean ? "[OK] Dry-run clean: archive would be fully consistent after apply." : "[!!] Dry-run NOT clean - see After counts.");
    return clean ? 0 : 1;
  }

  if (stats.danger) {
    console.log("[WARN] danger rows preserved under legacy ids: " + stats.danger);
    for (const d of stats.dangerIds) {
      console.log(`  ${d.id} (${d.day}) -> clean ${d.cleanId}: "${d.title}"`);
    }
  }
  if (stats.idCollisions.length) {
    console.log("[WARN] day-level id collisions dropped (pathological): " + stats.idCollisions.length);
    for (const c of stats.idCollisions) console.log(`  ${c.id} (${c.day}): "${c.title}"`);
  }

  if (stats.danger || stats.idCollisions.length || !clean) {
    console.log("[!!] Sweep incomplete - investigate the reports above.");
    return 1;
  }

  console.log(
    `[OK] Sweep finished. ${stats.inputRows} -> ${stats.inputRows - stats.merged} rows ` +
      `(${stats.merged} duplicate copies merged, ${stats.rekeyed} re-keyed, ${stats.moved} re-bucketed, ` +
      `${afterIds.checked} final, 0 duplicate ids, identity-consistent).`
  );
  return 0;
}

process.exitCode = run();