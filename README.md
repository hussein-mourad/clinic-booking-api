# Clinic Appointment Booking API

A greenfield NestJS coding-assessment project: a clinic appointment booking REST API
with DB-level concurrency safety, BullMQ background jobs, and SQL-aggregated analytics.

**Stack** — NestJS (Express) · PostgreSQL 16 · Redis 7 (BullMQ) · Drizzle ORM · JWT · Swagger.

---

## Quick start

```bash
# one command boots everything (Postgres + Redis + API) with migrations on startup
docker compose up --build
# API:  http://localhost:3000   Swagger: http://localhost:3000/api
```

Fast local development without the containerized API:

```bash
npm install
npm run dev:infra        # Postgres + Redis only (Docker)
cp .env.example .env     # defaults match the compose services
npm run dev              # bun watch server on :3000
npm run db:migrate       # apply latest SQL migration alphabetically
```

Then `npm run seed` to create a demo doctor (Sun–Thu 10:00–16:00, 30-min slots) and
3 patients, printing working tokens for immediate API use.

---

## Configuration (`.env`)

| Var              | Default                                          | Purpose                        |
| ---------------- | ------------------------------------------------ | ------------------------------ |
| `DATABASE_URL`   | `postgres://clinic:clinic@localhost:5432/clinic` | Postgres connection            |
| `REDIS_HOST`     | `localhost`                                      | BullMQ broker                  |
| `REDIS_PORT`     | `6379`                                           | BullMQ broker                  |
| `JWT_SECRET`     | `dev-only-secret-change-me`                      | HS256 signing key              |
| `JWT_EXPIRES_IN` | `1d`                                             | Token lifetime                 |

---

## API surface

```
POST   /auth/register                          any
POST   /auth/login                             any

GET    /doctors                                any authenticated
GET    /doctors/:id/slots?from&to              any authenticated   (availability, on-the-fly)
GET    /doctors/:id/analytics?month=YYYY-MM    doctor             (pure-SQL aggregates)
PUT    /doctors/me/schedule                    doctor
GET    /doctors/me/schedule                    doctor
POST   /doctors/me/blocks                      doctor
DELETE /doctors/me/blocks/:id                  doctor
PATCH  /doctors/me                             doctor             (slot duration 15/30/60)

POST   /appointments       { doctorId, startTime }                patient
GET    /appointments/me                                             patient
DELETE /appointments/:id                                            patient   (2h cancel window)

POST   /waitlist           { doctorId, startTime }                patient
POST   /waitlist/:id/accept                                         patient
DELETE /waitlist/:id                                                patient
```

---

## Concurrency: how one slot can never be double-booked

The system is horizontally scalable (multiple API replicas, no in-app locks). The guard is at
the database level:

1. **Partial unique index** — a row may exist once per `(doctor_id, start_time)` while `scheduled`:

   ```sql
   CREATE UNIQUE INDEX uq_appt_active_slot
   ON appointments (doctor_id, start_time)
   WHERE status = 'scheduled';
   ```

2. **Conditional insert** — every booking (direct or waitlist-accept) uses
   `INSERT ... ON CONFLICT DO NOTHING RETURNING *`. No returned row ⇒ the slot was already
   taken ⇒ **409 Conflict**. The index is applied at commit time, so two transactions racing
   on the same slot resolve in Postgres itself — exactly one wins.

### Proof

```bash
npm run test:concurrency    # e2e: N=25 simultaneous same-slot bookings => 1x201, 24x409
npm run proof               # same against the LIVE API (docker compose up first)
```

Last run: `N=25 same-slot bookings -> 1 x201, 24 x409`.

### Alternatives considered (and why not chosen)

| Approach                    | Why rejected                                                                 |
| --------------------------- | ---------------------------------------------------------------------------- |
| In-app `Semaphore`/`mutex`  | Only works within one process; breaks on multiple replicas.                  |
| Redis SETNX lock            | Adds a coordination dependency and a TTL/lease window that can still allow a second writer right after expiry; DB index is simpler and race-free. |
| `SELECT ... FOR UPDATE` of a slot row | Requires a materialized slots table with row-level locking; adds rollover/maintenance jobs. Conditional insert on the computed-on-the-fly grid avoids the extra table. |
| Application-level check-then-insert | Classic TOCTOU — two requests can both read "free" and both insert. |

---

## Index rationale

| Index                                                        | Purpose                                                                                                 |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `users.email` unique                                         | Login lookup + registration uniqueness.                                                                  |
| `schedules(doctor_id, day_of_week)` unique                   | One schedule entry per doctor/weekday; uniqueness is also a data-integrity rule.                         |
| `blocked_slots(doctor_id, block_date)`                       | Block subtraction in the availability query and in analytics `scheduled_minutes`.                        |
| `appointments(doctor_id, start_time)`                        | Slot anti-join for availability + active-slot listing.                                                   |
| partial unique `uq_appt_active_slot` on `(doctor_id, start_time) WHERE status='scheduled'` | **Concurrency guard** — the double-booking shield; backs the active-slot scan. |
| `appointments(patient_id, start_time)`                       | "My appointments" and cancel lookups.                                                                    |
| `waiting_list(doctor_id, slot_start)`                        | FIFO queue claims on cancellation and offer-expiry sweeps.                                               |

