# Product Requirements Document: Clinic Appointment Booking API

**Document type:** PRD
**Stack:** NestJS + PostgreSQL + Redis (BullMQ)
**Estimated build time:** 1–2 focused days
**Status:** Draft — for technical assessment

---

## 1. Overview

### 1.1 Summary
A REST API that allows patients to book appointments with doctors at a medical clinic. Doctors define recurring weekly availability and can block out specific dates/times. Patients search for open slots, book them, and cancel them under defined rules. The system must remain correct and fast under concurrent load across multiple API instances, support a waiting list for fully booked slots, and offload non-critical work (reminders, waitlist reassignment) to background jobs.

### 1.2 Problem Statement
Manual or naive booking systems break down under two real-world pressures:
- **Concurrency:** popular doctors' slots can be requested by multiple patients at the exact same moment, across multiple load-balanced app instances. Without proper handling, double-bookings occur.
- **Scale:** as appointment history grows (target: ~200 doctors, ~2M appointment rows), slot-availability queries must stay fast.

### 1.3 Goals
- Prevent double-booking of a single slot under concurrent, multi-instance load.
- Keep slot-lookup performant at scale via proper indexing.
- Give patients a fallback (waiting list) when a desired slot is full.
- Move non-critical, delay-tolerant work off the request/response path via a job queue.
- Produce a codebase that is understandable, tested where it matters, and documented.

### 1.4 Non-Goals
- Production-grade authentication/authorization (JWT with two simple roles is sufficient; no SSO, password reset flow, etc.)
- Real email/SMS delivery (logging or a notifications table stands in for actual sending).
- 100% test coverage — only booking-critical logic needs solid coverage.
- Building an admin UI or patient-facing frontend.

---

## 2. Users & Roles

| Role | Description | Key actions |
|---|---|---|
| **Patient** | End user booking appointments | View available slots, book a slot, cancel a booking, join/leave a waiting list |
| **Doctor** | Clinic practitioner | Define weekly working schedule, set slot duration, block specific dates/times |

Auth is JWT-based and role-aware, but intentionally minimal — auth is not the focus of the assessment.

---

## 3. Functional Requirements

### 3.1 Doctor Scheduling
- A doctor has a **weekly recurring schedule** (e.g., Sunday–Thursday, 10:00–16:00).
- A doctor has a **configurable slot duration**: 15, 30, or 60 minutes.
- A doctor can **block specific dates or time ranges** (vacation, emergencies) which override the recurring schedule.

### 3.2 Slot Availability
- Patients can **list a doctor's available slots** for a given date range.
- Available slots are computed from: weekly schedule − blocked dates/times − already-booked slots.

### 3.3 Booking
- A patient can **book an available slot**.
- A patient can **cancel a booking**, except when the appointment starts in **less than 2 hours**, in which case cancellation is rejected.

### 3.4 Doctor Analytics Endpoint
For a given doctor and month, return:
- Total appointments
- Cancellation rate
- Peak booking hours
- Average schedule utilization

**Constraint:** must be computed via SQL (raw query or query builder) — not by pulling rows into application memory and aggregating in JavaScript.

### 3.5 Waiting List
- If a slot is taken, a patient may **join a queue** for that slot.
- If the booking on that slot is **cancelled**, the slot is offered to someone from the queue.
- Queue ordering, notification method, expiry of an offer, and edge-case handling are left to the implementer's discretion — but assumptions must be documented.

### 3.6 Background Jobs (BullMQ + Redis or equivalent)
- **Reminders:** on booking confirmation, schedule a reminder job for T-24h before the appointment. If the booking is later cancelled, the reminder must not fire.
- **Waiting-list processing:** slot reassignment after a cancellation happens in a background job, not inline in the cancellation request.
- **Reliability:** jobs must be safely retryable — a retry must not cause duplicate reminders or double-assign a slot to two people.

---

## 4. Non-Functional Requirements

### 4.1 Concurrency Safety
- Two simultaneous booking requests for the same slot — even across different app instances behind a load balancer — must never both succeed.
- Enforcement must happen at the **database level** (not in-app locks, since the app is horizontally scaled).
- README must document the chosen approach (e.g., unique constraint, `SELECT ... FOR UPDATE`, advisory locks) and alternatives considered.

### 4.2 Performance at Scale
- Design must remain performant assuming **~200 doctors** and **~2,000,000 appointment rows**.
- Appropriate indexes must be added for slot-availability queries; README must explain which indexes and why.

### 4.3 Reliability
- Background job failures (Redis hiccup, worker restart) must be recoverable via retry without side effects (no duplicate reminders, no double slot assignment).

### 4.4 Data Integrity
- No `synchronize: true` in production configuration — schema changes go through migrations.

---

## 5. Technical Requirements

- **Framework:** NestJS
- **Database:** PostgreSQL, with migrations (no auto-sync in prod)
- **Job Queue:** BullMQ + Redis (or equivalent)
- **Auth:** JWT, two roles (patient, doctor)
- **Infrastructure:** `docker-compose` bringing up app + Postgres + Redis with a single command
- **Testing:** Automated concurrency-proof test/script showing exactly one success out of N simultaneous booking attempts on the same slot, plus reasonable coverage of booking logic

---

## 6. Deliverables

1. Git repository (GitHub/GitLab) with meaningful, incremental commit history (no single squashed commit).
2. README covering:
   - Setup steps
   - Concurrency approach + alternatives considered
   - Index choices and rationale
   - Waiting-list assumptions/design decisions
   - AI usage section (10–15 lines: what was asked of AI tools, where it helped, what it got wrong and how it was fixed — or an honest "didn't use AI")
3. Database migrations.
4. Concurrency proof script/test + reasonable test coverage on booking logic.
5. `docker-compose.yml` (app + Postgres + Redis).
6. Screen recording (5–10 minutes, unedited is fine) covering:
   - Running the project
   - Booking flow demo
   - Concurrency test demo
   - End-to-end waiting-list scenario
   - Brief explanation of one design decision the candidate is happy with

---

## 7. Constraints & Policies

- **AI tool usage is explicitly allowed and encouraged** (ChatGPT, Copilot, Claude, etc.). Evaluation focuses on how AI was used and whether the candidate understands and owns every submitted line.
- A 45-minute follow-up call will walk through the code, decisions, and possibly involve small live changes.

---

## 8. Timeline

- **Submission deadline:** repository link due within 4 days of receiving the task.
- **Effort expectation:** 1–2 focused days of work. Candidates should stop at that point and note in the README what they'd do with more time, rather than over-investing.

---

## 9. Open Questions / Areas Left to Candidate Judgment

- Waiting-list priority order (FIFO vs. other criteria)
- Waiting-list notification mechanism
- Waiting-list offer expiry window and what happens if it lapses
- Exact concurrency-control mechanism (must be justified in README)
- Exact indexing strategy (must be justified in README)

---

## 10. Success Criteria (Evaluation Lens)

- Slot double-booking is provably impossible under concurrent load (demonstrated by script + explained in README).
- Query for doctor monthly analytics is done in SQL, not in-memory JS aggregation.
- Slot listing remains performant under the stated data-volume assumptions, with justified indexes.
- Reminders and waiting-list reassignment run as background jobs, are idempotent/retry-safe.
- Codebase is migration-based, dockerized, reasonably tested, and clearly documented.
- Commit history reflects real incremental work, not a single dump.
