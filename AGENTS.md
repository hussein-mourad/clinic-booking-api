# AGENTS.md

## What this repo is

Greenfield NestJS coding-assessment project: a clinic appointment booking API. **No application code exists yet** — until it is scaffolded, `docs/` is the only source of truth:

- `docs/Backend-Developer-Technical-Task.md` — the assessment brief, deliverables, and AI-usage rules.
- `docs/Clinic-Appointment-Booking-API-PRD.md` — functional/NFR requirements and evaluation criteria.
- `docs/PLAN.md` — the agreed implementation plan; follow it and only deviate with a reason.

## Fixed stack

NestJS (Express) + PostgreSQL 16 + Redis 7 (BullMQ) + Drizzle ORM + JWT. PLAN.md deliberately chose Drizzle over TypeORM for raw-SQL analytics and `INSERT ... ON CONFLICT`; don't silently swap frameworks.

## Non-negotiable requirements (assessment criteria)

- Schema changes via **SQL migrations only** — never `synchronize: true`.
- Concurrency guard at the **DB level**: partial unique index `uq_appt_active_slot` on `appointments(doctor_id, start_time) WHERE status='scheduled'` + `INSERT ... ON CONFLICT DO NOTHING RETURNING`; no return row ⇒ 409. No in-app locks/mutexes (app is horizontally scaled).
- Analytics (`GET /doctors/:id/analytics?month=YYYY-MM`) must aggregate **in SQL** — never load rows into JS and compute there.
- Reminders and waitlist-processing are **BullMQ jobs that must be retry-idempotent** (deterministic `jobId`s; guarded `WHERE ... rowCount==1` claims).
- Deliverables: `docker-compose.yml` (app + Postgres + Redis, one-command boot); concurrency proof `scripts/` + `npm run test:concurrency` (N=25 same-slot bookings ⇒ exactly one 201, rest 409); README documenting concurrency approach + alternatives, index rationale, waiting-list assumptions, and an AI-usage section.
- Meaningful **incremental commit history** matching PLAN.md §16 milestones — never a single squashed dump.

## Key decisions already made in PLAN.md

- Slot availability computed on the fly with `generate_series` (no materialized slots table); timestamps stored and operated in UTC.
- Waitlist: FIFO by `(position, created_at)`, 15-minute offer expiry via sweep job, accept endpoint reuses the booking INSERT guard.
- API surface and status-code conventions: PLAN.md §12.
- Index list + rationale in PLAN.md §11 must be reflected in the README.