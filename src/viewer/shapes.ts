import type { BoardNode, NodeType } from '../model';
import { DETAIL_FONT, LEAF } from '../layout/sizes';
import { textWidth } from '../layout/measure';
import { svgEl } from './dom';

/**
 * Card shapes. Containers are rounded boxes tinted by department; leaf components each have
 * their own silhouette and a type chip, so the type reads at a glance even without the label.
 *
 *   service    rounded box            api        pill
 *   topic      pipe (horizontal tube) channel    parallelogram
 *   datastore  cylinder               external   chamfered box
 *   apigroup   dashed rounded box
 *
 * Text lives in "label blocks": a group designed at world size that scales with the zoom until
 * its text reaches a maximum on-screen size, then stops growing (CSS reads --k, the zoom scale).
 * So text never balloons when zoomed in, and lines inside a block never drift apart.
 */

/** Department hues, assigned in board order. */
const DEPT_HUES = [226, 18, 162, 276, 344, 96, 196, 40, 0, 250];

export function deptHue(index: number): number {
  return DEPT_HUES[index % DEPT_HUES.length];
}

/** Largest on-screen sizes, in px, per text role. */
export const MAX_PX = {
  department: 30,
  team: 28,
  domain: 24,
  band: 22,
  system: 18,
  header: 15,
  name: 15,
  meta: 12,
  tag: 11,
};

export function shapePath(type: NodeType, w: number, h: number): string {
  switch (type) {
    case 'api':
      // A pill while small; a rounded box once it holds operations and schemas.
      return roundRect(w, h, Math.min(h / 2, 20));
    case 'topic': {
      const rx = Math.min(9, w / 6);
      const ry = h / 2;
      return `M${rx},0 H${w - rx} A${rx},${ry} 0 0 1 ${w - rx},${h} H${rx} A${rx},${ry} 0 0 1 ${rx},0 Z`;
    }
    case 'datastore': {
      const ry = Math.min(8, h / 6);
      return `M0,${ry} A${w / 2},${ry} 0 0 1 ${w},${ry} V${h - ry} A${w / 2},${ry} 0 0 1 0,${h - ry} Z`;
    }
    case 'external': {
      const c = Math.min(12, h / 4);
      return `M${c},0 H${w - c} L${w},${c} V${h - c} L${w - c},${h} H${c} L0,${h - c} V${c} Z`;
    }
    case 'channel': {
      const s = Math.min(12, w / 8);
      return `M${s},0 H${w} L${w - s},${h} H0 Z`;
    }
    case 'department':
    case 'team':
    case 'band':
      return roundRect(w, h, 18);
    case 'operation':
    case 'schema':
      return roundRect(w, h, 6);
    case 'domain':
      return roundRect(w, h, 14);
    default:
      return roundRect(w, h, 10);
  }
}

/** Second outline that gives a shape its 3D cue (tube end, cylinder lid). */
function rimPath(type: NodeType, w: number, h: number): string | null {
  if (type === 'topic') {
    const rx = Math.min(9, w / 6);
    return `M${w - rx},0 A${rx},${h / 2} 0 0 0 ${w - rx},${h}`;
  }
  if (type === 'datastore') {
    const ry = Math.min(8, h / 6);
    return `M0,${ry} A${w / 2},${ry} 0 0 0 ${w},${ry}`;
  }
  return null;
}

function roundRect(w: number, h: number, r: number): string {
  r = Math.min(r, w / 2, h / 2);
  return `M${r},0 H${w - r} A${r},${r} 0 0 1 ${w},${r} V${h - r} A${r},${r} 0 0 1 ${w - r},${h} H${r} A${r},${r} 0 0 1 0,${h - r} V${r} A${r},${r} 0 0 1 ${r},0 Z`;
}

/** Top band of an open container, behind its name. */
export function headerBandPath(type: NodeType, w: number, band: number): string {
  const r = type === 'department' || type === 'team' || type === 'band' ? 18 : type === 'domain' ? 14 : 10;
  return `M0,${r} A${r},${r} 0 0 1 ${r},0 H${w - r} A${r},${r} 0 0 1 ${w},${r} V${band} H0 Z`;
}

