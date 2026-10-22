# Decisions

Design decisions and the reason for each. When two choices conflict, the one that keeps cards from moving wins.

## D-1 Dependencies
Besides ELK.js (layout) and d3-zoom (pan and zoom):
- `yaml` — read and write the registry files.
- `esbuild` — bundles the viewer into the single HTML file at build time.
- `tsx` — runs the TypeScript CLI without a compile step.
- `d3-selection`, `d3-interpolate` — already transitive deps of d3-zoom; imported directly for the zoom transitions.
- dev: `vitest`, `typescript`, `playwright-core` (perf script, drives the installed Chrome; no browser download).

The viewer's panels are plain DOM. A UI library can come in with the authoring forms, when there is enough UI to justify it.

## D-2 Module naming
`src/registry/` holds the registry schema, loading and validation. `src/model.ts` holds only the built board's types, shared by build and viewer.

## D-3 Layout: bottom-up, one ELK pass per container
Every container is laid out on its own, children first, as fixed-size boxes (equal tiles, D-28). Connections are lifted to the container's level (one edge per ordered pair of children), so siblings are ordered by the traffic between them. ELK disables component packing in `INCLUDE_CHILDREN` mode, which stacked unconnected domains in one tall column; per-container layout packs them into rows shaped like the container's own tile. Services stack their APIs and datastores in a column.
The top level is a grid of equal tiles about twice as wide as tall: departments are chained by connection weight (most connected next to each other); the External band stays on the right edge. Platform links don't shape the layout, since they're hidden by default.

## D-4 Text measurement and embedded fonts
Fonts are embedded in the HTML as base64 WOFF2 (Latin subsets, ~240 KB), so the board works offline from `file://`: Fraunces (titles), Inter (labels, body, UI), JetBrains Mono (ids), Caveat (handwriting for the Sketch style). `scripts/gen-metrics.ts` writes their advance widths to `src/layout/metrics.json`; layout measures text by role with the widest face that may draw it, so cards fit their text in either style.

## D-5 APIs, datastores as child cards, not ports

APIs and datastores are drawn as child cards inside their service, so a service becomes a container that opens like any other. Ports on the service border (Types table) come later; the visibility and lifting code does not change.

## D-6 Topic placement
A topic's parent is its owner service's parent (system or domain), per the Types table. Its zoom level is "interface" for the level slider, but it becomes visible when its parent opens.

## D-7 Edge ids and merged-edge direction
Edges merge per ordered pair (A→B and B→A stay separate), so arrow direction is never lost.

## D-8 Freshness computed at view time
Stale markers compare `reviewedAt` with the viewer's clock, not the build time, so the build stays byte-identical and a page left open still goes stale.

## D-9 Typography: label blocks with a maximum screen size
All card text lives in label blocks (chip + name + second line) designed at world size. A block scales with the zoom until its text reaches the role's maximum on-screen size, then stays that size (CSS `scale(min(1, cap / --k))`). Maximums: department title 30 px, domain 24, system 18, names and headers 15, meta 12, tags 11. Lines inside a block are stacked in the block's own units, so they can't drift into each other at any zoom. Text under 9 px on screen is hidden. Far out, departments and domains whose own title is unreadable get map-style screen labels (12 px).

## D-10 Trackpad and mouse wheel
Pinch, and mouse wheels with discrete steps, zoom. Two-finger trackpad scroll pans. This is a heuristic on wheel deltas. Wheel notches ease in rather than jump (D-26).

## D-11 Orthogonal routing in the viewer
Edges are routed on visibility change, in the viewer, by `src/route/orthogonal.ts`: ports are shared out along a side in the order of the other end; A* with a bend penalty over a sparse grid of obstacle faces and gutter centre lines; then parallel segments sharing a gutter are spread apart, in the order that crosses fewest joints. Obstacles are the visible siblings of every card on the two ends' paths to the root, so open containers are crossed only by their own edges.
Routing is progressive: at most ~12 ms per frame; unfinished edges show as elbows and are refined over the next frames. Routes are cached by (edge, ports, obstacle set), so most survive a visibility change.

