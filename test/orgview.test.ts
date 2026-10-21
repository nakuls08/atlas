import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildGraph, connections, dependents, methodMix, tracePath, within } from '../src/orgview/graph';
import { HEAD, layoutOrg } from '../src/orgview/layout';
import type { ApiDetails, GraphSnapshot } from '../src/spec0/types';

const snap = JSON.parse(readFileSync('examples/spec0/snapshot-with-services.json', 'utf8')) as GraphSnapshot;
const details = JSON.parse(readFileSync('examples/spec0/details.json', 'utf8')) as Record<string, ApiDetails>;

describe('buildGraph', () => {
  it('groups by team: team → service → API, with roll-ups', () => {
    const g = buildGraph(snap, 'team');
    expect(g.roots).toHaveLength(snap.teams.length);
    expect(g.totals).toMatchObject({ teams: 37, services: 114, apis: 109, pending: 19 });
    const payments = g.cards.get('t:team-payments')!;
    expect(payments.services).toBe(8);
    expect(payments.apis).toHaveLength(8);
    expect(payments.traffic).toBe(payments.apis.reduce((s, a) => s + g.cards.get(a)!.traffic, 0));
    // Pending grants roll up to the team that has to approve them.
    expect([...g.roots].reduce((s, r) => s + g.cards.get(r)!.pending, 0)).toBe(g.totals.pending);
  });

  it('groups by domain: every API under a domain or "No domain", consumers off the board', () => {
    const g = buildGraph(snap, 'domain');
    const apis = [...g.cards.values()].filter((c) => c.kind === 'api');
    expect(apis).toHaveLength(snap.apis.length);
    expect(apis.every((a) => g.roots.includes(a.parent!))).toBe(true);
    expect(g.grants.every((gr) => g.consumerCard(gr) === null)).toBe(true);
  });

  it('splits a card\'s grants into callers, calls and the ones inside it', () => {
    const g = buildGraph(snap, 'team');
    const { callers, calls, inside } = connections(g, 't:team-payments');
    for (const gr of callers) expect(within(g, gr.api, 't:team-payments') && !within(g, g.consumerCard(gr), 't:team-payments')).toBe(true);
    for (const gr of calls) expect(!within(g, gr.api, 't:team-payments') && within(g, g.consumerCard(gr), 't:team-payments')).toBe(true);
    expect(callers.length + calls.length + inside.length).toBeGreaterThan(0);
  });

  it('traces a chain of calls and finds what depends on a card', () => {
    const g = buildGraph(snap, 'team');
    const p = tracePath(g, 't:team-checkout', 't:team-platform-edge')!;
    expect(p.cards[0]).toBe('t:team-checkout');
    expect(within(g, p.cards.at(-1)!, 't:team-platform-edge')).toBe(true);
    expect(p.grants).toHaveLength(p.cards.length - 1);
    const deps = dependents(g, 't:team-payments');
    expect(deps.has('t:team-payments')).toBe(false);
    expect([...deps].some((d) => within(g, d, 't:team-checkout'))).toBe(true);
  });

  it('counts the method mix of an API', () => {
    const d = Object.values(details)[0];
    expect(methodMix(d).reduce((s, [, n]) => s + n, 0)).toBe(d.operations.length);
  });
});

describe('layoutOrg', () => {
  const g = buildGraph(snap, 'team');
  const geo = layoutOrg(g);

  it('gives siblings one tile size and keeps top-level cards apart', () => {
    for (const c of g.cards.values()) {
      const kids = c.children.map((k) => geo.get(k)!);
      expect(new Set(kids.map((k) => `${k.w}x${k.h}`)).size).toBeLessThanOrEqual(1);
    }
    const roots = g.roots.map((r) => geo.get(r)!.abs);
    for (const a of roots) for (const b of roots) if (a !== b) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
  });

  it('puts every card inside its parent, below the header', () => {
    for (const c of g.cards.values()) {
      if (!c.parent) continue;
      const a = geo.get(c.id)!.abs;
      const p = geo.get(c.parent)!;
      const pk = g.cards.get(c.parent)!.kind;
      expect(a.x).toBeGreaterThanOrEqual(p.abs.x - 1e-6);
      expect(a.y).toBeGreaterThanOrEqual(p.abs.y + HEAD[pk] * p.ws - 1e-6);
      expect(a.x + a.w).toBeLessThanOrEqual(p.abs.x + p.abs.w + 1e-6);
      expect(a.y + a.h).toBeLessThanOrEqual(p.abs.y + p.abs.h + 1e-6);
    }
  });

  it('puts what is called from outside left of what only calls out', () => {
    const team = g.cards.get('t:team-payments')!;
    const { callers, calls } = connections(g, team.id);
    const called = team.children.filter((s) => callers.some((gr) => within(g, gr.api, s)));
    const callingOnly = team.children.filter((s) => !called.includes(s) && calls.some((gr) => within(g, g.consumerCard(gr), s)));
    for (const a of called) for (const b of callingOnly) expect(geo.get(a)!.x).toBeLessThanOrEqual(geo.get(b)!.x);
  });

  it('is the same every time', () => {
    expect(JSON.stringify([...layoutOrg(buildGraph(snap, 'team'))])).toBe(JSON.stringify([...geo]));
  });
});
