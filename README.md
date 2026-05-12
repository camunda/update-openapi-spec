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
`OCA_SPEC_PATH`, applying these rules:

- Properties listed in `deletedProperties` are never annotated.
- Properties whose introduction version equals their endpoint's introduction
  are not annotated (the endpoint annotation already covers them).
- Only the highest-level ancestor introduced in a given version is annotated;
  children added in the same version as their nearest property ancestor are
  skipped, while children added later get their own annotation.
- For shared schemas referenced from multiple endpoints, the intro is the
  earliest version across all consumers.