## D-12 Edge level of detail
Every edge is drawn between the deepest visible ancestors of its ends. At org scale that draws thousands of lines at mid zoom. Two additions, neither of which moves a card:
- Ends off screen are grouped by domain: the line only has to say where it goes ("12 calls → Billing").
- If more than 160 lines would still touch the screen, on-screen ends are grouped one level coarser at a time (service → system → domain → department), with a note: "Connections grouped by domain — zoom in for detail".
Only edges with an end near the viewport are routed and drawn; cards far outside the viewport are taken out of rendering.

## D-13 Visual vocabulary
Departments get a hue (in board order); their domains and systems are tinted from it. Components have a fixed colour and silhouette per type — service: rounded box; API: pill; API group: dashed box; topic: pipe; channel: parallelogram; datastore: cylinder; external: chamfered box — plus a type chip. Connection kinds differ by colour and head: calls (blue, filled arrow), events (amber, open chevron), datastore access (green, dot), unknown API (grey, dashed).
Markers (PLATFORM, DISPUTED, MIGRATE, SHARED, SUPERSEDED, PLANNED, DEPRECATED) sit on the card's top border so they never cover a name. Far out, open departments and domains get map-style screen labels, since their name band is too small to read.

## D-14 Spec edge cases implemented
- `channel` type (technology, ownedBy) with the topic's connection rules.
- `role: platform`: links to it hidden by default (Filters → Platform links), callers show "uses …".
- `tags`; hosts with more than 8 APIs group them by first tag; publish validation requires the tags.
- Topics with more than 10 visible consumers draw one fan-out edge to a count badge.
- `supersedes` (superseded API marked), callers of deprecated APIs marked MIGRATE.
- `ownership: disputed` + `claimant` (required).
- Datastores accessed by non-owners marked SHARED.

## D-15 Containers open when their children are readable
A container opens at 320 px wide, because by then it should be large enough on screen to hold its children readably. Wide containers with many small children met the width long before their children's names were readable, which filled the screen with unlabelled cards. A container now also needs the zoom at which its median child's name reaches the size it is drawn at, 9 px or 10 px for a container's name (with the same 0.85 hysteresis). Closed service-like siblings share one name size, so they show their names together rather than one at a time. Until then it stays closed and shows its own name and counts. Pins and "show down to" still override.

## D-16 Drawing styles
Two styles share every rule and differ only in CSS tokens: Studio (Fraunces titles, Inter labels, gradient type chips, soft card shadows, dot grid) and Sketch (Caveat handwriting for titles and labels at 1.3×, ink outlines, graph paper, no shadows). Body text, ids and tags stay in Inter/JetBrains Mono in both, for legibility. The choice is in the toolbar, the URL (`style=sketch`) and the viewer's local storage.

## D-17 Presentation and review tools are per viewer
Laser (L), spotlight (S, `[` `]` to resize), pen and highlighter (P, ⌘Z undo, X clear), review notes (N), trace (T), impact (I), guided tours and presenter mode (⇧P) live in `src/viewer/present.ts`. Ink and notes are kept in the viewer's local storage, keyed by board version and commit, so a reviewer's marks don't leak into the published board. Notes export as Markdown for the review record. Nothing here writes to the registry; that stays with the reviewed authoring flow.

