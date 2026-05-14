#!/usr/bin/env node
/**
 * Adds `x-added-in-version` to schema properties in OpenAPI YAML spec files.
 *
 * Rules:
 *  - Properties listed in `deletedProperties` are NEVER annotated.
 *  - A property whose introduction version equals its endpoint's
 *    introduction version is NOT annotated (the endpoint's own
 *    `x-added-in-version` already covers it).
 *  - Only the highest-level ancestor introduced in a given version is
 *    annotated. Child properties added in the SAME version as their nearest
 *    property ancestor are skipped; children added LATER ARE annotated.
 *    The parent-child relation is taken from the version-map's `children`
 *    arrays (built from the qualifiedName tree), so it traverses `$ref`
 *    boundaries: e.g. `UserTaskSearchQuery.filter.state` is recognised as
 *    the parent of `AdvancedUserTaskStateFilter.$eq` even though the two
 *    live in different schemas.
 *  - For shared schemas referenced from multiple endpoints, the property's
 *    introduction version is the EARLIEST across all consumers, and the
 *    property is annotated unless every consumer endpoint's own
 *    introduction version equals that earliest version (in which case
 *    the endpoint-level annotation already covers it).
 *
 * Env variables:
 *   OCA_SPEC_PATH    – directory containing the upstream YAML spec files
 *                      (the multi-file v2/ layout). The version map's
 *                      property paths must match this layout.
 *   VERSION_MAP_PATH – path to version-map.json
 *
 * Optional:
 *   VERIFY_DEBUG=1   – log unresolvable annotation paths.
 */

import "dotenv/config";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, isMap, isSeq } from "yaml";

const specDir = process.env.OCA_SPEC_PATH;
const versionMapPath = process.env.VERSION_MAP_PATH;

