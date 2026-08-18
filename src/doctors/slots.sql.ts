import { sql, SQL } from 'drizzle-orm';

/**
 * One SQL query computing a doctor's available slots for a date range.
 *
 *   available = weekly schedule  −  blocked slots  −  already booked
 *
 * CTE pipeline:
 *   1. candidate_days — every date in [from, to] matching a scheduled day of
 *      week, plus the timestamp boundaries of that working day (in UTC).
 *   2. slot_series    — expand each candidate day into slot start times at the
 *      doctor's configured duration (LAST slot starts at day_end − duration).
 *   3. final select   — keep a slot only when:
 *        - no full-day block on that date, and
 *        - no time-range block overlapping the slot, and
 *        - no scheduled appointment starts exactly at the slot start.
 *
 * Note: EXTRACT(DOW) returns 0=Sunday..6=Saturday, which matches
 * schedules.day_of_week directly. All timestamps are built in UTC.
 */
export function availableSlotsSql(
  doctorId: number,
  from: string,
  to: string,
  durationMin: number,
): SQL {
  return sql`
    WITH candidate_days AS (
      SELECT
        d::date AS slot_date,
        (d::date + s.start_time AT TIME ZONE 'UTC') AS day_start,
        (d::date + s.end_time AT TIME ZONE 'UTC') AS day_end
      FROM generate_series(${from}::date, ${to}::date, '1 day'::interval) AS d(date)
      JOIN schedules AS s
        ON s.doctor_id = ${doctorId}
       AND EXTRACT(DOW FROM d::date)::int = s.day_of_week
    ),
    slot_series AS (
      SELECT
        slot_date,
        generate_series(
          day_start,
          day_end - make_interval(mins => ${durationMin}),
          make_interval(mins => ${durationMin})
        ) AS slot_start
      FROM candidate_days
    )
    SELECT
      slot_start AS start,
      slot_start + make_interval(mins => ${durationMin}) AS "end"
    FROM slot_series AS ss
    WHERE NOT EXISTS (
      SELECT 1
      FROM blocked_slots AS b
      WHERE b.doctor_id = ${doctorId}
        AND b.block_date = ss.slot_date
        AND (
          -- full-day block: start_time IS NULL
          b.start_time IS NULL
          OR (
            -- time-range block: slot overlaps [block_start, block_end)
            ss.slot_start < (ss.slot_date + b.end_time AT TIME ZONE 'UTC')
            AND ss.slot_start + make_interval(mins => ${durationMin})
                   > (ss.slot_date + b.start_time AT TIME ZONE 'UTC')
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM appointments AS a
      WHERE a.doctor_id = ${doctorId}
        AND a.status = 'scheduled'
        AND a.start_time = ss.slot_start
    )
    ORDER BY slot_start;
  `;
}