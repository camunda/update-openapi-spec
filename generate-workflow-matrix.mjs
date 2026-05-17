#!/usr/bin/env node
/**
 * generate-workflow-matrix.mjs
 *
 * Stress-tests verify-specs-ci.mjs by generating a 3x3 matrix of
 * pairwise rule-violation scenarios.
 *
 *   row    = first rule to violate
 *   column = second rule to violate
 *
 * For cell (ruleA, ruleB) the script:
 *   1. copies the spec dir (OCA_SPEC_PATH) to a fresh temp dir,
 *   2. picks a property location currently classified as suppressed-by-ruleA
 *      and injects a wrong x-properties-added-in-version entry there,
 *   3. picks a DIFFERENT location classified as suppressed-by-ruleB and
 *      injects another wrong entry there,
 *   4. runs verify-specs-ci.mjs against the mutated copy,
 *   5. parses the markdown report to discover which rules were caught.
 *
 * The diagonal (ruleA == ruleB) uses two distinct locations both
 * suppressed by the same rule. Each off-diagonal cell uses one location
 * per rule.
 *
 * Output:
 *   - ASCII matrix to stdout (✅ both caught / ⚠ partial / ❌ missed / N/A)
 *   - Markdown copy at output/workflow-matrix.md
 *
 * Env: OCA_SPEC_PATH, VERSION_MAP_PATH, ENDPOINT_MAP_PATH (same as
 * verify-specs-ci.mjs).
 */

import "dotenv/config";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const specDir = process.env.OCA_SPEC_PATH;
const versionMapPath = process.env.VERSION_MAP_PATH;
const endpointMapPath = process.env.ENDPOINT_MAP_PATH;

if (!specDir || !versionMapPath || !endpointMapPath) {
  console.error(
    "Missing required env variables. Set OCA_SPEC_PATH, VERSION_MAP_PATH, and ENDPOINT_MAP_PATH."
  );
  process.exit(1);
}

const versionMap = JSON.parse(readFileSync(versionMapPath, "utf-8"));
const endpointMap = JSON.parse(readFileSync(endpointMapPath, "utf-8"));

const BOGUS_VERSION = "9.99";
const RULES = ["rule1", "rule2", "rule3"];

// Candidate pool ordering: always shuffled with a seeded PRNG so different
// runs exercise different YAMLs. Set MATRIX_SEED=<int> to reproduce a
// specific run; otherwise the seed defaults to Date.now() and is logged.
const SEED = process.env.MATRIX_SEED
  ? Number(process.env.MATRIX_SEED) >>> 0
  : Date.now() >>> 0;

// mulberry32 — small seeded PRNG, good enough for shuffling a candidate list.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

// ── Replicate verify-specs-ci.mjs classifier ────────────────────────────────