if (!specDir || !versionMapPath) {
  console.error(
    "Missing required env variables. Set OCA_SPEC_PATH and VERSION_MAP_PATH."
  );
  process.exit(1);
}
if (!existsSync(specDir)) {
  console.error(`ERROR: OCA_SPEC_PATH directory not found: ${specDir}`);
  process.exit(1);
}
if (!existsSync(versionMapPath)) {
  console.error(`ERROR: version map not found: ${versionMapPath}`);
  process.exit(1);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

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

/**
 * Pick the source YAML file from a property/endpoint path. When the path
 * itself begins with a filename, use it; otherwise fall back to the endpoint's
 * source file (shared inline-schema case).
 */
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

// Note: version-map property paths are clean upstream paths (every entry
// resolves via `doc.getIn(path)` against the multi-file YAML). Phase 3 uses
// the upstream YAML strictly as the write target — no path translation is
// performed.

// ── Load inputs ──────────────────────────────────────────────────────────────

console.log(`Annotating properties in ${specDir} ...\n`);

const versionMap = JSON.parse(readFileSync(versionMapPath, "utf-8"));

// Build childPropKey → parentPropKey from the version-map's `children`
// arrays. These arrays are derived from each property's `qualifiedName`
// tree, so they capture parent/child relationships even when the parent and
// child live in different schemas connected by `$ref`.
const parentOf = new Map();
for (const [propKey, entry] of Object.entries(versionMap.properties)) {
  for (const childKey of entry.children || []) {
    parentOf.set(childKey, propKey);
  }
}

/**
 * Resolve the upstream location of a property entry, or null when the entry
 * is missing or unresolvable. Used to find a property's parent location
 * across `$ref` boundaries.
 */
function locationKeyOfPropEntry(entry) {
  if (!entry) return null;
  const epInfo = versionMap.operations?.[entry.endpoint];
  const r = resolveFileAndPath(entry.path, epInfo?.path);
  return r ? locationKey(r.file, r.inFilePath) : null;
}

// ── Phase 1: aggregate propKeys by schema location ───────────────────────────

const locations = new Map();
let propKeysSeen = 0;
let skippedDeleted = 0;
let skippedUnresolvable = 0;

for (const [propKey, entry] of Object.entries(versionMap.properties)) {
  propKeysSeen++;
  if (versionMap.deletedProperties?.[propKey]) {
    skippedDeleted++;
    continue;
  }
  const endpointInfo = versionMap.operations?.[entry.endpoint];
  const resolved = resolveFileAndPath(entry.path, endpointInfo?.path);
  if (!resolved) {
    skippedUnresolvable++;
    continue;
  }
  const key = locationKey(resolved.file, resolved.inFilePath);
  let loc = locations.get(key);
  if (!loc) {
    loc = {
      file: resolved.file,
      inFilePath: resolved.inFilePath,
      intro: entry.version,
      endpointVersions: new Set(),
      propKeys: [],
    };
    locations.set(key, loc);
  } else if (compareVersions(entry.version, loc.intro) < 0) {
    loc.intro = entry.version;
  }
  loc.propKeys.push(propKey);
  const endpointVersion = endpointInfo?.version;
  if (endpointVersion) {
    loc.endpointVersions.add(endpointVersion);
  } else {
    // Unknown endpoint version → cannot prove redundancy; force annotate.
    loc.endpointVersions.add(null);
  }
}

// ── Phase 2: apply parent-suppression rule ───────────────────────────────────

const toAnnotate = new Map();
let skippedSameAsEndpoint = 0;
let skippedSameAsAncestor = 0;

for (const [key, loc] of locations) {
  // Skip if EVERY consumer endpoint shares the chosen earliest intro
  // version — those endpoints' own `x-added-in-version` already covers it.
  const allEndpointsMatchIntro =
    loc.endpointVersions.size > 0
    && [...loc.endpointVersions].every((v) => v === loc.intro);
  if (allEndpointsMatchIntro) {
    skippedSameAsEndpoint++;
    continue;
  }
  // Resolve every aggregated propKey's logical parent location. The relation
  // comes from the version-map's `children` arrays (qualifiedName tree), so
  // it crosses `$ref` boundaries. Suppress only when every aggregated
  // propKey has a parent AND every distinct parent location shares the same
  // intro version as this location — only then can we be sure the parent's
  // annotation already covers this property at every consumer endpoint.
  const parentLocKeys = new Set();
  let everyPropHasParent = loc.propKeys.length > 0;
  for (const pk of loc.propKeys) {
    const parentKey = parentOf.get(pk);
    if (!parentKey) { everyPropHasParent = false; break; }
    const parentLocKey = locationKeyOfPropEntry(versionMap.properties[parentKey]);
    if (!parentLocKey) { everyPropHasParent = false; break; }
    parentLocKeys.add(parentLocKey);
  }
  if (everyPropHasParent && parentLocKeys.size > 0) {
    const allParentsMatch = [...parentLocKeys].every((pk) => {
      const pl = locations.get(pk);
      return pl && pl.intro === loc.intro;
    });
    if (allParentsMatch) {
      skippedSameAsAncestor++;
      continue;
    }
  }
  toAnnotate.set(key, { file: loc.file, inFilePath: loc.inFilePath, intro: loc.intro });
}

console.log(`Property keys considered: ${propKeysSeen}`);
console.log(`  Skipped (deleted): ${skippedDeleted}`);
console.log(`  Skipped (unresolvable file): ${skippedUnresolvable}`);
console.log(`Schema locations: ${locations.size}`);
console.log(`  Skipped (every consumer matches its endpoint version): ${skippedSameAsEndpoint}`);
console.log(`  Skipped (nearest ancestor has same intro version): ${skippedSameAsAncestor}`);
console.log(`  Annotations planned: ${toAnnotate.size}\n`);

// ── Phase 3: write parent-level x-added-in-version lists ────────────────────
//
// Annotations are written on the PARENT schema (the mapping that owns
// `properties`), not as a sibling of each individual property. The format
// is a sequence of `{ propertyName, addedInVersion }` objects, e.g.:
//
//   x-added-in-version:
//     - propertyName: kind
//       addedInVersion: "8.8"
//     - propertyName: tags
//       addedInVersion: "8.8"
//
// This avoids the OpenAPI 3.0 "siblings of $ref are ignored" pitfall and
// keeps each property definition free of extension keys (so Spectral's
// per-property rules apply unchanged).

// Load each upstream YAML once. We parse it as a Document (for locating
// node byte ranges) but do NOT re-serialize — instead we splice/replace
// regions of the original text, preserving every untouched byte and
// avoiding the `yaml` library's tendency to reflow folded scalars and
// other formatting around mutated mappings.
const upstreamFiles = readdirSync(specDir).filter((f) => f.endsWith(".yaml"));
const upstreamDocs = new Map();
const upstreamText = new Map();
for (const file of upstreamFiles) {
  const text = readFileSync(join(specDir, file), "utf-8");
  upstreamDocs.set(file, parseDocument(text));
  upstreamText.set(file, text);
}

// Group planned annotations by PARENT schema location (the path with
// the trailing `properties/<name>` segments stripped).
const byParent = new Map(); // parentKey -> { file, parentPath, entries: Map<propName, version> }
let skippedNonPropertyPath = 0;
for (const ann of toAnnotate.values()) {
  const p = ann.inFilePath;
  if (p.length < 2 || p[p.length - 2] !== "properties") {
    skippedNonPropertyPath++;
    if (process.env.VERIFY_DEBUG) {
      console.warn(
        `  SKIP non-property path ${ann.file}: ${p.join("/")} (intro ${ann.intro})`
      );
    }
    continue;
  }
  const propName = p[p.length - 1];
  const parentPath = p.slice(0, -2);
  const key = locationKey(ann.file, parentPath);
  let g = byParent.get(key);
  if (!g) {
    g = { file: ann.file, parentPath, entries: new Map() };
    byParent.set(key, g);
  }
  const existing = g.entries.get(propName);
  if (!existing || compareVersions(ann.intro, existing) < 0) {
    g.entries.set(propName, ann.intro);
  }
}

// Walk every YAMLMap in a doc and invoke `visitor(mapNode, keyPath)`. The
// keyPath uses scalar keys for map children and integer indices for seq
// children, matching the path shape produced by `resolveFileAndPath`.
function walkMaps(node, keyPath, visitor) {
  if (node == null) return;
  if (isMap(node)) {
    visitor(node, keyPath);
    for (const pair of node.items) {
      const k = pair.key?.value ?? pair.key;
      walkMaps(pair.value, [...keyPath, k], visitor);
    }
  } else if (isSeq(node)) {
    node.items.forEach((item, i) => walkMaps(item, [...keyPath, i], visitor));
  }
}

// Discover any parent schemas that already carry legacy per-property
// `x-added-in-version` entries (the previous format). We use this both to
// migrate them into the new parent-level list and to delete the stale
// per-property lines.
function findLegacyParents(doc) {
  const out = []; // [{ path, legacy: Map<propName, version> }]
  walkMaps(doc.contents, [], (mapNode, path) => {
    const propsPair = mapNode.items.find(
      (p) => (p.key?.value ?? p.key) === "properties"
    );
    if (!propsPair || !isMap(propsPair.value)) return;
    const legacy = new Map();
    for (const propPair of propsPair.value.items) {
      const v = propPair.value;
      if (!isMap(v)) continue;
      const annPair = v.items.find(
        (p) => (p.key?.value ?? p.key) === "x-added-in-version"
      );
      if (!annPair) continue;
      const propName = propPair.key?.value ?? propPair.key;
      const ver = annPair.value?.value ?? annPair.value;
      if (typeof ver === "string") legacy.set(propName, ver);
    }
    if (legacy.size > 0) out.push({ path, legacy });
  });
  return out;
}

// Quote a property name as a YAML scalar. Plain identifiers are emitted
// unquoted; anything else (e.g. `$eq`) is double-quoted.
function yamlPropName(name) {
  if (typeof name !== "string") return JSON.stringify(String(name));
  if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(name)) return name;
  return JSON.stringify(name);
}

