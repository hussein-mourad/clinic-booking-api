export interface BookableSlot {
  start: string;
  end: string;
}

/**
 * Match a requested slot start against the doctor's currently available slots.
 * Returns the slot only when the start is exactly on the availability grid AND
 * its end matches the doctor's configured slot duration. Pure/unit-testable;
 * used only for an early 400 (never trusted for correctness — the booking
 * INSERT guard is the authority).
 */
export function resolveBookableSlot(
  startTime: string,
  available: BookableSlot[],
  durationMin: number,
): BookableSlot | null {
  const iso = new Date(startTime).toISOString();
  const slot = available.find((s) => s.start === iso);
  if (!slot) return null;
  const expectedEnd = new Date(
    new Date(iso).getTime() + durationMin * 60_000,
  ).toISOString();
  return slot.end === expectedEnd ? slot : null;
}