/** Icon glyphs drawn in a 16×16 box, white on the type chip. */
const ICONS: Partial<Record<NodeType, string>> = {
  service: 'M3,3 h4 v4 h-4 Z M9,3 h4 v4 h-4 Z M3,9 h4 v4 h-4 Z M9,9 h4 v4 h-4 Z',
  api: 'M1.5,8 H7 M11,8 m-3.2,0 a3.2,3.2 0 1,0 6.4,0 a3.2,3.2 0 1,0 -6.4,0',
  apigroup: 'M1.5,5 H6 M1.5,11 H6 M10,5 m-2.4,0 a2.4,2.4 0 1,0 4.8,0 a2.4,2.4 0 1,0 -4.8,0 M10,11 m-2.4,0 a2.4,2.4 0 1,0 4.8,0 a2.4,2.4 0 1,0 -4.8,0',
  topic: 'M2,4.5 H12 M2,8 H14 M2,11.5 H12 M11,2.5 L14,4.5 L11,6.5',
  channel: 'M2,8 H13 M9.5,4.5 L13,8 L9.5,11.5',
  datastore: 'M3,4 a5,2 0 1,0 10,0 a5,2 0 1,0 -10,0 V12 a5,2 0 0,0 10,0 V4 M3,8 a5,2 0 0,0 10,0',
  external: 'M8,8 m-6,0 a6,6 0 1,0 12,0 a6,6 0 1,0 -12,0 M2,8 H14 M8,2 C5,5 5,11 8,14 C11,11 11,5 8,2',
  schema: 'M2.5,3 h11 v10 h-11 Z M2.5,6.5 H13.5 M2.5,9.8 H13.5 M6.5,6.5 V13',
};

const CHIP_TYPES = new Set<NodeType>(['service', 'api', 'apigroup', 'topic', 'channel', 'datastore', 'external', 'schema']);

function chip(type: NodeType, x: number, y: number, size: number): SVGGElement {
  const g = svgEl<SVGGElement>('g', { class: 'chip', transform: `translate(${x},${y})` });
  const r = type === 'api' || type === 'apigroup' ? size / 2 : size * 0.28;
  g.append(svgEl('rect', { width: size, height: size, rx: r, class: 'chip-bg' }));
  const icon = ICONS[type];
  if (icon) {
    const s = size / 16;
    g.append(svgEl('path', { d: icon, class: 'chip-icon', transform: `scale(${s})` }));
  }
  return g;
}

function text(parent: SVGElement, cls: string, x: number, y: number, size: number, content: string, anchor?: 'middle' | 'end'): SVGTextElement {
  const t = svgEl<SVGTextElement>('text', { class: cls, x, y, ...(anchor ? { 'text-anchor': anchor } : {}) });
  t.style.setProperty('--fs', `${+size.toFixed(2)}px`);
  t.textContent = content;
  parent.append(t);
  return t;
}

/**
 * A label block anchored at (x, y). It scales with the zoom until text drawn at `designPx`
 * reaches `maxPx` on screen; from there it keeps a constant size.
 */
function block(parent: SVGElement, cls: string, x: number, y: number, designPx: number, maxPx: number): SVGGElement {
  const g = svgEl<SVGGElement>('g', { class: `lb ${cls}` });
  const cap = +(maxPx / designPx).toFixed(4);
  g.setAttribute('style', `transform: translate(${x}px, ${y}px) scale(min(1, calc(${cap} / var(--k, 1))))`);
  parent.append(g);
  return g;
}

const tagWidth = (label: string) => textWidth(label, 9.5, 'tag') + 12;

/** What the LOD pass needs to decide which text is readable at a zoom. */
export interface CardText {
  /** Name size in world units, and the zoom at which it reaches its maximum screen size. */
  nameFs: number;
  nameCap: number;
  /** Second line (detail or child summary) size. */
  subFs: number;
}

/**
 * Builds the SVG for one card in local coordinates. Visibility of the text parts is controlled
 * by `show-*` classes set from the LOD pass.
 */
