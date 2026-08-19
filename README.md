# Clinic Appointment Booking API

A greenfield NestJS coding-assessment project: a clinic appointment booking REST API
with DB-level concurrency safety, BullMQ background jobs, and SQL-aggregated analytics.

**Stack** — NestJS (Express) · PostgreSQL 16 · Redis 7 (BullMQ) · Drizzle ORM · JWT · Swagger · Bruno

---

## Quick start

```bash
# one command boots everything (Postgres + Redis + API) with migrations on startup
bun run prod
# API:  http://localhost:3001   Swagger: http://localhost:3001/api
```

Fast local development without the containerized API:

```bash
bun install
cp .env.example .env     # defaults match the compose services
bun run dev:infra        # Postgres + Redis only (Docker)
bun run dev              # bun watch server on :3000
bun run db:migrate       # apply latest SQL migration alphabetically
# API:  http://localhost:3000   Swagger: http://localhost:3000/api
```

Then `bun run seed` to create a demo doctor (Sun–Thu 10:00–16:00, 30-min slots) and
3 patients, printing working tokens for immediate API use.

---

## Configuration (`.env`)

| Var              | Default                                          | Purpose             |
| ---------------- | ------------------------------------------------ | ------------------- |
| `DATABASE_URL`   | `postgres://clinic:clinic@localhost:5432/clinic` | Postgres connection |
| `REDIS_HOST`     | `localhost`                                      | BullMQ broker       |
| `REDIS_PORT`     | `6379`                                           | BullMQ broker       |
| `JWT_SECRET`     | `dev-only-secret-change-me`                      | HS256 signing key   |
| `JWT_EXPIRES_IN` | `1d`                                             | Token lifetime      |

---

## API surface

```
POST   /auth/register                          any
POST   /auth/login                             any

GET    /doctors                                any authenticated
GET    /doctors/:id/slots?from&to              patient, doctor      (availability, on-the-fly)
GET    /doctors/:id/schedule                   patient, doctor      (view any doctor's schedule)
GET    /doctors/me                             doctor               (profile + slot duration)
GET    /doctors/me/schedule                    doctor
PUT    /doctors/me/schedule                    doctor
GET    /doctors/me/appointments?from&to        doctor               (own booked appointments + patient name)
GET    /doctors/me/analytics?month=YYYY-MM     doctor               (pure-SQL aggregates, own data only)
POST   /doctors/me/blocks                      doctor
GET    /doctors/me/blocks                      doctor
GET    /doctors/me/blocks/:blockId             doctor
PATCH  /doctors/me/blocks/:blockId             doctor
DELETE /doctors/me/blocks/:blockId             doctor
PATCH  /doctors/me                             doctor               (slot duration 15/30/60)

POST   /appointments       { doctorId, startTime }                patient
GET    /appointments/me?status=...                                 patient   (defaults to scheduled; omit to see all)
DELETE /appointments/:id                                            patient   (2h cancel window)

POST   /waitlist           { doctorId, startTime }                patient
GET    /waitlist/me                                                 patient   (my entries + status)
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
bun run test:concurrency    # e2e: N=25 simultaneous same-slot bookings => 1x201, 24x409
bun run proof               # same against the LIVE API (docker compose up first)
bun run prod:up && bun run proof:lb  # against the load-balanced PRODUCTION build (see below)
```

Last run: `N=25 same-slot bookings -> 1 x201, 24 x409`.

### Alternatives considered (and why not chosen)

| Approach                              | Why rejected                                                                                                                                                           |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| In-app `Semaphore`/`mutex`            | Only works within one process; breaks on multiple replicas.                                                                                                            |
| Redis SETNX lock                      | Adds a coordination dependency and a TTL/lease window that can still allow a second writer right after expiry; DB index is simpler and race-free.                      |
| `SELECT ... FOR UPDATE` of a slot row | Requires a materialized slots table with row-level locking; adds rollover/maintenance jobs. Conditional insert on the computed-on-the-fly grid avoids the extra table. |
| Application-level check-then-insert   | Classic TOCTOU — two requests can both read "free" and both insert.                                                                                                    |

---

## Load-balanced production demo

The production stack (`docker-compose.prod.yml`, `bun run prod:up`) runs **two API replicas**
behind an **nginx round-robin load balancer**, sharing one Postgres and one Redis. This is the
same build intended for Kubernetes/ECS-style horizontal scaling — no in-app locks, no state
carried between requests (JWT is stateless, BullMQ is backed by shared Redis, and the slot guard
is the shared Postgres partial-unique index).

