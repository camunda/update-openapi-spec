# update-openapi-spec

Adds two OpenAPI extensions to the Camunda 8 REST API spec files so consumers
know when each endpoint and field was introduced:

- `x-added-in-version` — a string on every **operation** (e.g.
  `x-added-in-version: '8.6'`).
- `x-properties-added-in-version` — a list on every **schema parent** that
  has versioned properties:
  ```yaml
  x-properties-added-in-version:
    - propertyName: name
      addedInVersion: '8.X'
  ```

## Related repos

| Repo | Role |
|------|------|
| [camunda/camunda](https://github.com/camunda/camunda) | Source of the multi-file OpenAPI specs (`zeebe/gateway-protocol/src/main/proto/v2/*.yaml`) — **updated in-place** by this tool |
| [return-of-api-added-in-analysis](https://github.com/camunda/return-of-api-added-in-analysis) | Generates `version-map.json` (which version each operation first appeared in) |
| [camunda-schema-bundler](https://github.com/camunda/camunda-schema-bundler) | Generates `endpoint-map.json` (which source YAML file each operation lives in) |

## Artefacts

| File | Description |
|------|-------------|
| `version-map.json` | Maps `"METHOD /path"` → first version (e.g. `"8.6"`) |
| `endpoint-map.json` | Maps `"METHOD /path"` → source YAML filename (e.g. `"jobs.yaml"`) |

## Steps to reproduce

```bash
# 1. Clone / pull the repos listed above

# 2. Install dependencies
npm install

# 3. Configure .env (or export the variables)
cat .env
# OCA_SPEC_PATH=/path/to/camunda/zeebe/gateway-protocol/src/main/proto/v2
# VERSION_MAP_PATH=./artefacts/version-map.json
# ENDPOINT_MAP_PATH=./artefacts/endpoint-map.json

# 4. Run
npm run update:operations   # annotates operations
npm run update:properties   # annotates schema properties
```

The first script reads every operation from `version-map.json`, looks up its
YAML file via `endpoint-map.json`, and writes
`x-added-in-version: '<version>'` into the operation object of the
corresponding spec file under `OCA_SPEC_PATH`.

The second script reads every schema property from `version-map.json` and
writes `x-properties-added-in-version` onto the corresponding parent in
`OCA_SPEC_PATH`. The rules below are applied in order, per **upstream
location** (after collapsing all bundled paths that resolve to the same node
in the multi-file YAMLs).

Property annotations are emitted on the **parent schema** as a list of
`{propertyName, addedInVersion}` entries (rather than as a sibling of each
property), so that the annotation never sits next to a `$ref` — which OAS
3.0 would silently ignore — and so Spectral's `require-property-descriptions`
rule still passes:

```yaml
ProcessInstanceResult:
  type: object
  properties:
    rootProcessInstanceKey:
      $ref: 'keys.yaml#/components/schemas/ProcessInstanceKey'
    businessId:
      $ref: 'identifiers.yaml#/components/schemas/BusinessId'
  x-properties-added-in-version:
    - propertyName: rootProcessInstanceKey
      addedInVersion: '8.9'
    - propertyName: businessId
      addedInVersion: '8.9'
```

Operation-level annotations remain a plain string sibling of the operation
object (e.g. `x-added-in-version: '8.6'`). The examples in the rules below
show the per-property annotation conceptually; on disk it is written in the
parent-list form above.

### Rule 0 — Deleted properties are skipped

Properties listed in `version-map.json` under `deletedProperties` are never
annotated, regardless of any other condition.

### Rule 1 — Property version differs from its endpoint version

A property is annotated only when its introduction version is **different
from** the endpoint's own introduction version. Same version ⇒ skipped, since
the endpoint-level `x-added-in-version` already covers it.

```yaml
# POST /jobs/activation introduced in 8.6
paths:
  /jobs/activation:
    post:
      x-added-in-version: '8.6'
      requestBody:
        content:
          application/json:
            schema:
              properties:
                type:        { type: string }                              # 8.6 — same as endpoint, NOT annotated
                worker:      { type: string }                              # 8.6 — NOT annotated
                tenantIds:   { type: array,  x-added-in-version: '8.7' }   # added later, annotated
```

### Rule 2 — Property version differs from its nearest property ancestor

Only the **highest-level ancestor** introduced in a given version is
annotated. A child added in the SAME version as its nearest property
ancestor is skipped (the ancestor already covers it). A child added in a
LATER version gets its own annotation.

The parent/child relation comes from `version-map.json`'s `children` arrays
(built from each property's `qualifiedName` tree), so it **traverses `$ref`
boundaries**. For example, `UserTaskSearchQuery.filter.state` (in
`user-tasks.yaml`) is recognised as the parent of
`AdvancedUserTaskStateFilter.$eq` (in a separately referenced schema), even
though the two properties live in different YAML files. Suppression only
fires when **every** aggregated consumer's parent location shares the same
intro version as the child — otherwise the child gets its own annotation.

```yaml
# endpoint introduced in 8.6
properties:
  result:
    x-added-in-version: '8.7'      # parent annotated (later than endpoint)
    type: object
    properties:
      variables:                   # 8.7 — same as parent, NOT annotated
        type: object
      denied:                      # 8.8 — later than parent, annotated
        type: boolean
        x-added-in-version: '8.8'
```

#### When parents disagree across consumers

Because Rule 3 aggregates each location independently, the same upstream
child can be reached by parents that resolve to **different** intro
versions. Suppression then only fires if **every** parent agrees with the
child.

Real example — `OffsetPagination.from` (in `search-models.yaml`) is
referenced by ~47 endpoints across versions 8.6–8.10, so its aggregated
intro is **8.6**. Two of its parents are:

| Parent location                                              | Consumers | Aggregated intro |
|--------------------------------------------------------------|-----------|------------------|
| `ProcessInstanceSearchQueryRequest.page` (8.6 endpoint)      | many      | **8.6**          |
| `UserTaskEffectiveVariableSearchQueryRequest.page` (8.8 only)| 1         | **8.8**          |

The 8.6 parent matches the child, but the 8.8 parent doesn't. Rule 2
therefore does **not** suppress, and `from` keeps its own annotation:

```yaml
# search-models.yaml
OffsetPagination:
  properties:
    from:
      type: integer
      x-added-in-version: '8.6'    # kept — one parent's intro (8.8) differs
```

If both parents had aggregated to 8.6, Rule 2 would have suppressed the
child annotation. This is exactly why `LimitPagination.limit` and
`CursorBackwardPagination.limit` get **no** annotation in `search-models.yaml`
while their siblings `OffsetPagination.limit` and `CursorForwardPagination.limit`
keep one: the former two are only ever reached through `SearchQueryRequest.page`
(single parent, aggregated intro 8.6, matches the child → Rule 2 suppresses);
the latter two are additionally reached from statistics-query parents
(`JobTypeStatisticsQuery.page` etc., introduced in 8.9), so not every parent
agrees with the child's 8.6 intro and Rule 2 cannot fire.

### Rule 3 — Shared schemas: earliest version across all consumers

When a schema (or property) is referenced from multiple endpoints (via `$ref`
or `allOf`), the chosen introduction version is the **earliest** version seen
across all consumers. The property is then annotated **unless every consumer
endpoint's own introduction version equals the property's earliest version**
— in which case all endpoint-level annotations already cover it.

Example — `element-instances.yaml#/components/schemas/AdvancedElementInstanceStateFilter`
is referenced from seven endpoints. The `$exists` operator inside it was
first seen in 8.8 by every consumer (the filter itself was introduced in
8.8), but the consuming endpoints span three different intro versions:

| Endpoint                                                                | Endpoint version | First saw `$exists` |
|-------------------------------------------------------------------------|------------------|---------------------|
| `POST /process-instances/search`                                        | 8.6              | 8.8                 |
| `POST /process-definitions/{processDefinitionKey}/statistics/element-instances` | 8.8      | 8.8                 |
| `POST /process-instances/cancellation`                                  | 8.8              | 8.8                 |
| `POST /process-instances/incident-resolution`                           | 8.8              | 8.8                 |
| `POST /process-instances/migration`                                     | 8.8              | 8.8                 |
| `POST /process-instances/modification`                                  | 8.8              | 8.8                 |
| `POST /process-instances/deletion`                                      | 8.9              | 8.8                 |

Earliest property version across consumers = **8.8**. Not every consumer
endpoint was introduced in 8.8 (`/process-instances/search` is 8.6 and
`/process-instances/deletion` is 8.9), so a property-level annotation is
required to cover those mismatched cases:

```yaml
# element-instances.yaml
AdvancedElementInstanceStateFilter:
  properties:
    $exists:
      type: boolean
      x-added-in-version: '8.8'
```

Had every consumer endpoint also been introduced in 8.8, no property-level
annotation would be written — each endpoint's own `x-added-in-version: '8.8'`
would already cover the shared schema.

### Rule 4 — Deduplicate properties by upstream location

Properties only. Several bundled property paths can resolve to the **same**
node in the upstream multi-file YAMLs (via `$ref` / `allOf`). Property
annotations are grouped by upstream `(file, path)` so each physical location
is written exactly once, using the version chosen under Rule 3.

## Pipeline & npm scripts

This repo bootstraps the two artefacts (`endpoint-map.json` and
`version-map.json`) on demand instead of requiring you to commit them, then
runs the annotator/verifier against them.

| Script | What it does |
|--------|-------------|
| `build:endpoint-map` | Runs `camunda-schema-bundler` against `CAMUNDA_REF` and copies the bundler's `endpoint-map.json` to `ENDPOINT_MAP_PATH`. Skips if the file already exists. |
| `build:version-map` | Clones [`return-of-api-added-in-analysis`](https://github.com/camunda/return-of-api-added-in-analysis) at `RETURN_OF_API_REF`, runs its `npm run all`, and copies the resulting `output/version-map.json` to `VERSION_MAP_PATH`. Skips if the file already exists. Throws (no silent failure) if the upstream produced no map. |
| `build:artefacts` | Convenience wrapper — runs both build steps in order. |
| `update:operations` | `build:artefacts` + writes operation-level `x-added-in-version` into the YAMLs under `OCA_SPEC_PATH`. |
| `update:properties` | `build:artefacts` + writes property-level `x-properties-added-in-version` (parent-list form) into the YAMLs under `OCA_SPEC_PATH`. Migrates any legacy parent-level `x-added-in-version` lists by deleting the old key and rewriting under the new one. |
| `verify:specs` | `build:artefacts` + runs the local-developer verifier (`verify-specs.mjs`). Verbose, exits 1 on any error. Honors `LOG_DETAIL_X_ADDED_IN_VERSION=true` for the detail trailer. |
| `verify:specs:ci` | Runs the non-blocking PR verifier (`verify-specs-ci.mjs`). **Always exits 0.** Does not rebuild artefacts (assumes they exist). Emits inline `::warning::` annotations + fix sections to stdout; no persisted report. |
| `verify:specs:workflow` | Runs the scheduled/dispatch verifier (`verify-specs-workflow.mjs`). Prints the shared report and writes Markdown to `REPORT_PATH` (default `output/verify-report.md`). Exits 1 on errors. Honors `LOG_DETAIL_X_ADDED_IN_VERSION=true` for the detail trailer on both stdout and the persisted file. |

Re-running any artefact build is a no-op once the target file exists; delete
the file (or unset the path) to force a rebuild.

### CI verifier (`verify:specs:ci`) — non-blocking PR check

Same checks as `verify:specs`, but tuned to surface findings on PRs without
blocking the merge queue:

- **Always exits 0.**
- Prints a single status line first:
  `❌ Found N incorrect x-added-in-version/x-properties-added-in-version across M files (non-blocking).`
  (or `✅ OpenAPI annotation verification: no incorrect annotations.`)
- Emits each finding as a GitHub Actions `::warning file=…,line=…::` under
  `=== Inline PR annotations ===` so they render inline on the PR's
  **Files changed** tab.
- Follows up with `# Operation errors fix` / `# Property errors fix`
  sections containing copy-pasteable YAML snippets.
- Does **not** rebuild artefacts — assumes `endpoint-map.json` and
  `version-map.json` exist (CI builds them once and reuses).
- Optional env: `ANNOTATION_PATH_PREFIX` (default
  `zeebe/gateway-protocol/src/main/proto/v2`; set empty for bare filenames),
  `GITHUB_STEP_SUMMARY` (auto in GHA; appends a short Markdown summary).

### Where it runs in `camunda/camunda`

1. **Per-PR (non-blocking warnings)** — inline job
   `openapi-x-added-in-version-check` in `.github/workflows/ci.yml`. Gated on
   `detect-changes`'s `openapi-changes` output. Uses `verify:specs:ci`.
2. **Daily + dispatch (Markdown report, blocking exit code)** —
   `.github/workflows/verify-x-added-in-version-annotations.yml` runs nightly
   at 05:00 UTC and on-demand against any branch/tag/SHA. Uses
   `verify:specs:workflow`; writes `reports/verify_<ref>.md`, appends to the
   job summary, and uploads it as an artifact.

Both workflows clone this repo into a temp dir, run `npm ci`, then
`npm run build:artefacts`, then the relevant verify script with
`OCA_SPEC_PATH` pointing at the host checkout's
`zeebe/gateway-protocol/src/main/proto/v2`.

### Environment variables

| Var | Used by | Effect |
|-----|---------|--------|
| `OCA_SPEC_PATH` | all | Path to multi-file OpenAPI specs. **Required.** |
| `VERSION_MAP_PATH` | all | Path to `version-map.json`. **Required.** |
| `ENDPOINT_MAP_PATH` | all | Path to `endpoint-map.json`. **Required.** |
| `CAMUNDA_REF` | `build:*` | Ref of `camunda/camunda` to bootstrap from. |
| `RETURN_OF_API_REF` | `build:version-map` | Ref of `return-of-api-added-in-analysis`. |
| `REPORT_PATH` | `verify:specs:workflow` | Output path for persisted Markdown report. Default `output/verify-report.md`. |
| `LOG_DETAIL_X_ADDED_IN_VERSION=true` | `verify:specs`, `verify:specs:workflow` | Appends the detail trailer (counts + broken rules). Only emitted when there are errors. |
| `ANNOTATION_PATH_PREFIX` | `verify:specs:ci` | Prefix for `::warning file=…::` paths. |
| `GITHUB_STEP_SUMMARY` | `verify:specs:ci` | Auto in GHA; appends short Markdown summary. |
| `CROSS_REPO_TOKEN` / `GITHUB_TOKEN` | CI workflows | Used by `insteadOf` git rewrite for transitive clones. |
