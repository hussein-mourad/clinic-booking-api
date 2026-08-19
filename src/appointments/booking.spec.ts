import { resolveBookableSlot } from './booking';

const slot = (start: string, end: string) => ({ start, end });

describe('resolveBookableSlot', () => {
  const durationMin = 30;
  const slots = [
    slot('2026-08-23T10:00:00.000Z', '2026-08-23T10:30:00.000Z'),
    slot('2026-08-23T10:30:00.000Z', '2026-08-23T11:00:00.000Z'),
    slot('2026-08-23T11:00:00.000Z', '2026-08-23T11:30:00.000Z'),
  ];

  it('resolves an exact grid start with matching duration', () => {
    expect(
      resolveBookableSlot('2026-08-23T10:30:00.000Z', slots, durationMin),
    ).toEqual(slots[1]);
  });

  it('rejects an off-grid start', () => {
    expect(
      resolveBookableSlot('2026-08-23T10:07:00.000Z', slots, durationMin),
    ).toBeNull();
  });

  it('rejects a start that is not in the available list', () => {
    expect(
      resolveBookableSlot('2026-08-23T14:00:00.000Z', slots, durationMin),
    ).toBeNull();
  });

  it('rejects a start whose end does not match the requested duration', () => {
    expect(
      resolveBookableSlot('2026-08-23T10:30:00.000Z', slots, 60),
    ).toBeNull();
  });
});
