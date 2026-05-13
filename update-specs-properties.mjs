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
import { parseDocument, parse as parseYaml } from "yaml";

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

/**
 * Nearest enclosing property location of `inFilePath`, expressed as the path
 * ending at `["properties", <name>]`. Returns null when there is none.
 */
function ancestorLocation(file, inFilePath) {
  const n = inFilePath.length;
  if (n < 4) return null;
  if (inFilePath[n - 2] !== "properties") return null;
  for (let i = n - 4; i >= 0; i--) {
    if (inFilePath[i] === "properties" && typeof inFilePath[i + 1] === "string") {
      const slice = inFilePath.slice(0, i + 2);
      return { file, inFilePath: slice, key: locationKey(file, slice) };
    }
  }
  return null;
}

/**
 * Translate a "bundled" path (recorded in version-map relative to the
 * Redocly-bundled spec, where cross-file `$ref`s and `allOf:[{$ref}]` nodes
 * have been inlined) into the corresponding location in the multi-file
 * upstream YAMLs. Returns `{ file, path }` pointing at the actual definition
 * node, or null when no translation is possible.
 *
 * Implemented as a depth-first search with backtracking so that when several
 * `allOf` branches could match `nextSeg`, every branch is tried until one
 * resolves the FULL remaining path.
 */
function translateToUpstream(upstreamData, startFile, bundledPath) {
  const visitedRefs = new Set();

  function parseRef(ref) {
    if (typeof ref !== "string") return null;
    const hashIdx = ref.indexOf("#");
    if (hashIdx < 0 || !ref.slice(hashIdx).startsWith("#/")) return null;
    const filePart = ref.slice(0, hashIdx);
    const path = ref
      .slice(hashIdx + 2)
      .split("/")
      .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
    return { filePart, path };
  }

  function getAt(obj, path) {
    let node = obj;
    for (const seg of path) {
      if (node == null || typeof node !== "object") return undefined;
      node = node[seg];
    }
    return node;
  }

  /**
   * Recursively resolve `remaining` starting from `(file, path)`. Returns
   * `{ file, path }` on success, null otherwise.
   */
  function walk(file, path, remaining) {
    const obj = upstreamData.get(file);
    if (!obj) return null;
    const here = getAt(obj, path);

    // Dereference $ref nodes encountered along the way, but only when there
    // is still remaining path to navigate. The final node is the annotation
    // target itself; we want to attach `x-added-in-version` to the local
    // property even when its only payload is a `$ref` to a shared schema.
    if (
      remaining.length > 0
      && here && typeof here === "object"
      && typeof here.$ref === "string"
    ) {
      const ref = parseRef(here.$ref);
      if (!ref) return null;
      const refKey = `${file}::${here.$ref}`;
      if (visitedRefs.has(refKey)) return null;
      visitedRefs.add(refKey);
      const targetFile = ref.filePart || file;
      const result = walk(targetFile, ref.path, remaining);
      visitedRefs.delete(refKey);
      return result;
    }

    if (remaining.length === 0) {
      return { file, path };
    }

    const nextSeg = remaining[0];
    const rest = remaining.slice(1);

    // Direct navigation.
    if (here && typeof here === "object" && nextSeg in here) {
      // For `allOf/<idx>` verify the upstream index actually exists.
      if (nextSeg === "allOf" && rest.length >= 1 && /^\d+$/.test(String(rest[0]))) {
        const idx = Number(rest[0]);
        if (Array.isArray(here.allOf) && here.allOf[idx] !== undefined) {
          const r = walk(file, [...path, "allOf", String(idx)], rest.slice(1));
          if (r) return r;
        }
      } else {
        const r = walk(file, [...path, nextSeg], rest);
        if (r) return r;
      }
    }

    // Recovery 1: the bundler expanded `allOf: [{ $ref }]` by absorbing the
    // ref's contents into a sibling allOf entry. When the bundled path
    // would consume an `allOf/<idx>` pair that doesn't line up upstream,
    // try following the upstream allOf's `$ref` branch and skip the
    // `allOf/<idx>` pair.
    if (
      nextSeg === "allOf"
      && rest.length >= 1
      && /^\d+$/.test(String(rest[0]))
      && here && typeof here === "object"
      && Array.isArray(here.allOf)
    ) {
      for (const branch of here.allOf) {
        if (branch && typeof branch === "object" && typeof branch.$ref === "string") {
          const ref = parseRef(branch.$ref);
          if (!ref) continue;
          const refKey = `${file}::allOf::${branch.$ref}`;
          if (visitedRefs.has(refKey)) continue;
          visitedRefs.add(refKey);
          const targetFile = ref.filePart || file;
          const r = walk(targetFile, ref.path, rest.slice(1));
          visitedRefs.delete(refKey);
          if (r) return r;
        }
      }
    }

    // Recovery 2: bundler inlined a `$ref` from an `allOf` branch by absorbing
    // its properties directly into the parent. Scan every allOf branch for
    // one that can resolve `nextSeg` and the full remaining path.
    if (here && typeof here === "object" && Array.isArray(here.allOf)) {
      for (let i = 0; i < here.allOf.length; i++) {
        const branch = here.allOf[i];
        if (!branch || typeof branch !== "object") continue;
        if (typeof branch.$ref === "string") {
          const ref = parseRef(branch.$ref);
          if (!ref) continue;
          const refKey = `${file}::allOf-inline::${branch.$ref}`;
          if (visitedRefs.has(refKey)) continue;
          visitedRefs.add(refKey);
          const targetFile = ref.filePart || file;
          const r = walk(targetFile, ref.path, remaining);
          visitedRefs.delete(refKey);
          if (r) return r;
        } else if (nextSeg in branch) {
          const r = walk(file, [...path, "allOf", String(i), nextSeg], rest);
          if (r) return r;
        }
      }
    }

    return null;
  }

  return walk(startFile, [], bundledPath);
}

