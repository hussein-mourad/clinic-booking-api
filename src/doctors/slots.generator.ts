/**
 * Generate a doctor's available slots across [from, to] entirely in JS.
 *
 *   available = weekly schedule  -  blocked slots  -  already booked
 *
 * Readability over one big SQL query: the doctor's schedule, blocked slots and
 * scheduled appointments are fetched with indexed range queries (tiny result
 * sets per doctor), then combined here. Appointment start times are guaranteed
 * unique per doctor by the `uq_appt_active_slot` partial index, so a simple
 * Set keeps booked-slot exclusion correct.
 */

export interface ScheduleDay {
  dayOfWeek: number;
  startTime: string;
  endTime: string;
}

export interface BlockedRange {
  blockDate: string;
  startTime: string | null; // null => full-day block
  endTime: string | null;
}

export interface GeneratedSlot {
  start: string;
  end: string;
}

export interface GenerateSlotsParams {
  schedule: ScheduleDay[];
  blocks: BlockedRange[];
  /** The `start_time` of every active (status = 'scheduled') appointment. */
  bookedStarts: Date[];
  from: string;
  to: string;
  durationMin: number;
}

const ONE_MINUTE_MS = 60_000;
// Postgres `time` columns come back as 'HH:MM:SS'; only HH:MM is meaningful here.
const toHHMM = (t: string) => t.slice(0, 5);
const localDate = (date: string, time: string): number =>
  new Date(`${date}T${toHHMM(time)}:00Z`).getTime();

export function generateSlots({
  schedule,
  blocks,
  bookedStarts,
  from,
  to,
  durationMin,
}: GenerateSlotsParams): GeneratedSlot[] {
  const stepMs = durationMin * ONE_MINUTE_MS;
  // Step 2.1: Index weekly schedule by day of week (0 = Sunday .. 6 = Saturday) for O(1) lookup
  const scheduleByDay = new Map<
    number,
    { startTime: string; endTime: string }
  >();
  for (const day of schedule)
    scheduleByDay.set(day.dayOfWeek, {
      startTime: toHHMM(day.startTime),
      endTime: toHHMM(day.endTime),
    });

  // Step 2.2: Index blocked slots by date (distinguishing full-day vs partial-day blocks)
  const fullyBlockedDates = new Set<string>();
  const blockedRangesByDate = new Map<
    string,
    { start: number; end: number }[]
  >();
  for (const block of blocks) {
    if (block.startTime === null || block.endTime === null) {
      fullyBlockedDates.add(block.blockDate);
      continue;
    }
    const ranges = blockedRangesByDate.get(block.blockDate) ?? [];
    ranges.push({
      start: localDate(block.blockDate, block.startTime),
      end: localDate(block.blockDate, block.endTime),
    });
    blockedRangesByDate.set(block.blockDate, ranges);
  }

  // Step 2.3: Build O(1) Set of active appointment start times for instant exclusion
  const bookedAt = new Set<number>(bookedStarts.map((d) => d.getTime()));
  const slots: GeneratedSlot[] = [];

  // Step 3: Set up cursor to walk day-by-day from `from` to `to` date
  const day = new Date(`${from}T00:00:00Z`);
  const lastDay = new Date(`${to}T23:59:59Z`);

  while (day <= lastDay) {
    const ymd = day.toISOString().slice(0, 10);
    const entry = scheduleByDay.get(day.getUTCDay());

    // If doctor works on this weekday and the day isn't fully blocked
    if (entry && !fullyBlockedDates.has(ymd)) {
      const dayStart = localDate(ymd, entry.startTime);
      const dayEnd = localDate(ymd, entry.endTime);
      const ranges = blockedRangesByDate.get(ymd) ?? [];

      // Step 4: Tile working hours by slot duration steps and filter availability
      for (let start = dayStart; start + stepMs <= dayEnd; start += stepMs) {
        const end = start + stepMs;
        // Check 1: Does slot overlap with any partial-day block (e.g. lunch)?
        const overlapsBlock = ranges.some(
          (r) => start < r.end && end > r.start,
        );
        // Check 2: Is slot already taken by an existing booking?
        if (!overlapsBlock && !bookedAt.has(start)) {
          slots.push({
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
          });
        }
      }
    }

    // Advance cursor to next calendar day
    day.setUTCDate(day.getUTCDate() + 1);
  }

  return slots;
}
