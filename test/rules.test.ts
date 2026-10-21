import { describe, expect, it } from 'vitest';
import { CONNECTION_RULES, connectionKind } from '../src/registry/rules';
import type { EntryType } from '../src/registry/types';

const TYPES: EntryType[] = ['department', 'domain', 'system', 'service', 'api', 'topic', 'channel', 'datastore', 'external', 'cluster'];

const EXPECTED: Record<string, string> = {
  'service>api': 'calls',
  'external>api': 'calls',
  'service>external': 'calls',
  'service>topic': 'publishes',
  'topic>service': 'consumes',
  'topic>external': 'consumes',
  'external>topic': 'publishes',
  'service>channel': 'publishes',
  'channel>service': 'consumes',
  'channel>external': 'consumes',
  'external>channel': 'publishes',
  'service>datastore': 'reads-writes',
  'service>service': 'calls-unknown',
};

describe('connection rules', () => {
  const pairs = TYPES.flatMap((from) => TYPES.map((to) => [from, to] as const));

  it.each(pairs)('%s → %s', (from, to) => {
    expect(connectionKind(from, to) ?? 'rejected').toBe(EXPECTED[`${from}>${to}`] ?? 'rejected');
  });

  it('the table has exactly the documented pairs', () => {
    expect(CONNECTION_RULES).toHaveLength(Object.keys(EXPECTED).length);
  });
});