```
           ┌─────────┐
 browser ─►│   nginx │─ api-1 ─┐
 :8080     │   :80   │─ api-2 ─┼─► Postgres (shared)
           └─────────┘         └─► Redis   (shared)
```

**Why multiple replicas don't double-book:** every instance submits the same guarded
`INSERT ... ON CONFLICT DO NOTHING`, so even when LB spreads the N concurrent requests across two
distinct processes, Postgres still lets exactly one row through (the unique index is applied at
commit). Background jobs are also safe with two workers because reminder `jobId`s are
deterministic and waitlist offers use a `rowCount==1` claim.

**Boot + demonstrate:**

```bash
bun run prod:up          # builds image, runs migrations once, starts api-1 + api-2 + nginx
bun run prod:logs        # optional: watch both instances boot
bun run proof:lb         # proves BOTH instances serve traffic AND concurrency holds
```

`proof:lb` (scripts/lb-proof.ts) does two things:

1. Probes `GET /health` 40 times through the LB and tallies the `instance` field
   (`api-1` / `api-2`) — demonstrating round-robin spread, e.g.
   `health x40 via LB -> { "api-1": 20, "api-2": 20 }`.
2. Re-runs the same-slot booking proof against `http://localhost:8080`, asserting
   exactly one 201 and N-1× 409 across the two replicas.

Set `API_URL` / `CONCURRENCY_N` / `LB_PROBES` to adjust. Tear down with `bun run prod:down`.

**Migrations run exactly once**: a one-shot `migrate` service applies schema changes and the API
replicas start only after it completes (`service_completed_successfully`) — avoiding concurrent
migrator races on boot.

---

## Index rationale

| Index                                                                                      | Purpose                                                                           |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `users.email` unique                                                                       | Login lookup + registration uniqueness.                                           |
| `schedules(doctor_id, day_of_week)` unique                                                 | One schedule entry per doctor/weekday; uniqueness is also a data-integrity rule.  |
| `blocked_slots(doctor_id, block_date)`                                                     | Block subtraction in the availability query and in analytics `scheduled_minutes`. |
| `appointments(doctor_id, start_time)`                                                      | Slot anti-join for availability + active-slot listing.                            |
| partial unique `uq_appt_active_slot` on `(doctor_id, start_time) WHERE status='scheduled'` | **Concurrency guard** — the double-booking shield; backs the active-slot scan.    |
| `appointments(patient_id, start_time)`                                                     | "My appointments" and cancel lookups.                                             |
| `waiting_list(doctor_id, slot_start)`                                                      | FIFO queue claims on cancellation and offer-expiry sweeps.                        |

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

| Job            | Deterministic `jobId`               | Guarded re-check on execution                                                                |
| -------------- | ----------------------------------- | -------------------------------------------------------------------------------------------- |
| T-24h reminder | `reminder:{appointmentId}`          | Appointment still `scheduled` **and** no reminder row exists yet → exactly one notification. |
| Waitlist claim | `waitlist:{appointmentId}`          | `UPDATE … rowCount==1` → unique offer even under retries/races.                              |
| Offer sweep    | BullMQ repeatable scheduler (5 min) | Earlier sweep already flipped the entry to `expired` → next candidate.                       |

---

## Testing

```bash
bun test                      # unit tests (slot grid, booking resolution)
bun run test:e2e              # full e2e suite (auth, doctors, slots, booking, reminders, waitlist, analytics, concurrency)
bun run test:concurrency      # N=25 same-slot booking proof (1 x201, 24 x409)
bun run proof                 # same proof against the live API
bun run prod:up && bun run proof:lb  # two replicas behind nginx: traffic spread + proof
```

---

## Key design decisions

- **Timestamps stored and operated in UTC** (`timestamptz`), avoiding TZ/DST edge cases in
  slot math and analytics.
- **Availability computed with `generate_series`** rather than a materialized slot table —
  no rollover jobs, always consistent with current schedule/blocks.
- **Analytics is pure SQL** (`GET /doctors/me/analytics`, current doctor only): totals,
  cancellation rate, peak booking hour via `mode()`, and utilization
  (`booked_minutes / scheduled_minutes − blocks`) are all aggregated in one query; no rows
  are pulled into JS.
- **Schema migrations only** (`drizzle/`, applied by a script on boot). No `synchronize`.

> See [`docs/architecture.md`](docs/architecture.md) for Mermaid diagrams of the slot
> availability, booking/concurrency guard, analytics, waiting-list, and reminder flows.

---

## Future work

- Real email/SMS/WebSocket delivery for notifications instead of `notifications` rows.
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
