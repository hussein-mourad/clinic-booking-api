# Clinic Booking API — Milestones

Architecture: NestJS (Express) + Drizzle ORM + Postgres 16 + Redis 7 (BullMQ) + JWT.

- Concurrency guard: partial unique index `uq_appt_active_slot` on `appointments(doctor_id, start_time) WHERE status='scheduled'` + `INSERT ... ON CONFLICT DO NOTHING RETURNING` -> 409
- Slots computed on the fly via `generate_series` (schedule - blocks - booked)
- Waiting list: FIFO, 15-min offer expiry via sweep job, accept reuses booking guard
- Analytics in pure SQL; jobs retry-idempotent via deterministic `jobId`s + guarded `rowCount==1` claims

## Milestones

- [x] **1. Scaffold** — NestJS + Drizzle provider + docker-compose + Dockerfile + health check
- [x] **2. Schema & migrations** — users, schedules, blocked_slots, appointments, waiting_list, notifications + indexes + first migration
- [ ] **3. Auth** — register/login, JWT, PatientGuard/DoctorGuard, bcrypt
- [ ] **4. Doctor scheduling** — weekly schedule + block endpoints
- [ ] **5. Slot availability** — `GET /doctors/:id/slots?from&to` query
- [ ] **6. Booking + concurrency guard** — book/cancel, 2h cancel window, partial unique index proof
- [ ] **7. Reminder job** — BullMQ T-24h, deterministic jobId, cancel removes it
- [ ] **8. Waitlist** — join/leave/offer/accept/expiry + processing job
- [ ] **9. Analytics** — monthly SQL aggregates endpoint
- [ ] **10. Tests + seed** — unit/e2e, `npm run test:concurrency` (N=25 -> 1x201, 24x409), demo seed
- [ ] **11. README + polish** — setup, concurrency + alternatives, index rationale, waitlist assumptions, AI-usage section, future work

Each milestone lands as one or more focused commits (deliverable requires incremental history).
