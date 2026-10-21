export const SVG_NS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...kids: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  e.append(...kids);
  return e;
}

export function svgEl<T extends SVGElement = SVGElement>(tag: string, attrs: Record<string, string | number> = {}): T {
  const e = document.createElementNS(SVG_NS, tag) as T;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
}
