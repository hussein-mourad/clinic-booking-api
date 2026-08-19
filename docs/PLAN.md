# Plan: Clinic Appointment Booking API

**Stack:** NestJS + PostgreSQL 16 + Redis 7 (BullMQ) + Drizzle ORM

---

## 1. Goal

A REST API where patients book appointment slots at a medical clinic. Doctors define
weekly recurring schedules and block specific dates/times. The system must:

- Prevent double-booking under concurrent, multi-instance load (enforced at the DB level).
- Keep slot-lookup fast at scale (~200 doctors, ~2M appointment rows).
- Provide a waiting list for fully booked slots.
- Offload reminders and waitlist handling to background jobs that are retry-safe.
- Produce a migration-based, dockerized, tested, well-documented codebase.

---

## 2. Stack & rationale

| Choice                                | Rationale |
|---------------------------------------|-----------|
| NestJS (Express)                      | Required framework |
| Drizzle ORM + `drizzle-kit`           | Type-safe, modern, first-class raw SQL (`sql` template + `generate_series`); migrations generated as plain SQL — no `synchronize: true` |
| PostgreSQL 16                         | Required; partial unique index + `INSERT ... ON CONFLICT` for concurrency |
| Redis 7 + BullMQ                      | Required; job queue only, nothing else persisted in Redis |
| JWT + @nestjs/jwt + bcrypt            | Minimal two-role (patient/doctor) auth |
| Jest + supertest                      | Unit + e2e tests and the concurrency proof |
| class-validator / class-transformer   | DTO validation |
| node-postgres (`pg`)                  | Connection driver for Drizzle |

**Drizzle vs TypeORM:** Drizzle chosen for stronger type safety, better raw-SQL ergonomics
(the analytics requirement is literal raw SQL), and first-class `INSERT ... ON CONFLICT ... RETURNING`
for the booking guard. Cost: thin `DatabaseModule` wrapper instead of `@nestjs/typeorm` auto-wiring.

---

## 3. Project structure

```
src/
  database/        # Drizzle provider (pool + schema export), migration runner
  auth/            # register/login, JwtStrategy, PatientGuard/DoctorGuard
  users/           # user profile plumbing
  doctors/         # weekly schedules + blocked slots + slot duration
  slots/           # availability query (generate_series anti-join)
  appointments/    # book / cancel / my bookings
  waitlist/        # join / leave / accept offers
  analytics/       # monthly SQL aggregates
  jobs/            # BullMQ wiring, reminder + waitlist processors
  notifications/   # stand-in delivery (DB table as "email/SMS")
scripts/           # seed + concurrency-proof scripts
drizzle/           # generated SQL migrations
docker-compose.yml, Dockerfile, .env.example
```

NestJS modules mirror these folders.

---

## 4. Data model (tables)

- `users(id, email uq, password_hash, name, role: patient|doctor, slot_duration_min, created_at, updated_at)`
- `schedules(id, doctor_id fk, day_of_week int 0-6, start_time time, end_time time)` — weekly recurring
- `blocked_slots(id, doctor_id fk, block_date date, start_time time null, end_time time null)` — null times = full day
- `appointments(id, doctor_id fk, patient_id fk, start_time tstz, end_time tstz, status: scheduled|cancelled|completed, created_at, cancelled_at)`
- `waiting_list(id, doctor_id fk, slot_start tstz, patient_id fk, position int, status: waiting|offered|accepted|expired|declined, offered_at, offer_expires_at, created_at)`
- `notifications(id, user_id fk, type: reminder|waitlist_offer|waitlist_confirmation, payload jsonb, sent_at)`

All timestamps stored in UTC.

---

## 5. Concurrency control (core deliverable)

**Chosen: partial unique index + `INSERT ... ON CONFLICT DO NOTHING RETURNING`**

```sql
CREATE UNIQUE INDEX uq_appt_active_slot
  ON appointments(doctor_id, start_time)
  WHERE status = 'scheduled';
```

Booking flow (single transaction):
1. App-level validation that the slot is genuinely open (schedule minus blocks minus booked).
   Fast-fail 400 on invalid slots, but this check is never trusted for correctness.
2. `INSERT INTO appointments ... ON CONFLICT DO NOTHING RETURNING *`.
3. No row returned  ->  **409 SlotTaken**. Otherwise 201 + schedule reminder job.

Exactly one INSERT can succeed per `(doctor, start_time)`; PostgreSQL enforces this across
all app instances. No locks held, retry-safe.

**Alternatives considered (README must document):**
- `SELECT ... FOR UPDATE` on doctor row: serializes requests per doctor, more contention than
  needed for a single-slot guard.
- Postgres advisory locks: explicit and multi-instance safe, but manual and easy to misuse/leak.
- In-app locks / in-memory mutex: rejected — meaningless across horizontally scaled instances.

---

## 6. Slot availability (computed on the fly)

- For a doctor + date range, expand `schedules` via `generate_series` at
  `slot_duration_min` steps -> candidate slot starts.
- Subtract `blocked_slots` ranges and booked active appointments (anti-join).
- Return `[{ start, end, available }]` from one SQL query/CTE (Drizzle `sql`).

No materialized slots table: with ~200 doctors and the indexes in §11, on-the-fly expansion
stays fast and avoids rollover/window-maintenance jobs.

---

## 7. Booking / cancel rules

