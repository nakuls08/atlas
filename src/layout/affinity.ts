/**
 * Greedy chain: start from the most connected, then repeatedly append the one most connected
 * to the last placed (ties: to anything placed, then by id). Deterministic.
 */
export function orderByAffinity(ids: string[], w: (a: string, b: string) => number): string[] {
  const rest = [...ids].sort();
  if (!rest.length) return [];
  const total = (id: string) => rest.reduce((s, o) => s + (o === id ? 0 : w(id, o)), 0);
  rest.sort((a, b) => total(b) - total(a) || a.localeCompare(b));
  const out = [rest.shift()!];
  while (rest.length) {
    const last = out[out.length - 1];
    const score = (id: string) => w(last, id) * 1000 + out.reduce((s, o) => s + w(o, id), 0);
    rest.sort((a, b) => score(b) - score(a) || a.localeCompare(b));
    out.push(rest.shift()!);
  }
  return out;
}
