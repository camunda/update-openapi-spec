# update-openapi-spec

Adds the `x-added-in-version` OpenAPI extension to every operation **and
schema property** in the Camunda 8 REST API spec files, so consumers know
when each endpoint and field was introduced.

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
# VERSION_MAP_PATH=./version-map.json
# ENDPOINT_MAP_PATH=./endpoint-map.json

# 4. Run
npm run update              # annotates operations
npm run update:properties   # annotates schema properties
```

The first script reads every operation from `version-map.json`, looks up its
YAML file via `endpoint-map.json`, and writes
`x-added-in-version: '<version>'` into the operation object of the
corresponding spec file under `OCA_SPEC_PATH`.

The second script reads every schema property from `version-map.json` and
writes `x-added-in-version` onto the corresponding property in
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
  x-added-in-version:
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
child annotation.

### Rule 3 — Shared schemas: earliest version across all consumers

When a schema (or property) is referenced from multiple endpoints (via `$ref`
or `allOf`), the chosen introduction version is the **earliest** version seen
across all consumers. The property is then annotated **unless every consumer
endpoint's own introduction version equals that earliest version** — in which
case all endpoint-level annotations already cover it.

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

### Rule 4 — Deduplicate by upstream location

Several bundled paths can resolve to the **same** node in the upstream
multi-file YAMLs. Annotations are grouped by upstream `(file, path)` so each
physical location is written exactly once, using the version chosen under
Rule 3.