export function buildCard(n: BoardNode, opts: { container: boolean; staleText: string | null }): { g: SVGGElement; closed: CardText; open: CardText } {
  const { w, h } = n;
  const g = svgEl<SVGGElement>('g', { transform: `translate(${n.x},${n.y})` });
  const isChip = CHIP_TYPES.has(n.type);
  if (!opts.container || n.type === 'domain') g.append(svgEl('path', { class: 'shadow', d: shapePath(n.type, w, h), transform: 'translate(0,2)' }));
  g.append(svgEl('path', { class: 'shape', d: shapePath(n.type, w, h) }));
  const title = svgEl('title');
  title.textContent = `${n.name} · ${n.type}${n.flags.length ? ` · ${n.flags.join(', ')}` : ''}`;
  g.append(title);

  const spec = LEAF[n.type];
  let closed: CardText = { nameFs: 0, nameCap: 1, subFs: 0 };
  let open: CardText = { nameFs: 0, nameCap: 1, subFs: 0 };

  /** Chip + name + second line, left-aligned and vertically centred at (x, y). */
  const leafBlock = (parent: SVGElement, x: number, y: number, chipSize: number, nameFs: number, second: string, secondCls: string, fitTo?: number) => {
    // Names wider than the card are drawn smaller (cards sized from counts don't know their labels).
    if (fitTo) nameFs = Math.min(nameFs, fitTo / Math.max(1, textWidth(n.name, 1, 'label')));
    const b = block(parent, 'leaf', x, y, nameFs, MAX_PX.name);
    if (chipSize) b.append(chip(n.type, 0, -chipSize / 2, chipSize));
    const tx = chipSize ? chipSize + 8 : 0;
    // One line is centred on the anchor; with the second line shown, CSS lifts both by half a line.
    // The second line keeps its proportion to the name, so it scales with the block.
    const subFs = DETAIL_FONT * (nameFs / Math.max(spec.font, 1));
    const gap = nameFs * 0.46;
    const lines = svgEl<SVGGElement>('g', { class: 'lines' });
    lines.style.setProperty('--shift', `${-(gap + subFs * 0.95) / 2}px`);
    b.append(lines);
    text(lines, 'name r-label', tx, nameFs * 0.36, nameFs, n.name);
    if (second) text(lines, `${secondCls} r-body`, tx, nameFs * 0.36 + gap + subFs * 0.95, subFs, second);
    return { nameFs, nameCap: MAX_PX.name / nameFs, subFs: second ? subFs : 0 };
  };

  if (opts.container) {
    // Open: name band with the name (and chip) on the left, review date on the right.
    const band = n.type === 'service' || n.type === 'apigroup' ? 32 : 36;
    g.append(svgEl('path', { class: 'band', d: headerBandPath(n.type, w, band) }));
    const hdrFs = n.type === 'department' ? 12.5 : 14;
    const hb = block(g, 'hdr', 14, band / 2, hdrFs, n.type === 'department' ? 13 : MAX_PX.header);
    let hx = 0;
    if (isChip) {
      hb.append(chip(n.type, 0, -9, 18));
      hx = 26;
    }
    text(hb, `hdr-text ${isChip ? 'r-label' : 'r-title'}`, hx, hdrFs * 0.36, hdrFs, n.type === 'department' ? n.name.toUpperCase() : n.name);
    open = { nameFs: hdrFs, nameCap: MAX_PX.header / hdrFs, subFs: 0 };
    if (opts.staleText) {
      const mb = block(g, 'meta', w - 14, band / 2, 11, MAX_PX.meta);
      text(mb, 'meta-text r-body', 0, 4, 11, opts.staleText, 'end');
    }

    // Closed: the name and child counts, fitted to the box but never above the role's maximum.
    const cg = svgEl<SVGGElement>('g', { class: 'closed' });
    g.append(cg);
    if (isChip) {
      // Name sized to the box (like a closed domain), capped like any label.
      const cs = Math.min(26, h * 0.4);
      const fit = Math.min((w - 12 - cs - 8 - 14) / Math.max(1, textWidth(n.name, 1, 'label')), (w - 12 - cs - 8 - 14) / Math.max(1, textWidth(n.summary, 1 / 1.3, 'body')), h * 0.26, 30);
      closed = leafBlock(cg, 12, h / 2, cs, Math.max(spec.font, fit), n.summary, 'sum');
    } else {
      const fit = Math.max(4, Math.min((w - 48) / Math.max(1, textWidth(n.name, 1, 'title')), h * 0.3));
      const sum = Math.max(3, Math.min(fit * 0.42, (w - 32) / Math.max(1, textWidth(n.summary, 1, 'body'))));
      const max =
        n.type === 'department' ? MAX_PX.department : n.type === 'team' ? MAX_PX.team : n.type === 'domain' ? MAX_PX.domain : n.type === 'band' ? MAX_PX.band : MAX_PX.system;
      const b = block(cg, 'centre', w / 2, h / 2, fit, max);
      text(b, 'big r-title', 0, fit * 0.1, fit, n.name, 'middle');
      text(b, 'sum r-body', 0, fit * 0.1 + sum * 0.6 + fit * 0.32 + sum * 0.5, sum, n.summary, 'middle');
      closed = { nameFs: fit, nameCap: max / fit, subFs: sum };
    }
  } else {
    const rim = rimPath(n.type, w, h);
    if (rim) g.append(svgEl('path', { class: 'rim', d: rim }));
    const y = n.type === 'datastore' ? h / 2 + 4 : h / 2;
    if (n.type === 'operation') {
      // Method badge + path, the path in monospace and fitted to the card.
      const method = n.detail || 'GET';
      const badge = 38;
      const fs = Math.max(4, Math.min(spec.font, (w - spec.pad - badge - 6 - spec.end) / Math.max(1, textWidth(n.name, 1, 'mono'))));
      const b = block(g, 'leaf', spec.pad, h / 2, fs, MAX_PX.name);
      const chipG = svgEl<SVGGElement>('g', { class: `chip method m-${method.toLowerCase()}`, transform: `translate(0,-8)` });
      chipG.append(svgEl('rect', { width: badge, height: 16, rx: 4 }));
      text(chipG, 'r-tag', badge / 2, 11.5, 8.5, method, 'middle');
      b.append(chipG);
      const lines = svgEl<SVGGElement>('g', { class: 'lines' });
      b.append(lines);
      text(lines, 'name r-mono', badge + 6, fs * 0.36, fs, n.name);
      closed = { nameFs: fs, nameCap: MAX_PX.name / fs, subFs: 0 };
    } else {
      const fit = Math.max(1, w - spec.pad - (isChip ? spec.chip + 8 : 0) - spec.end);
      closed = leafBlock(g, spec.pad, y, isChip ? spec.chip : 0, spec.font, n.detail, 'detail', fit);
    }
  }

  // Markers on the top border (right) and the platform "uses" badge on the bottom border (left),
  // so they never cover a name.
  const marks: Array<[string, string]> = [];
  if (n.flags.includes('platform')) marks.push(['t-platform', 'PLATFORM']);
  if (n.flags.includes('disputed')) marks.push(['t-warn', 'DISPUTED']);
  if (n.flags.includes('migrate')) marks.push(['t-warn', 'MIGRATE']);
  if (n.flags.includes('shared')) marks.push(['t-warn', 'SHARED']);
  if (n.flags.includes('superseded')) marks.push(['t-muted', 'SUPERSEDED']);
  if (n.status === 'planned') marks.push(['t-muted', 'PLANNED']);
  if (n.status === 'deprecated') marks.push(['t-muted', 'DEPRECATED']);
  if (marks.length) {
    const mb = block(g, 'marks', w - 12, 0, 10, MAX_PX.tag);
    let right = 0;
    for (const [cls, label] of marks) {
      const tw = tagWidth(label);
      const t = svgEl<SVGGElement>('g', { class: `tag ${cls}`, transform: `translate(${right - tw},-8)` });
      t.append(svgEl('rect', { width: tw, height: 16, rx: 8 }));
      text(t, 'r-tag', tw / 2, 11.5, 9.5, label, 'middle');
      mb.append(t);
      right -= tw + 4;
    }
  }
  if (n.uses.length) {
    const label = `uses ${n.uses.join(', ')}`;
    const ub = block(g, 'uses', 12, h, 10, MAX_PX.tag);
    const tw = textWidth(label, 9.5, 'body') + 14;
    const t = svgEl<SVGGElement>('g', { class: 'tag t-uses', transform: 'translate(0,-8)' });
    t.append(svgEl('rect', { width: tw, height: 16, rx: 8 }));
    text(t, 'r-body', 7, 11.5, 9.5, label);
    ub.append(t);
  }
  if (n.flags.includes('platform')) {
    g.insertBefore(svgEl('path', { class: 'inner', d: shapePath(n.type, w - 8, h - 8), transform: 'translate(4,4)' }), g.querySelector('title'));
  }
  if (opts.container) {
    const pb = block(g, 'pin', w - 14, 18, 10, 11);
    pb.append(svgEl('circle', { r: 4 }));
  }
  return { g, closed, open };
}

