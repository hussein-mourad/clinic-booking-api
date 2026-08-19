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
  const scheduleByDay = new Map<
    number,
    { startTime: string; endTime: string }
  >();
  for (const day of schedule)
    scheduleByDay.set(day.dayOfWeek, {
      startTime: toHHMM(day.startTime),
      endTime: toHHMM(day.endTime),
    });

  // Index blocked slots by date; keep full-day blocks separate.
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

  // Set of booked slot start times for O(1) exclusion.
  const bookedAt = new Set<number>(bookedStarts.map((d) => d.getTime()));
  const slots: GeneratedSlot[] = [];

  const day = new Date(`${from}T00:00:00Z`);
  const lastDay = new Date(`${to}T23:59:59Z`);

  while (day <= lastDay) {
    const ymd = day.toISOString().slice(0, 10);
    const entry = scheduleByDay.get(day.getUTCDay());

    if (entry && !fullyBlockedDates.has(ymd)) {
      const dayStart = localDate(ymd, entry.startTime);
      const dayEnd = localDate(ymd, entry.endTime);
      const ranges = blockedRangesByDate.get(ymd) ?? [];

      // Slots tile the working hours; the last slot ends exactly at dayEnd.
      for (let start = dayStart; start + stepMs <= dayEnd; start += stepMs) {
        const end = start + stepMs;
        const overlapsBlock = ranges.some(
          (r) => start < r.end && end > r.start,
        );
        if (!overlapsBlock && !bookedAt.has(start)) {
          slots.push({
            start: new Date(start).toISOString(),
            end: new Date(end).toISOString(),
          });
        }
      }
    }

    day.setUTCDate(day.getUTCDate() + 1);
  }

  return slots;
}