## D-18 Trace and impact semantics
Both run on the leaf connections plus implicit links: an API belongs to its hosting service, a datastore to its owner (these cost no hop, so "service hops" are what's counted).
- Trace follows the direction of travel: caller → API → host; producer → topic → consumer. Containers can be either end. If nothing flows that way, it falls back to ignoring direction and says so.
- Impact uses "depends on": a caller depends on the API it calls, a consumer depends on the topic, a topic depends on its producers. "Depends on it" walks that backwards from the card (blast radius); "It depends on" walks it forwards.
Platform links are included, since an outage of auth does break its callers.

## D-19 Tours live in the registry
`registry/tours.yaml` holds named walkthroughs; each step has a caption and one of `focus`, `trace: [from, to]` or `impact` (+ `direction`), optionally `level`. They are validated with the rest of the registry. The viewer can record a draft tour from what's on screen and copy it as YAML to paste into the file, so tours go through the same review as everything else.

## D-20 Calm overview
When more than 40 connections touch the screen and nothing is focused, lines draw faint until a card or line is double-clicked, or a trace or impact is shown.

## D-21 Org graphs are built in the browser
An org-graph page carries a data source, not a laid-out model. `src/orgview/boot.ts` fetches the snapshot, builds the chosen grouping (`src/orgview/graph.ts`) and lays it out on a grid (`src/orgview/layout.ts`); the grid takes a few milliseconds, so there is no layout worker and nothing to cache. Registry boards still arrive laid out from `atlas build`.

## D-22 Two-call graph API
`GET /graph/snapshot` (everything down to APIs and grants, one cacheable response) and `GET /graph/details?apis=id@version,…` (operations, schemas and links, batched, immutable per spec version). No server-side hierarchies, rollups, trace or impact endpoints: the snapshot holds every grant, so lifting, grouping, trace and impact at API level run in the browser. See `docs/graph-api.md`.

## D-23 Grouping is a view, not data
"By team" (team → service → API → operations) and "By domain" (domain → API → operations, with teams and services as callers off the board) are built from the same snapshot. An API sits in its exposing service when the snapshot names one, otherwise in its owning team. In the domain view an API goes to the domain holding most of its schemas.

## D-24 API cards keep their size when details load
An API card is a tile like its siblings. Its operations and schemas load into that box (centred, and drawn smaller when there are many), so nothing moves while data streams in. Details are fetched as soon as an API card is big enough to read, batched (at most 50 per request), so the method-mix bar is there before you zoom into the operations.

## D-25 Grants are the connections
Approved grants are calls, pending ones are drawn dashed in amber, rejected ones are dropped. Once an API is open, an operation-scoped grant lands on the rows it covers. Selecting an operation draws the schemas it carries, and the references between them dashed.

## D-26 Lines hold still
Lines only change when you ask them to or when the view has settled. While a pan or zoom is in progress they keep their current routes, even if containers open or close underneath; 160 ms after the last movement they are regrouped and rerouted for what is now on screen. They are kept by key between redraws, so a line whose route didn't change isn't touched, new ones fade in and removed ones fade out. The exception is panning past the area the lines were drawn for, which draws the newly exposed part straight away.
Hovering changes nothing, and a single click on a card only opens its panel. Highlighting is on double-click: a card's connections, or one line and the cards at its ends. Pinning a container open or closed, which double-click used to do, moved to the panel.
A mouse wheel notch zooms by the same factor d3-zoom uses but eases there over a few frames around the pointer. Pinch goes straight to d3-zoom, and screen-constant sizes (`--k`, `--inv`) follow the zoom on every frame, which measured no slower than stepping them.

## D-27 Room between cards, and rounded corners at every size
Gaps between siblings are set from the tile size (0.7 of its height, and at least 0.45 of its width between layers), so they look the same at every level once you zoom to it; the gutters are where lines, arrowheads and counts have to fit. Lines are routed in screen-sized units (the zoom rounded to half a power of two), so clearances and spacing between parallel lines stay a few pixels however small the cards they connect are drawn.
Corner radii grow with the card too (5% of its shorter side, between the type's base radius and 64), so a department still reads as a rounded box at overview zoom instead of a sharp rectangle.

## D-28 Siblings are equal tiles; contents are drawn smaller
Every box at a level is the same size: all departments, all domains in a department, all services in a domain. A tile is wide enough for the longest name among its siblings, at about 5:3. A container's children are laid out in their own space and then shrunk to fit its tile below the name band (`BoardNode.s` records the factor; cards are drawn in their own units and scaled). A department with forty domains is the same size as one with four; its contents are just drawn smaller and become readable further in. Zooming in makes the card you're heading for fill the screen as its neighbours leave it, and zooming out returns everything to the same grid. Because siblings share a size, closed siblings also share one name size (the smallest any of them needs), so every name at a level is the same size and appears at the same zoom.
The cost is depth: each level is drawn several times smaller than its parent, so the deepest cards need a zoom thousands of times the overview. At moderate zooms this renders as fast as the old layout; pinching continuously four orders of magnitude deep runs at about 45 fps instead of 50 on the benchmark board.

## D-29 People can move cards; the registry can't see it
A closed card can be dragged anywhere on it, an open container by its name band (pressing inside an open container pans). The card stays inside its parent, its contents move with it, and lines reroute when it's dropped. Moves are stored as offsets from the built layout in the viewer's local storage, per board, like ink and notes (D-17): they arrange one person's view and never reach the registry or other viewers. "Reset layout" puts everything back. A shared, reviewed layout is still the saved-positions work tracked in the issues.

## D-30 The org graph has its own view
Org graphs and registry boards share the data sources and the ordering of top-level cards, but not the viewer. The org view (`src/orgview/view.ts`) follows a design built around four questions in turn: which team, which service, which API, which operation. What it does differently, and why:

- Cards are HTML nested the way the org is, each a fixed tile whose inside fills in as it gets bigger on screen: a summary (name, pending-grant badge, one bar per API scaled by traffic, counts), then its children, then theirs. Text in a card scales with it; headers of open cards stop growing at a reading size, and borders stay about a pixel wide.
- Lines are drawn only for the focused card (or a trace or impact), in screen space on every frame. That is a few dozen lines rather than hundreds, so they never lag behind the zoom and need no level-of-detail rules. An end that is off screen becomes a portal at the edge, callers on the left and dependencies on the right, which you can click to fly there.
- Inside a card, what is called from outside comes first (left column) and what only calls out comes last, so lines from portals arrive at the near side. A line that would run through another card goes round through the gap between rows.
- Click focuses, double-click dives in, hover does nothing. The level switcher (Org, Team, Service, API, Op) flies to the focused card at that level; ⌘K or `/` opens a palette that searches teams, services, APIs and loaded operations, and can start a trace or show everything that depends on a card.
- Dark is the default theme, with a light one; Geist and Geist Mono are embedded. Moved cards are kept per browser, as on registry boards (D-29).

## D-31 Traffic is a layer from plugins, never declared
A registry says what exists and who may call what. How much they call it is observed, changes by the hour, and would turn every registry into a stream of noisy pull requests, so it is never part of the registry or the board model. Usage plugins (`src/enrich`) return a report: a source, a window, when it was taken, and per API id the calls and optionally errors and p95 latency. The page lists its plugins in order; for each API the first one with numbers wins, and a report with a different window from the first is refused, because calls from different windows can't be added up.

- Missing is not zero. An API no plugin covers shows "no data", and a team shows how many of its APIs reported. With no plugin loaded the board draws no traffic at all, and the team bars fall back to operation counts.
- Every number says where it came from: the status line names the sources, and the inspector shows the source and date next to the figures. Made-up numbers (the demo) are flagged `sample` and labelled.
- Plugins are keyed by API id. Mapping metric series to ids is the plugin's job (`--map` for Prometheus), so names in a metrics system never leak into the registry.
- Spec0's `calls30d` is read only through its own plugin (`--usage spec0`), the same as any other source.
- Reports, URLs and Prometheus are built in. Anything else is a module exporting `{ name, load(ctx) }`, run at build time.

## D-32 The org view can live inside another app
`mountOrgView` returns a handle whose `destroy()` removes the board and every window listener, timer and frame it started, so a host can mount and unmount it (on navigation, or to switch grouping) without leaks. The board fills the element it is mounted in instead of the window, and the rules for a standalone page (`html`, `body`, the splash) live in `page.css`, which only `boot.ts` loads. Hooks let the host keep links in its own router (`navigate`), rebuild after "Reset layout" instead of reloading (`reload`), and leave out the Atlas name (`brand: null`).