/** SVG gradients shared by every card (chips, department bands). */
export function buildDefs(hues: number[]): SVGDefsElement {
  const defs = svgEl<SVGDefsElement>('defs');
  const grad = (id: string, top: string, bottom: string) => {
    const lg = svgEl('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
    lg.append(svgEl('stop', { offset: 0, 'stop-color': top }), svgEl('stop', { offset: 1, 'stop-color': bottom }));
    defs.append(lg);
  };
  const chips: Array<[NodeType, string, string]> = [
    ['service', '#4f8af7', '#2459c9'],
    ['api', '#9a6bf0', '#6a3fd0'],
    ['apigroup', '#9a6bf0', '#6a3fd0'],
    ['topic', '#f3a640', '#d97a12'],
    ['channel', '#34c3b5', '#178c82'],
    ['datastore', '#4cc07e', '#22894f'],
    ['external', '#ec6aa3', '#bb2f6c'],
    ['schema', '#5b8def', '#3b5bdb'],
  ];
  for (const [t, a, b] of chips) grad(`chip-${t}`, a, b);
  hues.forEach((h, i) => grad(`dept-${i}`, `hsl(${h} 46% 93%)`, `hsl(${h} 40% 88%)`));
  return defs;
}

/** Legend sample: a small card of the given type. */
export function legendShape(type: NodeType, w = 44, h = 22): SVGSVGElement {
  const svg = svgEl<SVGSVGElement>('svg', { width: w + 4, height: h + 4, viewBox: `-2 -2 ${w + 4} ${h + 4}` });
  const g = svgEl('g', { class: `node t-${type}` });
  g.append(svgEl('path', { class: 'shape', d: shapePath(type, w, h) }));
  const rim = rimPath(type, w, h);
  if (rim) g.append(svgEl('path', { class: 'rim', d: rim }));
  svg.append(g);
  return svg;
}
