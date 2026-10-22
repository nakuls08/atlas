import type { UsagePlugin } from '../enrich/usage';
import type { GraphSnapshot } from './types';

/**
 * Usage from the snapshot itself: Spec0 counts the authorisation checks it answers for each API
 * and serves the last 30 days as `calls30d`. That only covers consumers that ask Spec0 before
 * calling, so it is a plugin like any other source, and a board can put another one in front.
 */
export const spec0AuthzPlugin = (snap: GraphSnapshot): UsagePlugin => ({
  name: 'Spec0',
  async load() {
    return {
      source: 'Spec0 authorisation checks',
      window: '30d',
      asOf: snap.generatedAt,
      apis: Object.fromEntries(snap.apis.filter((a) => typeof a.calls30d === 'number').map((a) => [a.id, { calls: a.calls30d }])),
    };
  },
});
