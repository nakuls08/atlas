export interface LodNode {
  id: string;
  parent: string | null;
  level: number;
  w: number;
  children: string[];
  /**
   * Zoom at which this container's children become readable. A container opens only once the
   * zoom reaches it, as well as `expandAt` ("large enough to hold its children readably").
   */
  openK?: number;
}

export interface LodOptions {
  expandAt: number;
  collapseAt: number;
  /** "Show down to" level: containers above this level are open, the rest closed. */
  levelOverride?: number | null;
  /** Pinned containers: true = always open, false = always closed. */
  pins?: ReadonlyMap<string, boolean>;
}

export interface VisibleState {
  /** Containers currently open. */
  expanded: Set<string>;
  /** Nodes currently drawn (every ancestor is open). */
  visible: Set<string>;
  /** Stable signature of `visible`, for memoising edge lifting. */
  signature: string;
}

/**
 * Decides which containers are open at zoom scale `k`.
 * `prev` gives hysteresis: an open container stays open until it drops below `collapseAt`.
 */
export function computeVisible(
  nodes: ReadonlyMap<string, LodNode>,
  roots: readonly string[],
  k: number,
  prev: ReadonlySet<string>,
  opts: LodOptions,
): VisibleState {
  const expanded = new Set<string>();
  const visible = new Set<string>();

  const isOpen = (n: LodNode): boolean => {
    const pin = opts.pins?.get(n.id);
    if (pin !== undefined) return pin;
    if (opts.levelOverride != null) return n.level < opts.levelOverride;
    const sw = n.w * k;
    const openK = n.openK ?? 0;
    return prev.has(n.id) ? sw >= opts.collapseAt && k >= openK * 0.85 : sw >= opts.expandAt && k >= openK;
  };

  const stack = [...roots].reverse();
  while (stack.length) {
    const id = stack.pop()!;
    const n = nodes.get(id)!;
    visible.add(id);
    if (n.children.length && isOpen(n)) {
      expanded.add(id);
      for (let i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
  }

  return { expanded, visible, signature: [...expanded].join('|') };
}
