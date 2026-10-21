import { describe, expect, it } from 'vitest';
import { buildTree } from '../src/registry/tree';
import { validate } from '../src/registry/validate';
import { entry, registry, sample } from './helpers';

describe('buildTree', () => {
  it('groups the APIs of a host with more than 8 by tag', () => {
    const apis = Array.from({ length: 10 }, (_, i) =>
      entry('api', `returns/a${i}`, { hostedBy: 'returns/svc', style: 'REST', tags: [i < 6 ? 'orders' : 'admin'] }),
    );
    const reg = registry([...sample().filter((e) => e.type !== 'api'), ...apis]);
    expect(validate(reg)).toEqual([]);
    const { nodes } = buildTree(reg);
    expect(nodes.get('returns/svc')!.children).toEqual(expect.arrayContaining(['returns/svc#orders', 'returns/svc#admin']));
    expect(nodes.get('returns/svc#orders')!.children).toHaveLength(6);
    expect(nodes.get('returns/a0')!.parent).toBe('returns/svc#orders');
  });

  it('requires tags on every API of a busy host', () => {
    const apis = Array.from({ length: 9 }, (_, i) => entry('api', `returns/a${i}`, { hostedBy: 'returns/svc', style: 'REST' }));
    const issues = validate(registry([...sample(), ...apis]));
    expect(issues.filter((i) => /needs `tags`/.test(i.message))).toHaveLength(10); // 9 + the sample API
  });

  it('marks platform links and gives callers a "uses" badge', () => {
    const entries = [...sample(), entry('service', 'returns/auth', { owningTeam: 't', role: 'platform' }), entry('api', 'returns/auth-api', { hostedBy: 'returns/auth', style: 'REST' })];
    const { nodes, edges } = buildTree(registry(entries, [{ from: 'returns/svc', to: 'returns/auth-api' }]));
    expect(edges[0].platform).toBe(true);
    expect(nodes.get('returns/svc')!.uses).toEqual(['auth']);
    expect(nodes.get('returns/auth')!.flags).toContain('platform');
  });

  it('flags shared datastores, callers of deprecated APIs and superseded APIs', () => {
    const entries = [
      ...sample(),
      entry('api', 'returns/old', { hostedBy: 'returns/svc', style: 'REST', status: 'deprecated' }),
      entry('api', 'returns/new', { hostedBy: 'returns/svc', style: 'REST', supersedes: 'returns/old' }),
    ];
    const { nodes } = buildTree(
      registry(entries, [
        { from: 'returns/other', to: 'returns/db' },
        { from: 'returns/other', to: 'returns/old' },
      ]),
    );
    expect(nodes.get('returns/db')!.flags).toContain('shared');
    expect(nodes.get('returns/other')!.flags).toContain('migrate');
    expect(nodes.get('returns/old')!.flags).toContain('superseded');
  });

  it('places channels next to their owner, like topics', () => {
    const entries = [...sample(), entry('channel', 'returns/sftp', { ownedBy: 'returns/svc', technology: 'SFTP' })];
    expect(validate(registry(entries))).toEqual([]);
    const { nodes } = buildTree(registry(entries));
    expect(nodes.get('returns/sftp')!.parent).toBe('returns/sys');
  });

  it('requires a claimant on a disputed service', () => {
    const issues = validate(registry([...sample(), entry('service', 'returns/x', { owningTeam: 't', ownership: 'disputed' })]));
    expect(issues.map((i) => i.message)).toContain('A disputed service needs a `claimant` domain');
  });
});