function loadYaml(dir, file) {
  try {
    return parse(readFileSync(join(dir, file), "utf-8"));
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function resolveFileAndPath(propPath, endpointPath) {
  if (!propPath || propPath.length === 0) return null;
  if (typeof propPath[0] === "string" && propPath[0].endsWith(".yaml")) {
    return { file: propPath[0], inFilePath: propPath.slice(1) };
  }
  if (typeof endpointPath?.[0] === "string" && endpointPath[0].endsWith(".yaml")) {
    return { file: endpointPath[0], inFilePath: propPath };
  }
  return null;
}

function locationKey(file, inFilePath) {
  return `${file}\x00${inFilePath.join("\x00")}`;
}

function classifyLocations() {
  const parentOf = new Map();
  for (const [propKey, entry] of Object.entries(versionMap.properties || {})) {
    for (const childKey of entry.children || []) parentOf.set(childKey, propKey);
  }

  const locations = new Map();
  for (const [propKey, entry] of Object.entries(versionMap.properties || {})) {
    if (versionMap.deletedProperties?.[propKey]) continue;
    const epInfo = versionMap.operations?.[entry.endpoint];
    const resolved = resolveFileAndPath(entry.path, epInfo?.path);
    if (!resolved) continue;
    const key = locationKey(resolved.file, resolved.inFilePath);
    let loc = locations.get(key);
    if (!loc) {
      loc = {
        file: resolved.file,
        inFilePath: resolved.inFilePath,
        intro: entry.version,
        endpointVersions: new Set(),
        consumerEndpoints: new Set(),
        propKeys: [],
      };
      locations.set(key, loc);
    } else if (compareVersions(entry.version, loc.intro) < 0) {
      loc.intro = entry.version;
    }
    loc.propKeys.push(propKey);
    loc.endpointVersions.add(epInfo?.version ?? null);
    if (entry.endpoint) loc.consumerEndpoints.add(entry.endpoint);
  }

  const locationKeyOfPropEntry = (entry) => {
    if (!entry) return null;
    const epInfo = versionMap.operations?.[entry.endpoint];
    const r = resolveFileAndPath(entry.path, epInfo?.path);
    return r ? locationKey(r.file, r.inFilePath) : null;
  };

  const classified = new Map();
  for (const [key, loc] of locations) {
    const allMatch =
      loc.endpointVersions.size > 0 &&
      [...loc.endpointVersions].every((v) => v === loc.intro);
    if (allMatch) {
      const reason = loc.consumerEndpoints.size <= 1 ? "rule1" : "rule3";
      classified.set(key, { ...loc, reason });
      continue;
    }
    const parentLocKeys = new Set();
    let everyHasParent = loc.propKeys.length > 0;
    for (const pk of loc.propKeys) {
      const parentKey = parentOf.get(pk);
      if (!parentKey) { everyHasParent = false; break; }
      const plk = locationKeyOfPropEntry(versionMap.properties[parentKey]);
      if (!plk) { everyHasParent = false; break; }
      parentLocKeys.add(plk);
    }
    if (everyHasParent && parentLocKeys.size > 0) {
      const ok = [...parentLocKeys].every((pk) => {
        const pl = locations.get(pk);
        return pl && pl.intro === loc.intro;
      });
      if (ok) {
        classified.set(key, { ...loc, reason: "rule2" });
        continue;
      }
    }
    classified.set(key, { ...loc, reason: "annotate" });
  }
  return classified;
}

// ── Candidate picking ───────────────────────────────────────────────────────

// We only mutate `properties/<name>` style locations because the verifier's
// fix-hints assume that shape, and so does our injection helper.
function isPropertyChildLocation(loc) {
  const p = loc.inFilePath;
  return p.length >= 2 && p[p.length - 2] === "properties";
}

function pickCandidatesByRule(classified) {
  const byRule = { rule1: [], rule2: [], rule3: [] };
  for (const loc of classified.values()) {
    if (!RULES.includes(loc.reason)) continue;
    if (!isPropertyChildLocation(loc)) continue;
    byRule[loc.reason].push(loc);
  }
  // Sort first for stability, then shuffle each rule's pool with an
  // independent PRNG stream so different runs exercise different YAMLs
  // (reproducible via MATRIX_SEED).
  for (const r of RULES) {
    byRule[r].sort((a, b) => {
      const f = a.file.localeCompare(b.file);
      return f !== 0 ? f : a.inFilePath.join("/").localeCompare(b.inFilePath.join("/"));
    });
  }
  for (let i = 0; i < RULES.length; i++) {
    shuffleInPlace(byRule[RULES[i]], makeRng((SEED + i * 0x9e3779b1) >>> 0));
  }
  return byRule;
}

// Pick `n` distinct locations from `pool` whose (file, parent-path) keys are
// all distinct from each other AND from `excludeKeys`. Distinct parent-path
// avoids two injections colliding on the same `x-properties-added-in-version`
// list, which would still work but would make the report harder to attribute.
function pickDistinct(pool, n, excludeKeys) {
  const result = [];
  const used = new Set(excludeKeys);
  for (const loc of pool) {
    const parentKey = `${loc.file}::${loc.inFilePath.slice(0, -1).join("/")}`;
    if (used.has(parentKey)) continue;
    result.push(loc);
    used.add(parentKey);
    if (result.length === n) break;
  }
  return result;
}

// ── Mutation ────────────────────────────────────────────────────────────────

function injectBogusAnnotation(workSpecDir, loc) {
  const filePath = join(workSpecDir, loc.file);
  const doc = parse(readFileSync(filePath, "utf-8"));
  const parentPath = loc.inFilePath.slice(0, -2); // strip ['properties', name]
  const propName = loc.inFilePath[loc.inFilePath.length - 1];
  let node = doc;
  for (const seg of parentPath) {
    if (node == null || typeof node !== "object") {
      throw new Error(`Path not found: ${loc.file} :: ${loc.inFilePath.join("/")}`);
    }
    node = node[seg];
  }
  if (node == null || typeof node !== "object") {
    throw new Error(`Parent node missing: ${loc.file} :: ${parentPath.join("/")}`);
  }
  const hadList = Array.isArray(node["x-properties-added-in-version"]);
  const list = hadList ? node["x-properties-added-in-version"] : [];
  // If an entry already exists for this property, replace its version;
  // otherwise append.
  let previousVersion = null;
  let action = hadList ? "appended-entry" : "created-list-and-entry";
  for (const entry of list) {
    if (entry && typeof entry === "object" && entry.propertyName === propName) {
      previousVersion = entry.addedInVersion ?? null;
      entry.addedInVersion = BOGUS_VERSION;
      action = "overwrote-existing-entry";
      break;
    }
  }
  if (action !== "overwrote-existing-entry") {
    list.push({ propertyName: propName, addedInVersion: BOGUS_VERSION });
  }
  node["x-properties-added-in-version"] = list;
  writeFileSync(filePath, stringify(doc));
  return {
    file: loc.file,
    parentPath: parentPath.join("/"),
    propertyName: propName,
    action,
    previousVersion,
    newVersion: BOGUS_VERSION,
    expectedReason: loc.reason,
    aggregatedIntro: loc.intro,
  };
}

// ── Verifier invocation + report parsing ────────────────────────────────────

function runVerifier(workSpecDir, reportPath) {
  const result = spawnSync(
    process.execPath,
    [join(scriptDir, "verify-specs-ci.mjs")],
    {
      env: {
        ...process.env,
        OCA_SPEC_PATH: workSpecDir,
        VERSION_MAP_PATH: versionMapPath,
        ENDPOINT_MAP_PATH: endpointMapPath,
        REPORT_PATH: reportPath,
      },
      encoding: "utf-8",
    }
  );
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

// Parse the `### Rules broken` section to discover which rules the verifier
// reported. Falls back to scanning suppressedBy= entries elsewhere.
function rulesReportedFromMarkdown(md) {
  const reported = new Set();
  // Heuristic: lines listing "Rule N" in the rules-broken section or
  // suppressedBy=`ruleN` markers in the error blocks.
  for (const m of md.matchAll(/suppressedBy=`(rule[123])`/g)) {
    reported.add(m[1]);
  }
  for (const m of md.matchAll(/Rule\s+([123])\s+—/g)) {
    reported.add(`rule${m[1]}`);
  }
  return reported;
}

// ── Main ────────────────────────────────────────────────────────────────────

console.log("Classifying property locations against version-map…");
const classified = classifyLocations();
const byRule = pickCandidatesByRule(classified);

console.log(
  `Available property-child locations per rule: ` +
    RULES.map((r) => `${r}=${byRule[r].length}`).join(", ")
);
console.log(`Pool order: shuffled (seed=${SEED}; set MATRIX_SEED to reproduce)`);

for (const r of RULES) {
  if (byRule[r].length === 0) {
    console.error(`No candidate location found for ${r}. Aborting.`);
    process.exit(1);
  }
}

const baseTmp = mkdtempSync(join(tmpdir(), "workflow-matrix-"));
console.log(`Workspace: ${baseTmp}`);

const matrix = {}; // matrix[rowRule][colRule] = { expected, reported, status, locations }

try {
  for (const rowRule of RULES) {
    matrix[rowRule] = {};
    for (const colRule of RULES) {
      const need = rowRule === colRule ? 2 : 1;

      let rowLocs = pickDistinct(byRule[rowRule], need, new Set());
      const excludeKeys = new Set(
        rowLocs.map((l) => `${l.file}::${l.inFilePath.slice(0, -1).join("/")}`)
      );
      let colLocs = rowRule === colRule ? [] : pickDistinct(byRule[colRule], 1, excludeKeys);

      if (rowLocs.length < need || (rowRule !== colRule && colLocs.length < 1)) {
        matrix[rowRule][colRule] = {
          expected: rowRule === colRule ? new Set([rowRule]) : new Set([rowRule, colRule]),
          reported: new Set(),
          status: "N/A",
          locations: [],
          mutations: [],
        };
        continue;
      }

      const scenarioName = `${rowRule}__${colRule}`;
      const workDir = join(baseTmp, scenarioName);
      cpSync(specDir, workDir, { recursive: true });

      const locsToMutate = [...rowLocs, ...colLocs];
      const mutations = locsToMutate.map((loc) => injectBogusAnnotation(workDir, loc));

      const reportPath = join(baseTmp, `${scenarioName}.md`);
      const { exitCode } = runVerifier(workDir, reportPath);
      const md = readFileSync(reportPath, "utf-8");
      const reported = rulesReportedFromMarkdown(md);

      const expected = new Set(
        rowRule === colRule ? [rowRule] : [rowRule, colRule]
      );
      const missing = [...expected].filter((r) => !reported.has(r));
      const status =
        exitCode === 0
          ? "❌ no-error"
          : missing.length === 0
            ? "✅"
            : `⚠ missed:${missing.join(",")}`;

      matrix[rowRule][colRule] = {
        expected,
        reported,
        status,
        locations: locsToMutate.map((l) => `${l.file}#${l.inFilePath.join("/")}`),
        mutations,
      };

      for (const m of mutations) {
        const prev = m.previousVersion == null ? "(none)" : `"${m.previousVersion}"`;
        console.log(
          `  [${rowRule}×${colRule}] ${m.file} :: ${m.parentPath} ` +
            `${m.propertyName}: ${prev} → "${m.newVersion}" (${m.action})`
        );
      }
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const lines = [];
  const colWidths = RULES.map((r) =>
    Math.max(
      r.length,
      ...RULES.map((row) => matrix[row][r].status.length)
    )
  );
  const headerCells = RULES.map((r, i) => r.padEnd(colWidths[i]));
  const rowLabelWidth = Math.max(...RULES.map((r) => r.length));
  lines.push(
    " ".repeat(rowLabelWidth + 2) + headerCells.join(" | ")
  );
  lines.push(
    "-".repeat(rowLabelWidth) +
      "--+-" +
      colWidths.map((w) => "-".repeat(w)).join("-+-")
  );
  for (const row of RULES) {
    const cells = RULES.map((col, i) => matrix[row][col].status.padEnd(colWidths[i]));
    lines.push(row.padEnd(rowLabelWidth) + "  " + cells.join(" | "));
  }

  console.log("");
  console.log("Workflow robustness matrix (rows = first rule violated, cols = second):");
  console.log("");
  for (const line of lines) console.log(line);
  console.log("");
  console.log("Legend: ✅ both expected rules reported · ⚠ partial · ❌ verifier exited 0 · N/A insufficient candidates");

  // Markdown report
  const md = [];
  md.push("# Workflow robustness matrix");
  md.push("");
  md.push(
    "Stress-tests `verify-specs-ci.mjs` by injecting pairs of bogus " +
      "`x-properties-added-in-version` entries on locations that the " +
      "classifier currently treats as suppressed under each rule, then " +
      "checking that the verifier reports both rule violations."
  );
  md.push("");
  md.push("## Matrix");
  md.push("");
  md.push("|        | " + RULES.join(" | ") + " |");
  md.push("|--------|" + RULES.map(() => "-------").join("|") + "|");
  for (const row of RULES) {
    md.push(
      "| **" + row + "** | " +
        RULES.map((col) => matrix[row][col].status).join(" | ") +
        " |"
    );
  }
  md.push("");
  md.push("## Scenario details");
  md.push("");
  for (const row of RULES) {
    for (const col of RULES) {
      const cell = matrix[row][col];
      md.push(`### ${row} × ${col} — ${cell.status}`);
      md.push("");
      md.push(`- Expected rules reported: ${[...cell.expected].join(", ") || "(none)"}`);
      md.push(`- Rules reported by verifier: ${[...cell.reported].join(", ") || "(none)"}`);
      if (cell.locations.length) {
        md.push("- Mutated locations:");
        for (const l of cell.locations) md.push(`  - \`${l}\``);
      }
      if (cell.mutations && cell.mutations.length) {
        md.push("- Mutations applied:");
        for (const m of cell.mutations) {
          const prev =
            m.previousVersion == null ? "(none)" : `"${m.previousVersion}"`;
          md.push(
            `  - \`${m.file}\` → \`${m.parentPath}\`'s ` +
              `\`x-properties-added-in-version[propertyName=${m.propertyName}]\`: ` +
              `${prev} → \`"${m.newVersion}"\` ` +
              `(${m.action}; suppressed by ${m.expectedReason}; aggregated intro \`${m.aggregatedIntro}\`)`
          );
        }
      }
      md.push("");
    }
  }

  const outPath = join(
    scriptDir,
    "output",
    `workflow-matrix-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .replace("Z", "")}.md`
  );
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, md.join("\n") + "\n");
  console.log("");
  console.log(`Markdown report: ${outPath}`);
} finally {
  rmSync(baseTmp, { recursive: true, force: true });
}
