import { generateSlots } from './slots.generator';

const SUNDAY = '2026-08-23';

const schedule = [
  { dayOfWeek: 0, startTime: '10:00', endTime: '16:00' }, // Sunday
  { dayOfWeek: 2, startTime: '09:00', endTime: '12:00' }, // Tuesday
];

describe('generateSlots', () => {
  it('generates slots strictly inside working hours at the given duration', () => {
    const slots = generateSlots({
      schedule,
      blocks: [],
      bookedStarts: [],
      from: SUNDAY,
      to: SUNDAY,
      durationMin: 30,
    });

    expect(slots).toHaveLength(12); // 10:00..15:30 every 30 min
    expect(slots[0]).toEqual({ start: `${SUNDAY}T10:00:00.000Z`, end: `${SUNDAY}T10:30:00.000Z` });
    expect(slots[slots.length - 1].end).toBe(`${SUNDAY}T16:00:00.000Z`);
  });

  it('skips full-day blocked dates', () => {
    const slots = generateSlots({
      schedule,
      blocks: [{ blockDate: SUNDAY, startTime: null, endTime: null }],
      bookedStarts: [],
      from: SUNDAY,
      to: SUNDAY,
      durationMin: 30,
    });

    expect(slots).toHaveLength(0);
  });

  it('excludes slots overlapping a time-range block', () => {
    const slots = generateSlots({
      schedule,
      blocks: [{ blockDate: SUNDAY, startTime: '12:30', endTime: '13:30' }],
      bookedStarts: [],
      from: SUNDAY,
      to: SUNDAY,
      durationMin: 30,
    });

    const starts = slots.map((s) => s.start.slice(11, 16));
    expect(starts).not.toContain('12:30');
    expect(starts).not.toContain('13:00');
    expect(slots).toHaveLength(10);
  });

  it('excludes booked slot starts', () => {
    const slots = generateSlots({
      schedule,
      blocks: [],
      bookedStarts: [new Date(`${SUNDAY}T11:00:00Z`)],
      from: SUNDAY,
      to: SUNDAY,
      durationMin: 30,
    });

    const starts = slots.map((s) => s.start.slice(11, 16));
    expect(starts).not.toContain('11:00');
    expect(slots).toHaveLength(11);
  });

  it('only produces slots on scheduled weekdays within the range', () => {
    const slots = generateSlots({
      schedule,
      blocks: [],
      bookedStarts: [],
      from: SUNDAY,
      to: '2026-08-29', // that Saturday
      durationMin: 60,
    });

    const days = new Set(slots.map((s) => s.start.slice(0, 10)));
    expect(days).toEqual(new Set(['2026-08-23', '2026-08-25'])); // Sun + Tue
  });
});