// Group parents by file. A parent is processed if it has new annotations
// from the version map OR legacy per-property entries to migrate/clean up.
const groupsByFile = new Map();
for (const g of byParent.values()) {
  if (!groupsByFile.has(g.file)) groupsByFile.set(g.file, []);
  groupsByFile.get(g.file).push({ ...g, source: "new" });
}
for (const [file, doc] of upstreamDocs) {
  for (const { path, legacy } of findLegacyParents(doc)) {
    const key = locationKey(file, path);
    let group = byParent.get(key);
    if (!group) {
      group = { file, parentPath: path, entries: new Map() };
      byParent.set(key, group);
      if (!groupsByFile.has(file)) groupsByFile.set(file, []);
      groupsByFile.get(file).push({ ...group, source: "legacy-only" });
    }
    // Migrate legacy versions into the parent-level entries when the
    // version-map didn't produce a planned annotation for that property.
    // Planned (new) annotations always win, since the version map is the
    // source of truth for current introduction versions.
    for (const [name, ver] of legacy) {
      if (!group.entries.has(name)) group.entries.set(name, ver);
    }
  }
}

let filesWritten = 0;
let parentsWritten = 0;
let parentsTargetMissing = 0;

for (const [file, groups] of groupsByFile) {
  const doc = upstreamDocs.get(file);
  const content = upstreamText.get(file);
  if (!doc || content == null) {
    parentsTargetMissing += groups.length;
    continue;
  }

  // Each edit is a byte-range replacement: { from, to, text }. Deletions
  // use text === "". Edits are applied in reverse `from` order so earlier
  // offsets stay valid; ranges produced below do not overlap.
  const edits = [];

  for (const g of groups) {
    // Re-fetch from the canonical map so we always read the most up-to-date
    // entries (the byParent map may have been augmented by the legacy
    // migration loop after the initial groupsByFile push).
    const canonical = byParent.get(locationKey(g.file, g.parentPath));
    const entriesMap = canonical?.entries ?? g.entries;

    const parent = doc.getIn(g.parentPath, true);
    if (!parent || !isMap(parent)) {
      parentsTargetMissing++;
      if (process.env.VERIFY_DEBUG) {
        console.warn(
          `  MISS ${file}: ${g.parentPath.join("/")} (parent missing)`
        );
      }
      continue;
    }

    const propsPair = parent.items.find(
      (p) => (p.key?.value ?? p.key) === "properties"
    );
    const propsMap = isMap(propsPair?.value) ? propsPair.value : null;

    // Sort entries by their source order in `properties`, falling back to
    // alphabetical for properties not present in `properties` (shouldn't
    // happen for well-formed input, but is harmless).
    const order = new Map();
    if (propsMap) {
      propsMap.items.forEach((p, i) =>
        order.set(p.key?.value ?? p.key, i)
      );
    }
    const entries = [...entriesMap.entries()].sort((a, b) => {
      const oa = order.get(a[0]) ?? Number.MAX_SAFE_INTEGER;
      const ob = order.get(b[0]) ?? Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    });

    // Indentation = column of the parent's first child key.
    let childIndent = "";
    if (parent.items.length > 0) {
      const ks = parent.items[0].key?.range?.[0];
      if (ks != null) {
        const ls = content.lastIndexOf("\n", ks - 1) + 1;
        childIndent = " ".repeat(Math.max(0, ks - ls));
      }
    }
    const itemIndent = childIndent + "  ";
    const fieldIndent = childIndent + "    ";

    // Build the new x-added-in-version block (omitted entirely when the
    // entry list is empty — e.g. a legacy parent whose entries were all
    // suppressed by Phase 2).
    let block = "";
    if (entries.length > 0) {
      block = `${childIndent}x-added-in-version:\n`;
      for (const [name, ver] of entries) {
        block += `${itemIndent}- propertyName: ${yamlPropName(name)}\n`;
        block += `${fieldIndent}addedInVersion: "${ver}"\n`;
      }
    }

    // 1) Delete legacy per-property `x-added-in-version` lines under
    //    this parent's `properties` children.
    if (propsMap) {
      for (const propPair of propsMap.items) {
        const v = propPair.value;
        if (!isMap(v)) continue;
        const annPair = v.items.find(
          (p) => (p.key?.value ?? p.key) === "x-added-in-version"
        );
        if (!annPair) continue;
        const keyStart = annPair.key.range[0];
        const lineStart = content.lastIndexOf("\n", keyStart - 1) + 1;
        const valEnd = annPair.value?.range?.[1] ?? annPair.key.range[1];
        const eol = content.indexOf("\n", valEnd);
        const lineEnd = eol === -1 ? content.length : eol + 1;
        edits.push({ from: lineStart, to: lineEnd, text: "" });
      }
    }

    // 2) Replace existing parent-level `x-added-in-version`, or insert a
    //    new one at the end of the parent mapping. When `block` is empty
    //    the existing block is removed (and nothing is inserted).
    const existingPair = parent.items.find(
      (p) => (p.key?.value ?? p.key) === "x-added-in-version"
    );
    if (existingPair) {
      const keyStart = existingPair.key.range[0];
      const lineStart = content.lastIndexOf("\n", keyStart - 1) + 1;
      const valNode = existingPair.value;
      let endIdx =
        valNode?.range?.[2] ?? valNode?.range?.[1] ?? existingPair.key.range[1];
      if (endIdx > 0 && content[endIdx - 1] !== "\n") {
        const nl = content.indexOf("\n", endIdx);
        endIdx = nl === -1 ? content.length : nl + 1;
      }
      edits.push({ from: lineStart, to: endIdx, text: block });
    } else if (block.length > 0) {
      const parentEnd = parent.range[2] ?? parent.range[1];
      let insertAt = parentEnd;
      while (
        insertAt > parent.range[0]
        && (content[insertAt - 1] === "\n" || content[insertAt - 1] === " ")
      ) {
        insertAt--;
      }
      const nl = content.indexOf("\n", insertAt);
      insertAt = nl === -1 ? content.length : nl + 1;
      edits.push({ from: insertAt, to: insertAt, text: block });
    }

    if (entries.length > 0) parentsWritten++;
  }

  if (edits.length === 0) continue;

  // Apply edits in reverse `from` order so earlier offsets stay valid.
  edits.sort((a, b) => b.from - a.from);
  let result = content;
  for (const e of edits) {
    result = result.slice(0, e.from) + e.text + result.slice(e.to);
  }

  // Skip the write when applying edits is a no-op (idempotent re-runs).
  if (result === content) continue;

  writeFileSync(join(specDir, file), result, "utf-8");
  filesWritten++;
  console.log(`  ✓  ${file} (${groups.length} parent schemas updated)`);
}

console.log(
  `\nDone – ${parentsWritten} parent schemas annotated across ${filesWritten} files`
    + (skippedNonPropertyPath
      ? `, ${skippedNonPropertyPath} non-property paths skipped`
      : "")
    + (parentsTargetMissing
      ? `, ${parentsTargetMissing} parent nodes missing`
      : "")
);
