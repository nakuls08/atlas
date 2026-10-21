import type { ZoomTransform } from 'd3-zoom';
import type { BoardModel, BoardNode } from '../model';
import { buildFlowGraph, impact, trace } from '../lod/paths';
import type { TourStep } from '../registry/types';
import { el, svgEl } from './dom';

/**
 * Presentation and review tools:
 *   laser (L), spotlight (S), pen / highlighter (P), review notes (N),
 *   trace a path (T), impact / blast radius (I), guided tours, presenter mode (⇧P).
 * Everything here is per viewer: ink and notes live in this browser only (local storage).
 */

export type Tool = 'select' | 'laser' | 'spotlight' | 'pen' | 'note' | 'trace' | 'impact';

export interface Highlight {
  kind: 'trace' | 'impact';
  /** Card → order on the path (trace) or hops from the start (impact). */
  nodes: Map<string, number>;
  /** Leaf connections to emphasise. */
  edges: Set<string>;
}

export interface PresentContext {
  model: BoardModel;
  nodes: Map<string, BoardNode>;
  chains: Map<string, string[]>;
  app: HTMLElement;
  stage: HTMLElement;
  svg: SVGSVGElement;
  world: SVGGElement;
  nameOf(id: string): string;
  pathOf(id: string): string;
  currentTransform(): ZoomTransform;
  viewport(): { w: number; h: number };
  zoomToNode(id: string): void;
  zoomToBox(box: { x: number; y: number; w: number; h: number }, pad?: number): void;
  setHighlight(h: Highlight | null): void;
  selectNode(id: string | null): void;
  setLevel(level: number | null): void;
  isVisible(id: string): boolean;
  setTool(t: Tool): void;
}

const TOOLS: Array<{ tool: Tool; key: string; label: string; icon: string }> = [
  { tool: 'select', key: 'V', label: 'Select and pan', icon: 'M5,3 L5,17 L9,13 L12,19 L14,18 L11,12 L16,12 Z' },
  { tool: 'laser', key: 'L', label: 'Laser pointer', icon: 'M10,10 m-3,0 a3,3 0 1,0 6,0 a3,3 0 1,0 -6,0 M10,2 V4 M10,16 V18 M2,10 H4 M16,10 H18 M4.3,4.3 L5.7,5.7 M14.3,14.3 L15.7,15.7 M4.3,15.7 L5.7,14.3 M14.3,5.7 L15.7,4.3' },
  { tool: 'spotlight', key: 'S', label: 'Spotlight ( [ ] to resize )', icon: 'M10,10 m-7,0 a7,7 0 1,0 14,0 a7,7 0 1,0 -14,0 M10,10 m-3,0 a3,3 0 1,0 6,0 a3,3 0 1,0 -6,0' },
  { tool: 'pen', key: 'P', label: 'Pen and highlighter (⌘Z undo, X clear)', icon: 'M4,16 L5,12 L13,4 L16,7 L8,15 Z M11.5,5.5 L14.5,8.5' },
  { tool: 'note', key: 'N', label: 'Review note: click a card', icon: 'M4,3 H16 V13 L12,17 H4 Z M12,17 V13 H16 M7,7 H13 M7,10 H11' },
  { tool: 'trace', key: 'T', label: 'Trace a path: click two cards', icon: 'M4,15 m-2,0 a2,2 0 1,0 4,0 a2,2 0 1,0 -4,0 M16,5 m-2,0 a2,2 0 1,0 4,0 a2,2 0 1,0 -4,0 M6,15 H10 V5 H14' },
  { tool: 'impact', key: 'I', label: 'Impact: who is affected if it fails', icon: 'M10,10 m-1.5,0 a1.5,1.5 0 1,0 3,0 a1.5,1.5 0 1,0 -3,0 M10,10 m-4.5,0 a4.5,4.5 0 1,0 9,0 a4.5,4.5 0 1,0 -9,0 M10,10 m-7.5,0 a7.5,7.5 0 1,0 15,0 a7.5,7.5 0 1,0 -15,0' },
];

const INKS = [
  { id: 'red', color: '#e5383b', width: 3, opacity: 1 },
  { id: 'blue', color: '#2f5fe0', width: 3, opacity: 1 },
  { id: 'green', color: '#1f9d5c', width: 3, opacity: 1 },
  { id: 'ink', color: '#1c1a24', width: 2.5, opacity: 1 },
  { id: 'marker', color: '#ffd23f', width: 16, opacity: 0.45 },
];

