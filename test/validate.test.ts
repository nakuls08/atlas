import { describe, expect, it } from 'vitest';
import { validate } from '../src/registry/validate';
import { entry, registry, sample } from './helpers';

const messages = (r: ReturnType<typeof registry>) => validate(r).map((i) => `${i.id}: ${i.message}`);

describe('validate', () => {
  it('accepts a valid registry', () => {
    expect(messages(registry(sample(), [{ from: 'returns/other', to: 'returns/api' }]))).toEqual([]);
  });

  it('rejects a missing required field and names file and entry', () => {
    const r = registry([...sample(), entry('api', 'returns/bad', { hostedBy: 'returns/svc' })]);
    const issues = validate(r);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ id: 'returns/bad', file: 'registry/returns.yaml' });
    expect(issues[0].message).toMatch(/style/);
  });

  it('rejects a broken reference', () => {
    const r = registry([...sample(), entry('api', 'returns/bad', { hostedBy: 'returns/nope', style: 'REST' })]);
    expect(messages(r)).toEqual(['returns/bad: `hostedBy` references unknown id "returns/nope"']);
  });

  it('rejects a reference to the wrong type', () => {
    const r = registry([...sample(), entry('api', 'returns/bad', { hostedBy: 'returns/topic', style: 'REST' })]);
    expect(messages(r)[0]).toMatch(/must reference a service/);
  });

  it('rejects a connection pair outside the rules', () => {
    expect(messages(registry(sample(), [{ from: 'returns/api', to: 'returns/svc' }]))).toEqual([
      'returns/api → returns/svc: A api cannot connect to a service',
    ]);
  });

  it('rejects an unknown-API call without a gap reason, accepts it with one', () => {
    expect(messages(registry(sample(), [{ from: 'returns/other', to: 'returns/svc' }]))[0]).toMatch(/gap/);
    expect(messages(registry(sample(), [{ from: 'returns/other', to: 'returns/svc', gap: 'legacy' }]))).toEqual([]);
  });

  it('rejects a connection to an unknown id', () => {
    expect(messages(registry(sample(), [{ from: 'returns/svc', to: 'billing/api' }]))[0]).toMatch(/unknown id "billing\/api"/);
  });

  it('rejects an owner connecting to its own datastore', () => {
    expect(messages(registry(sample(), [{ from: 'returns/svc', to: 'returns/db' }]))[0]).toMatch(/implicit/);
  });
});
