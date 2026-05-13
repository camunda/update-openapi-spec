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
import { parseDocument } from "yaml";

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

// ── Phase 3: translate to upstream and write annotations ─────────────────────

// Load each upstream YAML once. We parse it as a Document (for locating
// node byte ranges) but do NOT re-serialize — instead we splice
// `x-added-in-version` lines into the original text, preserving every
// untouched byte and avoiding the `yaml` library's tendency to reflow
// folded scalars and other formatting around mutated mappings.
const upstreamFiles = readdirSync(specDir).filter((f) => f.endsWith(".yaml"));
const upstreamDocs = new Map();
const upstreamText = new Map();
for (const file of upstreamFiles) {
  const text = readFileSync(join(specDir, file), "utf-8");
  upstreamDocs.set(file, parseDocument(text));
  upstreamText.set(file, text);
}

// Group planned annotations by upstream file. Paths are taken verbatim from
// the version-map; no translation is performed.
const byFile = new Map();
for (const ann of toAnnotate.values()) {
  if (!byFile.has(ann.file)) byFile.set(ann.file, []);
  byFile.get(ann.file).push({ path: ann.inFilePath, intro: ann.intro });
}

let filesWritten = 0;
let annotationsWritten = 0;
let annotationsAlreadyPresent = 0;
let annotationsTargetMissing = 0;

for (const [file, anns] of byFile) {
  const doc = upstreamDocs.get(file);
  const content = upstreamText.get(file);
  if (!doc || content == null) {
    annotationsTargetMissing += anns.length;
    continue;
  }

  // Compute insertions. Each insertion is { offset, line } where `offset`
  // is the byte position at which to splice and `line` is the full text
  // (indentation + key/value + newline) to insert.
  const insertions = [];
  const seenPaths = new Set();
  for (const ann of anns) {
    const pathStr = ann.path.join("\x00");
    if (seenPaths.has(pathStr)) continue;
    seenPaths.add(pathStr);

    const target = doc.getIn(ann.path, true);
    if (target == null) {
      annotationsTargetMissing++;
      if (process.env.VERIFY_DEBUG) {
        console.warn(`  MISS ${file}: ${ann.path.join("/")} (intro ${ann.intro})`);
      }
      continue;
    }

    // Skip if the annotation is already present with the same version.
    const existingAnn = doc.getIn([...ann.path, "x-added-in-version"]);
    if (existingAnn === ann.intro) {
      annotationsAlreadyPresent++;
      continue;
    }

    // Locate the property's own mapping (or scalar). When the target is a
    // mapping/sequence, its `range` is `[startOffset, valueEndOffset,
    // nodeEndOffset]`. For scalar values we need the parent property entry
    // — but in practice every annotatable property has a mapping body
    // (description / type / $ref / allOf etc), so target.range is defined.
    const range = target.range;
    if (!range) {
      annotationsTargetMissing++;
      continue;
    }
    const nodeStart = range[0];

    // Indentation: distance from the start of the line to the node's first
    // character. For a property entry whose key is "$eq" the YAML library
    // points `nodeStart` at the value column, so we instead compute the
    // indentation of the property's key line by walking back from the
    // parent map's child entry. For simplicity, derive indentation from
    // the column of `nodeStart` on its line.
    const lineStart = content.lastIndexOf("\n", nodeStart - 1) + 1;
    const indent = " ".repeat(Math.max(0, nodeStart - lineStart));

    // Splice point: end of the node's content, snapped to the end of the
    // line containing the last non-whitespace byte. This places the new
    // annotation as the final sibling key of the mapping, immediately
    // after its existing keys and BEFORE any trailing blank lines.
    const nodeEnd = range[2] ?? range[1];
    let insertAt = nodeEnd;
    while (
      insertAt > nodeStart
      && (content[insertAt - 1] === "\n" || content[insertAt - 1] === " ")
    ) {
      insertAt--;
    }
    const eolIdx = content.indexOf("\n", insertAt);
    insertAt = eolIdx === -1 ? content.length : eolIdx + 1;

    insertions.push({
      offset: insertAt,
      line: `${indent}x-added-in-version: "${ann.intro}"\n`,
    });
  }

  if (insertions.length === 0) continue;

  // Apply insertions in reverse offset order so earlier offsets stay valid.
  insertions.sort((a, b) => b.offset - a.offset);
  let result = content;
  for (const { offset, line } of insertions) {
    result = result.slice(0, offset) + line + result.slice(offset);
  }

  writeFileSync(join(specDir, file), result, "utf-8");
  filesWritten++;
  annotationsWritten += insertions.length;
  console.log(`  ✓  ${file} (${insertions.length} annotations)`);
}

console.log(
  `\nDone – ${annotationsWritten} annotations written across ${filesWritten} files` +
    `, ${annotationsAlreadyPresent} already present` +
    (annotationsTargetMissing
      ? `, ${annotationsTargetMissing} target nodes missing`
      : "")
);
