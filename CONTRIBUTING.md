# Contributing

Atlas is TypeScript end to end: a small CLI that validates a registry and builds the board, and a viewer bundled into the HTML it builds. It needs Node 22.12 or later.

```bash
npm install
npm run build:ecommerce && open dist/ecommerce/index.html
```

## Before you open a pull request

```bash
npm run type-check
npm test
npm run build:demo          # builds every example board
```

All three must pass, and CI runs the same steps. For anything you can see on the board, also open a built board and try the change at a few zoom levels. A passing test suite says the layout maths is right, not that the board reads well. `scripts/shot.ts` takes a screenshot of a built board at a given view, which is handy for before-and-after comparisons in a pull request:

```bash
npx tsx scripts/shot.ts dist/ecommerce/index.html out.png "focus=payments"
```

## How the code is laid out

```
src/
  registry/   schema, connection rules, loading, validation, containment tree
  layout/     ELK layout (bottom-up per container), text metrics, card sizes
  lod/        what is visible at each zoom, edge lifting and grouping, trace and impact
  route/      orthogonal edge router
  spec0/      graph format types and data sources (live API or embedded fixture)
  orgview/    the org graph board: grouping, grid layout, view
  build/      model and viewer bundle into one HTML file, with fonts embedded
  viewer/     the board, card shapes, presentation tools
  cli/        atlas validate | build | build-spec0
```

The build runs in Node and the viewer runs in the browser. They share `src/model.ts` (the built board's types), the rules in `src/registry/rules.ts`, and the pure modules under `lod/` and `route/`. None of those import anything from the DOM or Node. Keep it that way, so both sides can be tested the same way.

[DECISIONS.md](DECISIONS.md) records why things are the way they are, numbered so you can cite them in a pull request. If you change one of those decisions, update its entry in the same change.

## Rules that keep the board usable

**Cards never move when detail appears.** Every card's position and size is fixed at build time. Opening a container shows children that were already placed inside it, drawn smaller to fit (DECISIONS D-28). If a change makes a card shift as you zoom, it's a bug, even if the new position looks better. The same goes for org graphs: operations load into the API card's existing box. The only thing that moves a card is a person dragging it, and that stays in their browser.

**Builds are byte-identical.** The same registry produces the same HTML, so a diff of two builds shows only real changes. Don't put timestamps, random ids or iteration order over unsorted maps into the model. There's a test for this.

**Text stays readable or isn't drawn.** Text under 9 px on screen is hidden, and containers stay closed until their children's names would be readable. A screen of unlabelled boxes is worse than a closed card with a count. Cards are drawn in their own units and scaled by `BoardNode.s`, so anything that compares a size with the zoom has to account for it (`CardText` values from `buildCard` already do).

**Lines don't move unless you ask.** Nothing about the lines should change on hover, on a single click, or in the middle of a pan or zoom; they settle once the view stops (DECISIONS D-26). If you add an interaction that restyles lines, put it behind a double-click or an explicit control, and redraw through `drawEdges`, which only touches lines that changed.

**The registry is the only source of truth.** The viewer never writes to it. Ink, notes and pins live in the viewer's local storage, and tours are copied out as YAML for someone to commit. Anything that changes the architecture goes through a reviewed change to the YAML.

**Connection kinds come from the types at each end.** Don't add a free-form `kind` field to connections. If a pair of types needs a new kind, add it to `CONNECTION_RULES` in `src/registry/rules.ts` with a test, so validation keeps rejecting the pairs that don't make sense.

**The board works offline from a file.** No CDN fonts, no runtime fetches for registry boards. A board someone downloads from CI should still open on a train.

## Tests

New logic in `registry/`, `layout/`, `lod/` or `route/` needs tests. Those modules are pure and the existing tests in `test/` show the pattern: build a tiny registry or node list in the test, run the function, and assert on positions, visible ids or edges.

`npm run bench:gen && npm run build:bench && npm run perf` measures frame rate and recompute time on a synthetic board of about 1,500 entries. Run it if you touch visibility, lifting or routing, and put the before and after numbers in the pull request.

## Regenerating the examples

The e-commerce example and the org graph fixture are generated, so edit the scripts, not the YAML or JSON:

```bash
npm run ecommerce:gen       # scripts/gen-ecommerce.ts → examples/ecommerce/
npm run spec0:fixture       # scripts/gen-spec0-fixture.ts → examples/spec0/
npm run bench:gen           # scripts/gen-benchmark.ts → bench/
```

If you change which fonts are embedded, run `npx tsx scripts/gen-metrics.ts` so layout measures text with the right widths.