interface Stroke {
  ink: string;
  pts: Array<[number, number]>;
}
interface Note {
  id: string;
  card: string;
  text: string;
  at: string;
}

const icon = (d: string) => {
  const s = svgEl<SVGSVGElement>('svg', { viewBox: '0 0 20 20', width: 18, height: 18 });
  s.append(svgEl('path', { d }));
  return s;
};

const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable: kept for this session only */
    }
  },
};

export function initPresentation(ctx: PresentContext) {
  const { model, nodes, chains, stage, svg, world, app } = ctx;
  const boardKey = `${model.meta.version}:${model.meta.commit ?? ''}`;
  // Rebuilt when the board gains connections (progressive sources).
  let graphEdges = model.edges;
  let graphCache = buildFlowGraph(nodes, model.edges);
  const flowGraph = () => {
    if (model.edges !== graphEdges) {
      graphEdges = model.edges;
      graphCache = buildFlowGraph(nodes, model.edges);
    }
    return graphCache;
  };

  let tool: Tool = 'select';
  let ink = INKS[0];

  // ── dock ──────────────────────────────────────────────────────────────────
  const dock = el('div', { className: 'dock' });
  const toolBtns = new Map<Tool, HTMLButtonElement>();
  for (const t of TOOLS) {
    const b = el('button', { title: `${t.label}  (${t.key})` });
    b.append(icon(t.icon));
    b.onclick = () => setTool(t.tool);
    toolBtns.set(t.tool, b);
    dock.append(b);
  }
  const inkRow = el('div', { className: 'ink-row', hidden: true });
  for (const i of INKS) {
    const b = el('button', { title: i.id === 'marker' ? 'Highlighter' : i.id });
    b.style.setProperty('--ink', i.color);
    if (i.id === 'marker') b.classList.add('marker');
    b.onclick = () => {
      ink = i;
      [...inkRow.children].forEach((c) => c.classList.toggle('on', c === b));
    };
    inkRow.append(b);
  }
  (inkRow.firstChild as HTMLElement).classList.add('on');
  const sep = () => el('span', { className: 'sep' });
  const clearBtn = el('button', { title: 'Clear ink  (X)' });
  clearBtn.append(icon('M5,6 H15 M8,6 V4 H12 V6 M6,6 L7,17 H13 L14,6'));
  clearBtn.onclick = () => clearInk();
  const notesBtn = el('button', { title: 'Review notes' });
  notesBtn.append(icon('M4,4 H16 M4,8 H16 M4,12 H12 M4,16 H10'));
  const notesCount = el('span', { className: 'badge', hidden: true });
  notesBtn.append(notesCount);
  notesBtn.onclick = () => toggleNotes();
  const toursBtn = el('button', { title: 'Guided tours' });
  toursBtn.append(icon('M6,4 L16,10 L6,16 Z'));
  toursBtn.onclick = () => toggleTours();
  const presentBtn = el('button', { title: 'Presenter mode  (⇧P)' });
  presentBtn.append(icon('M3,4 H17 V13 H3 Z M10,13 V17 M6,17 H14'));
  presentBtn.onclick = () => togglePresenting();
  dock.append(sep(), clearBtn, notesBtn, toursBtn, presentBtn, inkRow);
  stage.append(dock);

  // ── overlay (laser, spotlight) ────────────────────────────────────────────
  const overlay = el('canvas', { className: 'overlay' });
  stage.append(overlay);
  const octx = overlay.getContext('2d')!;
  const sizeOverlay = () => {
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = ctx.viewport();
    overlay.width = w * dpr;
    overlay.height = h * dpr;
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  sizeOverlay();
  window.addEventListener('resize', sizeOverlay);

  const local = (e: PointerEvent | MouseEvent) => {
    const r = svg.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Laser: a glowing dot with a short fading trail.
  const trail: Array<{ x: number; y: number; t: number }> = [];
  let laserLoop = 0;
  const drawLaser = () => {
    // Another tool owns the canvas now: just stop the loop.
    if (tool !== 'laser') {
      trail.length = 0;
      laserLoop = 0;
      return;
    }
    const now = performance.now();
    while (trail.length && now - trail[0].t > 650) trail.shift();
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (tool === 'laser' && trail.length) {
      octx.lineCap = 'round';
      octx.lineJoin = 'round';
      for (let i = 1; i < trail.length; i++) {
        const age = (now - trail[i].t) / 650;
        octx.strokeStyle = `rgba(255, 45, 70, ${0.85 * (1 - age)})`;
        octx.lineWidth = 7 * (1 - age) + 1;
        octx.shadowColor = 'rgba(255, 30, 60, 0.9)';
        octx.shadowBlur = 14;
        octx.beginPath();
        octx.moveTo(trail[i - 1].x, trail[i - 1].y);
        octx.lineTo(trail[i].x, trail[i].y);
        octx.stroke();
      }
      const head = trail[trail.length - 1];
      octx.shadowBlur = 22;
      octx.fillStyle = '#ff2d46';
      octx.beginPath();
      octx.arc(head.x, head.y, 7, 0, Math.PI * 2);
      octx.fill();
      octx.shadowBlur = 0;
      octx.fillStyle = '#fff';
      octx.beginPath();
      octx.arc(head.x, head.y, 2.5, 0, Math.PI * 2);
      octx.fill();
    }
    laserLoop = trail.length && tool === 'laser' ? requestAnimationFrame(drawLaser) : 0;
  };

  // Spotlight: dim everything outside a soft circle around the pointer.
  let spot = { x: -9999, y: -9999, r: 170 };
  const drawSpotlight = () => {
    const { w, h } = ctx.viewport();
    octx.clearRect(0, 0, w, h);
    if (tool !== 'spotlight') return;
    octx.fillStyle = 'rgba(14, 12, 28, 0.62)';
    octx.fillRect(0, 0, w, h);
    octx.globalCompositeOperation = 'destination-out';
    const g = octx.createRadialGradient(spot.x, spot.y, spot.r * 0.8, spot.x, spot.y, spot.r);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    octx.fillStyle = g;
    octx.beginPath();
    octx.arc(spot.x, spot.y, spot.r, 0, Math.PI * 2);
    octx.fill();
    octx.globalCompositeOperation = 'source-over';
    octx.strokeStyle = 'rgba(255,255,255,0.5)';
    octx.lineWidth = 1.5;
    octx.beginPath();
    octx.arc(spot.x, spot.y, spot.r * 0.9, 0, Math.PI * 2);
    octx.stroke();
  };

  // ── ink (world space, sticks to the board) ────────────────────────────────
  const inkLayer = svgEl<SVGGElement>('g', { class: 'ink' });
  world.append(inkLayer);
  let strokes: Stroke[] = store.get(`atlas-ink:${boardKey}`, []);
  const strokePath = (pts: Array<[number, number]>) => {
    if (pts.length < 2) return `M${pts[0][0]},${pts[0][1]} l0.01,0`;
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const mx = (pts[i][0] + pts[i + 1][0]) / 2;
      const my = (pts[i][1] + pts[i + 1][1]) / 2;
      d += ` Q${pts[i][0]},${pts[i][1]} ${mx},${my}`;
    }
    const l = pts[pts.length - 1];
    return `${d} L${l[0]},${l[1]}`;
  };
  const strokeEl = (s: Stroke) => {
    const i = INKS.find((x) => x.id === s.ink) ?? INKS[0];
    const p = svgEl('path', { d: strokePath(s.pts), class: `ink-stroke${i.id === 'marker' ? ' marker' : ''}` });
    p.setAttribute('style', `stroke: ${i.color}; stroke-width: ${i.width}px; opacity: ${i.opacity}`);
    return p;
  };
  const renderInk = () => inkLayer.replaceChildren(...strokes.map(strokeEl));
  renderInk();
  const saveInk = () => store.set(`atlas-ink:${boardKey}`, strokes);
  function clearInk() {
    strokes = [];
    renderInk();
    saveInk();
  }

  let drawing: { s: Stroke; el: SVGElement } | null = null;
  const toWorld = (p: { x: number; y: number }): [number, number] => {
    const t = ctx.currentTransform();
    return [+((p.x - t.x) / t.k).toFixed(1), +((p.y - t.y) / t.k).toFixed(1)];
  };

  svg.addEventListener('pointerdown', (e) => {
    if (tool !== 'pen' || e.button !== 0) return;
    svg.setPointerCapture(e.pointerId);
    const s: Stroke = { ink: ink.id, pts: [toWorld(local(e))] };
    const pe = strokeEl(s);
    inkLayer.append(pe);
    drawing = { s, el: pe };
  });
  svg.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (tool === 'laser') {
      trail.push({ ...p, t: performance.now() });
      if (!laserLoop) laserLoop = requestAnimationFrame(drawLaser);
    } else if (tool === 'spotlight') {
      spot = { ...spot, ...p };
      drawSpotlight();
    } else if (drawing) {
      const w = toWorld(p);
      const last = drawing.s.pts[drawing.s.pts.length - 1];
      const k = ctx.currentTransform().k;
      if (Math.hypot(w[0] - last[0], w[1] - last[1]) * k < 2) return;
      drawing.s.pts.push(w);
      drawing.el.setAttribute('d', strokePath(drawing.s.pts));
    }
  });
  const endStroke = () => {
    if (!drawing) return;
    strokes.push(drawing.s);
    drawing = null;
    saveInk();
  };
  svg.addEventListener('pointerup', endStroke);
  svg.addEventListener('pointercancel', endStroke);

  // ── tools ─────────────────────────────────────────────────────────────────
  function setTool(t: Tool) {
    if (tool === t && t !== 'select') t = 'select';
    tool = t;
    for (const [k, b] of toolBtns) b.classList.toggle('on', k === t);
    inkRow.hidden = t !== 'pen';
    app.dataset.tool = t;
    trace0 = null;
    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (t === 'spotlight') drawSpotlight();
    if (t === 'trace') status('Trace: click where the request starts');
    else if (t === 'impact') status('Impact: click a card to see who depends on it');
    else if (t === 'note') status('Review note: click the card the note is about');
    else hideStatus();
    ctx.setTool(t);
  }

  const statusEl = el('div', { className: 'tool-status', hidden: true });
  stage.append(statusEl);
  const status = (text: string) => {
    statusEl.textContent = text;
    statusEl.hidden = false;
  };
  const hideStatus = () => (statusEl.hidden = true);

  // ── trace and impact ──────────────────────────────────────────────────────
  let trace0: string | null = null;
  const insight = el('div', { className: 'insight', hidden: true });
  stage.append(insight);
  const isService = (id: string) => ['service', 'external'].includes(nodes.get(id)!.type);
  const domainOf = (id: string) => chains.get(id)!.find((a) => ['domain', 'band'].includes(nodes.get(a)!.type)) ?? id;

  const boxOf = (ids: string[]) => {
    const ns = ids.map((id) => nodes.get(id)!).filter(Boolean);
    const x = Math.min(...ns.map((n) => n.x));
    const y = Math.min(...ns.map((n) => n.y));
    return { x, y, w: Math.max(...ns.map((n) => n.x + n.w)) - x, h: Math.max(...ns.map((n) => n.y + n.h)) - y };
  };

  function showTrace(from: string, to: string, zoom = true): boolean {
    const r = trace(flowGraph(), nodes, from, to);
    insight.hidden = false;
    if (!r) {
      ctx.setHighlight(null);
      insight.replaceChildren(el('h4', { textContent: 'No connection' }), el('p', { textContent: `Nothing connects ${ctx.nameOf(from)} and ${ctx.nameOf(to)}.` }), closeBtn());
      return false;
    }
    ctx.setHighlight({ kind: 'trace', nodes: new Map(r.path.map((id, i) => [id, i])), edges: new Set(r.edges) });
    const steps = r.path.filter((id) => !['apigroup'].includes(nodes.get(id)!.type));
    const ol = el('ol', { className: 'steps' });
    for (const id of steps) {
      const n = nodes.get(id)!;
      const li = el('li', {}, el('span', { className: `dot t-${n.type}` }), el('b', { textContent: n.name }), el('small', { textContent: n.type }));
      li.onclick = () => ctx.zoomToNode(id);
      ol.append(li);
    }
    const hops = r.path.filter(isService).length - 1;
    insight.replaceChildren(
      el('h4', { textContent: `Path · ${Math.max(hops, 0)} service hop${hops === 1 ? '' : 's'}` }),
      el('p', { className: 'sub', textContent: `${ctx.nameOf(from)} → ${ctx.nameOf(to)}${r.directed ? '' : ' (no path in the direction of travel; shown ignoring direction)'}` }),
      ol,
      el('div', { className: 'row' }, btn('Reverse', () => showTrace(to, from)), closeBtn()),
    );
    if (zoom) ctx.zoomToBox(boxOf(r.path), 0.8);
    return true;
  }

  let impactDir: 'dependents' | 'dependencies' = 'dependents';
  function showImpact(id: string, dir = impactDir, zoom = true) {
    impactDir = dir;
    const r = impact(flowGraph(), nodes, id, dir);
    ctx.setHighlight({ kind: 'impact', nodes: r.hops, edges: r.edges });
    const reached = [...r.hops].filter(([n, h]) => h > 0 && isService(n));
    const byHop = new Map<number, number>();
    for (const [, h] of reached) byHop.set(h, (byHop.get(h) ?? 0) + 1);
    const domains = new Map<string, string[]>();
    for (const [n] of reached.sort((a, b) => a[1] - b[1])) {
      const d = domainOf(n);
      if (!domains.has(d)) domains.set(d, []);
      domains.get(d)!.push(n);
    }
    const list = el('div', { className: 'impact-list' });
    for (const [d, ids] of [...domains].sort((a, b) => b[1].length - a[1].length).slice(0, 14)) {
      const row = el('div', { className: 'impact-row' }, el('b', { textContent: ctx.nameOf(d) }), el('span', { textContent: `${ids.length}` }));
      row.title = ids.map(ctx.nameOf).join(', ');
      row.onclick = () => ctx.zoomToNode(d);
      list.append(row);
    }
    const seg = el('div', { className: 'seg mini' });
    for (const [key, label] of [
      ['dependents', 'Depends on it'],
      ['dependencies', 'It depends on'],
    ] as const) {
      const b = el('button', { textContent: label, className: key === dir ? 'on' : '' });
      b.onclick = () => showImpact(id, key);
      seg.append(b);
    }
    const head =
      dir === 'dependents'
        ? `If ${ctx.nameOf(id)} fails: ${reached.length} service${reached.length === 1 ? '' : 's'} affected`
        : `${ctx.nameOf(id)} needs ${reached.length} service${reached.length === 1 ? '' : 's'}`;
    insight.hidden = false;
    insight.replaceChildren(
      el('h4', { textContent: head }),
      el('p', { className: 'sub', textContent: `across ${domains.size} domain${domains.size === 1 ? '' : 's'}` }),
      seg,
      el(
        'div',
        { className: 'rings' },
        ...[1, 2, 3].map((h) => el('span', { className: `ring r${h}` }, `${h === 3 ? '3+' : h} hop${h === 1 ? '' : 's'}: ${h === 3 ? [...byHop].filter(([k]) => k >= 3).reduce((s, [, v]) => s + v, 0) : (byHop.get(h) ?? 0)}`)),
      ),
      list,
      el('div', { className: 'row' }, closeBtn()),
    );
    if (zoom) ctx.zoomToBox(boxOf([id, ...reached.filter(([, h]) => h <= 1).map(([n]) => n)]), 0.8);
  }

  const btn = (label: string, onClick: () => void) => {
    const b = el('button', { textContent: label });
    b.onclick = onClick;
    return b;
  };
  const closeBtn = () => btn('Clear', () => clearInsight());
  function clearInsight() {
    insight.hidden = true;
    ctx.setHighlight(null);
    trace0 = null;
    if (tool === 'trace') status('Trace: click where the request starts');
  }

  // ── review notes ──────────────────────────────────────────────────────────
  let notes: Note[] = store.get(`atlas-notes:${boardKey}`, []);
  const saveNotes = () => {
    store.set(`atlas-notes:${boardKey}`, notes);
    notesCount.textContent = String(notes.length);
    notesCount.hidden = !notes.length;
    renderMarkers();
  };
  const markerLayer = svgEl<SVGGElement>('g', { class: 'note-markers' });
  world.append(markerLayer);

  /** One marker per visible card that holds notes (notes on hidden cards roll up to the visible ancestor). */
  function renderMarkers() {
    const count = new Map<string, number>();
    for (const n of notes) {
      const host = chains.get(n.card)?.find((a) => ctx.isVisible(a));
      if (host) count.set(host, (count.get(host) ?? 0) + 1);
    }
    markerLayer.replaceChildren(
      ...[...count].map(([id, c]) => {
        const n = nodes.get(id)!;
        const g = svgEl<SVGGElement>('g', { class: 'note-marker' });
        g.setAttribute('style', `transform: translate(${n.x + n.w - 6}px, ${n.y + 6}px) scale(var(--inv, 1)) translate(-26px, 0)`);
        g.append(svgEl('path', { d: 'M0,0 h22 a4,4 0 0 1 4,4 v14 a4,4 0 0 1 -4,4 h-14 l-8,6 Z' }));
        const t = svgEl('text', { x: 13, y: 15 });
        t.textContent = String(c);
        g.append(t);
        g.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleNotes(true, id);
        });
        return g;
      }),
    );
  }

  const editor = el('div', { className: 'note-editor', hidden: true });
  stage.append(editor);
  function editNote(card: string, at: { x: number; y: number }) {
    const ta = el('textarea', { placeholder: `Note about ${ctx.nameOf(card)}…`, rows: 4 });
    const save = () => {
      const text = ta.value.trim();
      editor.hidden = true;
      if (!text) return;
      notes.push({ id: `${Date.now().toString(36)}`, card, text, at: new Date().toISOString() });
      saveNotes();
    };
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
      if (e.key === 'Escape') editor.hidden = true;
      e.stopPropagation();
    };
    editor.replaceChildren(
      el('div', { className: 'note-for', textContent: ctx.pathOf(card) }),
      ta,
      el('div', { className: 'row' }, el('small', { textContent: '⌘↵ to save' }), btn('Cancel', () => (editor.hidden = true)), btn('Save note', save)),
    );
    editor.hidden = false;
    const { w, h } = ctx.viewport();
    editor.style.left = `${Math.min(at.x + 12, w - 320)}px`;
    editor.style.top = `${Math.min(at.y + 12, h - 190)}px`;
    ta.focus();
  }

  const drawer = el('aside', { className: 'drawer', hidden: true });
  stage.append(drawer);
  function notesMarkdown() {
    const lines = [`# Review notes — ${model.meta.version}${model.meta.commit ? ` (${model.meta.commit.slice(0, 10)})` : ''}`, ''];
    const byCard = new Map<string, Note[]>();
    for (const n of notes) {
      if (!byCard.has(n.card)) byCard.set(n.card, []);
      byCard.get(n.card)!.push(n);
    }
    for (const [card, ns] of byCard) {
      lines.push(`## ${ctx.pathOf(card)}`, `\`${card}\``, '');
      for (const n of ns) lines.push(`- ${n.text.replace(/\n/g, '\n  ')}  _(${n.at.slice(0, 16).replace('T', ' ')})_`);
      lines.push('');
    }
    return lines.join('\n');
  }
  function toggleNotes(force?: boolean, only?: string) {
    const open = force ?? drawer.hidden === true;
    toursPop.hidden = true;
    drawer.hidden = !open;
    notesBtn.classList.toggle('on', open);
    if (!open) return;
    const list = el('div', { className: 'note-list' });
    const shown = only ? notes.filter((n) => chains.get(n.card)?.includes(only)) : notes;
    for (const n of [...shown].reverse()) {
      const del = el('button', { className: 'link', textContent: 'Delete' });
      del.onclick = () => {
        notes = notes.filter((x) => x !== n);
        saveNotes();
        toggleNotes(true, only);
      };
      const go = el('a', { textContent: ctx.pathOf(n.card) });
      go.onclick = () => ctx.zoomToNode(n.card);
      list.append(el('div', { className: 'note' }, go, el('p', { textContent: n.text }), el('div', { className: 'row' }, el('small', { textContent: n.at.slice(0, 16).replace('T', ' ') }), del)));
    }
    if (!shown.length) list.append(el('p', { className: 'empty', textContent: 'No notes yet. Pick the note tool (N) and click a card.' }));
    const download = btn('Download .md', () => {
      const a = el('a', { download: `review-notes-${model.meta.version}.md`, href: URL.createObjectURL(new Blob([notesMarkdown()], { type: 'text/markdown' })) });
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    const copy = btn('Copy Markdown', () => copyText(notesMarkdown(), copy));
    const close = el('button', { className: 'close', textContent: '×' });
    close.onclick = () => toggleNotes(false);
    drawer.replaceChildren(
      close,
      el('h3', { textContent: only ? `Notes · ${ctx.nameOf(only)}` : `Review notes (${notes.length})` }),
      el('p', { className: 'sub', textContent: 'Kept in this browser. Export to share them with the review.' }),
      el('div', { className: 'row' }, download, copy),
      list,
    );
  }
  function copyText(text: string, b: HTMLButtonElement) {
    const done = () => {
      const was = b.textContent;
      b.textContent = 'Copied';
      setTimeout(() => (b.textContent = was), 1200);
    };
    navigator.clipboard?.writeText(text).then(done, () => fallbackCopy(text, done)) ?? fallbackCopy(text, done);
  }
  function fallbackCopy(text: string, done: () => void) {
    const ta = el('textarea', { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    done();
  }
  saveNotes();

  // ── tours ─────────────────────────────────────────────────────────────────
  const toursPop = el('div', { className: 'popover tours-pop', hidden: true });
  stage.append(toursPop);
  let draft: TourStep[] = store.get(`atlas-tour-draft:${boardKey}`, []);
  function toggleTours(force?: boolean) {
    const open = force ?? toursPop.hidden === true;
    toursPop.hidden = !open;
    drawer.hidden = true;
    toursBtn.classList.toggle('on', open);
    if (!open) return;
    const list = el('div', { className: 'tour-list' });
    for (const t of model.tours) {
      const play = btn('Play', () => playTour(t));
      list.append(el('div', { className: 'tour' }, el('div', {}, el('b', { textContent: t.name }), el('small', { textContent: `${t.steps.length} steps${t.description ? ` · ${t.description}` : ''}` })), play));
    }
    if (!model.tours.length) list.append(el('p', { className: 'empty', textContent: 'No tours in registry/tours.yaml yet.' }));
    const caption = el('input', { placeholder: 'Caption for this step…' });
    const add = btn('Add current view', () => {
      const step: TourStep = { caption: caption.value.trim() || 'Untitled step' };
      if (lastHighlight?.trace) step.trace = lastHighlight.trace;
      else if (lastHighlight?.impact) {
        step.impact = lastHighlight.impact;
        step.direction = impactDir;
      } else step.focus = currentFocus() ?? undefined;
      if (!step.focus && !step.trace && !step.impact) return;
      draft.push(step);
      store.set(`atlas-tour-draft:${boardKey}`, draft);
      toggleTours(true);
    });
    const copy = btn('Copy as YAML', () => copyText(draftYaml(), copy));
    const reset = btn('Discard', () => {
      draft = [];
      store.set(`atlas-tour-draft:${boardKey}`, draft);
      toggleTours(true);
    });
    toursPop.replaceChildren(
      el('h4', { textContent: 'Guided tours' }),
      list,
      el('h4', { textContent: `Record a tour (${draft.length} step${draft.length === 1 ? '' : 's'})` }),
      el('p', { className: 'sub', textContent: 'Select a card, or run a trace or impact, then add it as a step. Paste the YAML into registry/tours.yaml.' }),
      caption,
      el('div', { className: 'row' }, add, ...(draft.length ? [copy, reset] : [])),
    );
    caption.onkeydown = (e) => e.stopPropagation();
  }
  const draftYaml = () =>
    [
      'tours:',
      '  - id: my-tour',
      '    name: My tour',
      '    steps:',
      ...draft.map((s) => {
        const parts = [`caption: ${JSON.stringify(s.caption)}`];
        if (s.focus) parts.push(`focus: ${s.focus}`);
        if (s.trace) parts.push(`trace: [${s.trace.join(', ')}]`);
        if (s.impact) parts.push(`impact: ${s.impact}`, `direction: ${s.direction ?? 'dependents'}`);
        return `      - { ${parts.join(', ')} }`;
      }),
    ].join('\n');

  let currentFocus: () => string | null = () => null;
  let lastHighlight: { trace?: [string, string]; impact?: string } | null = null;

  const tourBar = el('div', { className: 'tour-bar', hidden: true });
  stage.append(tourBar);
  let tour: { t: BoardModel['tours'][number]; i: number } | null = null;
  function playTour(t: BoardModel['tours'][number]) {
    toggleTours(false);
    tour = { t, i: 0 };
    showStep();
  }
  function showStep() {
    if (!tour) return;
    const { t, i } = tour;
    const s = t.steps[i];
    insight.hidden = true;
    ctx.setHighlight(null);
    ctx.selectNode(null);
    ctx.setLevel(s.level ?? null);
    lastHighlight = null;
    if (s.trace) showTrace(s.trace[0], s.trace[1]);
    else if (s.impact) showImpact(s.impact, s.direction ?? 'dependents');
    else if (s.focus) {
      ctx.selectNode(s.focus);
      ctx.zoomToNode(s.focus);
    }
    const dots = el('div', { className: 'dots' }, ...t.steps.map((_, j) => el('span', { className: j === i ? 'on' : '' })));
    const prev = btn('‹', () => go(-1));
    const next = btn(i === t.steps.length - 1 ? 'Finish' : '›', () => go(1));
    prev.disabled = i === 0;
    tourBar.replaceChildren(
      el('div', { className: 'tour-title' }, el('small', { textContent: `${t.name} · ${i + 1} / ${t.steps.length}` }), dots),
      el('p', { className: 'caption', textContent: s.caption }),
      el('div', { className: 'row' }, btn('Exit', () => endTour()), prev, next),
    );
    tourBar.hidden = false;
  }
  function go(d: number) {
    if (!tour) return;
    const i = tour.i + d;
    if (i >= tour.t.steps.length) return endTour();
    if (i < 0) return;
    tour.i = i;
    showStep();
  }
  function endTour() {
    tour = null;
    tourBar.hidden = true;
    clearInsight();
    ctx.selectNode(null);
    ctx.setLevel(null);
  }

  // ── presenter mode ────────────────────────────────────────────────────────
  function togglePresenting(force?: boolean) {
    const on = force ?? !app.classList.contains('presenting');
    app.classList.toggle('presenting', on);
    presentBtn.classList.toggle('on', on);
    try {
      if (on && !document.fullscreenElement) void document.documentElement.requestFullscreen?.().catch(() => undefined);
      if (!on && document.fullscreenElement) void document.exitFullscreen?.().catch(() => undefined);
    } catch {
      /* fullscreen not allowed here; presenter mode still hides the chrome */
    }
    window.dispatchEvent(new Event('resize'));
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && app.classList.contains('presenting')) togglePresenting(false);
  });

  // ── wiring from the viewer ────────────────────────────────────────────────
  return {
    setFocusGetter(fn: () => string | null) {
      currentFocus = fn;
    },
    /** A card was clicked. Returns true when a tool consumed the click. */
    onNodeClick(id: string, e: MouseEvent): boolean {
      if (tool === 'trace') {
        if (!trace0) {
          trace0 = id;
          ctx.setHighlight({ kind: 'trace', nodes: new Map([[id, 0]]), edges: new Set() });
          status(`Trace from ${ctx.nameOf(id)}: now click the destination`);
        } else {
          const from = trace0;
          trace0 = null;
          if (showTrace(from, id, false)) lastHighlight = { trace: [from, id] };
          status('Trace: click where the next request starts');
        }
        return true;
      }
      if (tool === 'impact') {
        showImpact(id, impactDir, false);
        lastHighlight = { impact: id };
        return true;
      }
      if (tool === 'note') {
        editNote(id, local(e));
        return true;
      }
      return tool === 'laser' || tool === 'spotlight' || tool === 'pen';
    },
    /** Hover effects (edge tooltips, hot edges) only make sense while selecting. */
    passiveHover: () => tool !== 'select',
    /** Blocks panning while a pointer tool is active. */
    capturesDrag: () => tool === 'pen',
    onVisibility: renderMarkers,
    onKey(e: KeyboardEvent): boolean {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return false;
      if (tour && (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown')) return go(1), true;
      if (tour && (e.key === 'ArrowLeft' || e.key === 'PageUp')) return go(-1), true;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && strokes.length) {
        strokes.pop();
        renderInk();
        saveInk();
        return true;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return false;
      if (e.shiftKey && e.key.toLowerCase() === 'p') return togglePresenting(), true;
      if (e.key === 'Escape') {
        if (tour) return endTour(), true;
        if (!editor.hidden) return (editor.hidden = true), true;
        if (!insight.hidden || trace0) return clearInsight(), true;
        if (tool !== 'select') return setTool('select'), true;
        if (app.classList.contains('presenting')) return togglePresenting(false), true;
        return false;
      }
      if (tool === 'spotlight' && (e.key === '[' || e.key === ']')) {
        spot.r = Math.max(60, Math.min(600, spot.r * (e.key === ']' ? 1.2 : 1 / 1.2)));
        drawSpotlight();
        return true;
      }
      if (e.key.toLowerCase() === 'x' && !e.shiftKey) return clearInk(), true;
      const t = TOOLS.find((x) => x.key === e.key.toUpperCase() && !e.shiftKey);
      if (t) return setTool(t.tool), true;
      return false;
    },
    onViewChange() {
      if (tool === 'spotlight') drawSpotlight();
    },
  };
}
