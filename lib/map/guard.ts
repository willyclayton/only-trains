/** A tap that closes a map overlay panel must not also drop a pin. */
let closedAt = 0;
export function markPanelClosedByTap(): void {
  closedAt = Date.now();
}
export function tapJustClosedPanel(): boolean {
  return Date.now() - closedAt < 600;
}
