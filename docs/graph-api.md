# The graph format

Besides YAML registries, Atlas can draw an organisation from a graph of teams, services, APIs and the access grants between them. This is the format [Spec0](https://spec0.io) uses for its org graph. Any server that answers the two requests below can feed the same board, and so can a pair of JSON files. The TypeScript types are in [`src/spec0/types.ts`](../src/spec0/types.ts).

## Two requests

| Request | When | Caching |
| --- | --- | --- |
| `GET /graph/snapshot` | When the page loads | `version` is a content digest, sent as the `ETag`. Reloading an unchanged org gets a `304` |
| `GET /graph/details?apis=id@ver,…` | As APIs open while you zoom in, batched per gesture, at most 50 per request | Cacheable as immutable when every requested version is current |

A typical session is one snapshot request and a handful of details batches. Everything else happens in the browser:

- **Hierarchy.** "By team" (team → service → API → operations and schemas) and "By domain" (domain → API → operations and schemas) are both built from the same snapshot, so switching between them costs nothing.
- **Layout.** ELK runs in a Web Worker. API cards are equal tiles like everything else; their operations and schemas load into that box, drawn smaller if there are many, so the board doesn't move when the details arrive.
- **Connections.** Grants are the leaf edges. Atlas lifts and merges them to whatever is visible, so the server doesn't need to compute any rollups.
- **Trace and impact** at API level run on the snapshot's grants.

`HttpSource` takes a base URL and a `headers` callback, so a host page can add its own auth header.

## Snapshot

| Field | Meaning |
| --- | --- |
| `version`, `generatedAt` | Content digest of the snapshot, and when it was made |
| `org` | `id` and `name` |
| `teams` | `id`, `name`, member count |
| `services` | `id`, `name`, owning `team` (may be null) |
| `domains` | `id`, `name`, `slug` |
| `apis` | `id`, `name`, `version`, owning `team`, `status`, operation and schema counts, schema count per domain id, and `calls30d`. `specVersion` is the latest published spec version, or null before the first one |
| `apis[].service` | The service that exposes the API, or null when that isn't known. APIs without one sit under their owning team |
| `grants` | One per consumer and API: `consumer`, `consumerKind` (`TEAM` or `SERVICE`), `api`, `status` (`APPROVED`, `PENDING` or `REJECTED`) and `operationScoped` |

Approved grants are drawn as calls, pending ones as dashed requests, and rejected ones are left out. Traffic is per API (`calls30d`), so connections carry no weight.

## Details

The response is `{ "apis": [...] }`, one entry per requested API:

| Field | Meaning |
| --- | --- |
| `operations` | `method`, `path` and optional `operationId` |
| `schemas` | `name`, `structuralHash`, `propertyCount`, optional `domain` id |
| `carries` | `[operationIndex, schemaIndex]` pairs: which operations use which schemas |
| `references` | `[schemaIndex, referencedSchemaIndex]` pairs |
| `grantOperations` | For each operation-scoped consumer, the indexes of the operations it may call |
| `versions` | Recent spec versions: `tag`, `publishedAt`, `breaking` |

Once an API's details load, its operation-scoped grants are redrawn from the consumer to the individual operations, operations link to the schemas they carry, and schemas link to the schemas they reference. Identical schemas in other loaded APIs (same `structuralHash`) can be linked too, from the filters.

Grants and operations are objects rather than tuples. Tuples were about a third smaller before compression, but only a few percent smaller after it, and objects are easier to type and read.

## Trying it without a server

`npm run spec0:fixture` writes a snapshot and details file derived from the e-commerce example into `examples/spec0/`. `npm run build:spec0` turns them into `dist/spec0/index.html`. To browse it the way a person would and print the requests the page made, run:

```bash
npx tsx scripts/session.ts dist/spec0/index.html
```
