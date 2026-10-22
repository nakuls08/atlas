# The graph format

Besides YAML registries, Atlas can draw an organisation from a graph of teams, services, APIs and the access grants between them. This is the format [Spec0](https://spec0.io) uses for its org graph. Any server that answers the two requests below can feed the same board, and so can a pair of JSON files. The TypeScript types are in [`src/spec0/types.ts`](../src/spec0/types.ts).

## Two requests

| Request | When | Caching |
| --- | --- | --- |
| `GET /graph/snapshot` | When the page loads | `version` is a content digest, sent as the `ETag`. Reloading an unchanged org gets a `304` |
| `GET /graph/details?apis=id@ver,…` | As APIs open while you zoom in, batched per gesture, at most 50 per request | Cacheable as immutable when every requested version is current |

A typical session is one snapshot request and a handful of details batches. Everything else happens in the browser:

- **Grouping.** "By team" (team → service → API → operations) and "By domain" (domain → API → operations) are both built from the same snapshot, so switching between them costs nothing.
- **Layout.** A grid of equal tiles, nested, computed in a few milliseconds. API cards keep their size when their operations load into them, so the board doesn't move when the details arrive.
- **Connections.** Grants are the lines. Only the focused card's are drawn, merged onto whatever card stands for each end at the current zoom, so the server doesn't need to compute any rollups.
- **Roll-ups.** Team traffic, pending-grant counts and the per-API bars are summed from the snapshot in the browser.
- **Trace and impact** run on the snapshot's grants.

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

Approved grants are drawn as calls, pending ones as dashed requests, and rejected ones are left out. Connections carry no weight.

The board doesn't read `calls30d` on its own. Spec0 fills it with the authorisation checks it answered for the API over 30 days; pass `--usage spec0` to show those numbers, alone or behind another usage plugin (see [usage.md](usage.md)).

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

Once an API is open, its operation-scoped grants land on the operations they cover, and selecting an operation shows the schemas it carries and the references between them.

Grants and operations are objects rather than tuples. Tuples were about a third smaller before compression, but only a few percent smaller after it, and objects are easier to type and read.

## Trying it without a server

`npm run spec0:fixture` writes a snapshot and details file derived from the e-commerce example into `examples/spec0/`. `npm run build:spec0` turns them into `dist/spec0/index.html`. To zoom around it the way a person would and print what was loaded, run:

```bash
npx tsx scripts/session.ts dist/spec0/index.html
```