// ── Load inputs ──────────────────────────────────────────────────────────────

console.log(`Annotating properties in ${specDir} ...\n`);

const versionMap = JSON.parse(readFileSync(versionMapPath, "utf-8"));

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
    };
    locations.set(key, loc);
  } else if (compareVersions(entry.version, loc.intro) < 0) {
    loc.intro = entry.version;
  }
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
  const ancestor = ancestorLocation(loc.file, loc.inFilePath);
  if (ancestor) {
    const ancestorLoc = locations.get(ancestor.key);
    if (ancestorLoc && ancestorLoc.intro === loc.intro) {
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

// Load each upstream YAML twice: as plain data (for cross-file path
// translation) and as a Document (for locating node ranges). We do NOT
// re-serialize the Document — instead we use it to find byte ranges and
// then splice `x-added-in-version` lines into the original text. This
// preserves every byte of the file we don't deliberately touch, avoiding
// the `yaml` library's tendency to reflow folded scalars and other
// formatting near a mutated mapping.
const upstreamFiles = readdirSync(specDir).filter((f) => f.endsWith(".yaml"));
const upstreamData = new Map();
const upstreamDocs = new Map();
const upstreamText = new Map();
for (const file of upstreamFiles) {
  const text = readFileSync(join(specDir, file), "utf-8");
  upstreamData.set(file, parseYaml(text));
  upstreamDocs.set(file, parseDocument(text));
  upstreamText.set(file, text);
}

const byFile = new Map();
let translationFailures = 0;
for (const ann of toAnnotate.values()) {
  const translated = translateToUpstream(upstreamData, ann.file, ann.inFilePath);
  if (!translated) {
    translationFailures++;
    if (process.env.VERIFY_DEBUG) {
      console.warn(
        `  UNRESOLVABLE ${ann.file}: ${ann.inFilePath.join("/")} (intro ${ann.intro})`
      );
    }
    continue;
  }
  if (!byFile.has(translated.file)) byFile.set(translated.file, []);
  byFile.get(translated.file).push({ path: translated.path, intro: ann.intro });
}

if (translationFailures > 0) {
  console.log(
    `Annotation paths that could not be translated to upstream: ${translationFailures}`
  );
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