- **Book** (patient): validate slot open, guard-insert (§5), enqueue reminder, return 201.
- **Cancel** (patient, own booking only): allowed only if
  `appointment.start_time - now >= 2h` (else 422). Set `status=cancelled`, `cancelled_at`;
  remove reminder job by deterministic `jobId`; enqueue waitlist-processing job.

---

## 8. Background jobs (BullMQ) & idempotency

- **Reminder:** `jobId = reminder:{appointmentId}` (deterministic -> no duplicates on retry
  or re-enqueue), delay = T-24h. On execution, re-check the appointment is still `scheduled`
  (belt-and-suspenders for the cancelled case) and write to `notifications`. Retry has no side effects.
- **Waitlist processing** (triggered by cancellation): transaction picks the FIFO candidate;
  `UPDATE waiting_list SET status='offered', offer_expires_at=now()+15min
   WHERE slot matches AND status='waiting' ORDER BY position, created_at`
  and requires `rowCount == 1` (unique claim -> concurrent/retried job can't double-offer).
  Writes an offer notification.
- **Offer lifecycle:** a repeatable sweep job expires `offered` rows past deadline ->
  `expired`, then recurses to the next candidate. The accept endpoint uses the same
  appointment INSERT guard, so a slot can never be assigned twice even under races.

---

## 9. Waiting-list assumptions (documented in README)

- FIFO by `(position, created_at)`.
- Offer valid **15 minutes**, then auto-expires and the slot moves to the next candidate.
- A patient may join multiple slots; leaving removes their rows.
- Accepting an offer performs a guarded booking attempt (may still 409 if a direct booking won).
- Notifications are logged to the `notifications` table in place of real email/SMS.

---

## 10. Analytics endpoint (pure SQL)

`GET /doctors/:id/analytics?month=YYYY-MM` -> one aggregate query returning:
- `total_appointments`: appointments whose slot falls in the month
- `cancellation_rate`: cancelled / total
- `peak_booking_hours`: `mode()` over `extract(hour from start_time)`
- `avg_utilization`: `sum(booked_slot_minutes) / sum(available_scheduled_minutes)` —
  availability from `schedules` minus `blocked_slots`, all computed in SQL.

No rows pulled into JS for aggregation (explicit requirement).

---

## 11. Indexes (documented in README)

- `appointments(doctor_id, start_time)` — slot anti-join; backs the partial unique index
- partial unique `uq_appt_active_slot ON appointments(doctor_id, start_time) WHERE status='scheduled'` — concurrency guard + active-slot listing
- `appointments(patient_id, start_time)` — "my bookings" + cancel lookups
- `blocked_slots(doctor_id, block_date)` — block subtraction in availability query
- `waiting_list(doctor_id, slot_start)` — queue claims on cancellation

---

## 12. API surface

```
POST   /auth/register
POST   /auth/login
PUT    /doctors/me/schedule                        (doctor)
GET    /doctors/me/schedule                        (doctor)
POST   /doctors/me/blocks                          (doctor)
DELETE /doctors/me/blocks/:id                      (doctor)
PATCH  /doctors/me                                 (doctor, slot duration)
GET    /doctors/:id/slots?from&to                  (any authenticated)
GET    /doctors/:id/analytics?month=YYYY-MM       (doctor)
POST   /appointments      { doctorId, startTime } (patient)
DELETE /appointments/:id                          (patient)
GET    /appointments/me                           (patient)
POST   /waiting-list      { doctorId, startTime } (patient)
DELETE /waiting-list/:id                          (patient)
POST   /waiting-list/:id/accept                   (patient)
```

---

## 13. Tests & concurrency proof

- **Unit:** slot validation, cancel-window rule, offer-claim logic.
- **e2e (supertest):** register/login, book, cancel, full waitlist scenario end-to-end.
- **Concurrency proof:** `bun run test:concurrency` — fires N=25 simultaneous booking
  requests at the same `(doctor, slot)` and asserts **exactly one 201**, the rest 409.
  Ships as a script in `scripts/` (assessors can run it against the live app) and as a Jest
  test. If time allows, also run it against two API replicas behind the compose load balancer.

---

## 14. Docker / boot

- `docker-compose.yml`: `postgres:16`, `redis:7`, `api` (multi-stage Dockerfile).
- App runs migrations on startup via a small drizzle migration script in the entrypoint.
- Single command: `docker compose up --build`.
- `.env.example` with all configuration.

---

## 15. Deliverables checklist

- Git repo with meaningful, incremental commit history
- README: setup, concurrency approach + alternatives, index rationale,
  waiting-list assumptions, AI-usage section, future-work notes
- SQL migrations (no `synchronize`)
- Concurrency proof + reasonable booking-logic tests
- docker-compose
- Seed script for demo (doctor, schedules, blocks, patients)

---

## 16. Milestones & commit plan

1. Scaffold NestJS + Drizzle provider + docker-compose
2. Migrations + full schema
3. Auth (register/login, guards)
4. Doctor schedules + blocked slots
5. Slots availability query
6. Booking + concurrency guard
7. Cancel + reminder job
8. Waitlist (join/offer/accept/expiry) + processing job
9. Analytics SQL
10. Tests (unit/e2e/concurrency) + seed
11. README + polish

Each milestone = one or more focused commits (no single squashed dump).

---

## 17. Open risks

- `generate_series` timezone/DST edge cases -> store and operate in UTC.
- Offer-expiry vs. accept race -> resolved by the appointment INSERT guard.
- Multi-instance concurrency proof is a nice-to-have (2 API replicas in compose).