No materialized slot table: availability is computed on the fly from `schedules − blocked_slots − booked`
via `generate_series`, which stays fast at this scale and avoids window-maintenance jobs.

---

## Waiting-list design & assumptions

- **Trigger:** cancelling a booking enqueues a waitlist job (deterministic
  `jobId = waitlist:{appointmentId}`), which claims the **oldest** waiting entry
  (`ORDER BY position, created_at`). Baking the job id makes retries/duplicate triggers harmless.
- **Claim is a guarded UPDATE**: `UPDATE … WHERE … AND rowCount == 1` — concurrent or retried
  jobs can never offer the same slot twice, and a slot is never offered while a `scheduled`
  appointment still occupies it (`NOT EXISTS`).
- **Offer validity = 15 minutes**, enforced by a repeatable BullMQ sweep job every 5 minutes.
  Expired offers flip to `expired` and the sweep recurses to the next FIFO candidate.
- **Accept reuses the booking guard**: `INSERT … ON CONFLICT DO NOTHING RETURNING`. A direct
  booking that fired while an offer was outstanding simply wins — the accept then returns 409
  and the patient stays `offered` (the sweep will clean it up).
- A patient may be on the waiting list for any number of slots; `DELETE /waitlist/:id` withdraws
  an entry while `waiting`/`offered`. Duplicate join for the same `(doctor, slot)` is a 409.
- Notifications (`waitlist_offer`, `waitlist_confirmation`, `reminder`) are written to the
  `notifications` table as a stand-in for real email/SMS.

---

## Background jobs (BullMQ) — idempotency

| Job            | Deterministic `jobId`                  | Guarded re-check on execution                                                              |
| -------------- | -------------------------------------- | ------------------------------------------------------------------------------------------- |
| T-24h reminder | `reminder:{appointmentId}`             | Appointment still `scheduled` **and** no reminder row exists yet → exactly one notification. |
| Waitlist claim | `waitlist:{appointmentId}`             | `UPDATE … rowCount==1` → unique offer even under retries/races.                              |
| Offer sweep    | BullMQ repeatable scheduler (5 min)    | Earlier sweep already flipped the entry to `expired` → next candidate.                       |

---

## Testing

```bash
npm test                      # unit tests (slot grid, booking resolution)
npm run test:e2e              # full e2e suite (auth, doctors, slots, booking, reminders, waitlist, analytics, concurrency)
npm run test:concurrency      # N=25 same-slot booking proof (1 x201, 24 x409)
npm run proof                 # same proof against the live API
```

---

## Key design decisions

- **Timestamps stored and operated in UTC** (`timestamptz`), avoiding TZ/DST edge cases in
  slot math and analytics.
- **Availability computed with `generate_series`** rather than a materialized slot table —
  no rollover jobs, always consistent with current schedule/blocks.
- **Analytics is pure SQL** (`GET /doctors/:id/analytics`): totals, cancellation rate,
  peak booking hour via `mode()`, and utilization (`booked_minutes / scheduled_minutes −
  blocks`) are all aggregated in one query; no rows are pulled into JS.
- **Schema migrations only** (`drizzle/`, applied by a script on boot). No `synchronize`.

---

## Future work

- Real email/SMS/WebSocket delivery for notifications instead of `notifications` rows.
- Doctor authentication could restrict analytics to the doctor's own id (`ownership` check).
- Paginate `GET /appointments/me` and add date-range filters.
- Add Git SHA/distributed trace headers to the reminder/waitlist processors for observability.
- Extend the waitlist with position jumps / priority (e.g., VIP patients) if the clinic wants
  more than strict FIFO.

---

## AI usage

This project is a coding assessment whose AI-usage rules are stated in
`docs/Backend-Developer-Technical-Task.md`. AI assistants (used as pair-programmer tooling)
were used throughout implementation. Records of what was delegated and produced:

- AI suggested the baseline NestJS + BullMQ + Drizzle architecture and the raw-SQL analytics/generate_series approach; the human reviewed and committed these into `docs/PLAN.md`.
- The Drizzle schema, migrations, and API surface were produced with AI assistance and reviewed commit-by-commit.
- Concurrency-safety design (partial unique index + `ON CONFLICT DO NOTHING`) was validated by AI and proven by automated tests — never by assertion alone.
- All decisions that affect correctness (FKs, indexes, the 2h cancel window, FIFO waitlist, 15-min offer expiry) are documented above so a human can audit them.
- Final responsibility for correctness, security, and the deliverables rests with the author (per the task's AI rules); the commit history shows each milestone landing as focused, reviewable changes.