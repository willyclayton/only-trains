/** Pixels available below `top` (viewport y) inside the nearest clipping/scrolling ancestor of `el`. */
export function spaceBelow(el: HTMLElement | null, top: number, margin = 10): number {
  let node = el?.parentElement ?? null;
  let bottom = window.innerHeight;
  while (node && node !== document.body) {
    const s = getComputedStyle(node);
    if (/(auto|scroll|hidden|clip)/.test(s.overflowY)) {
      bottom = Math.min(bottom, node.getBoundingClientRect().bottom);
      break;
    }
    node = node.parentElement;
  }
  return Math.max(120, Math.floor(bottom - top - margin));
}
