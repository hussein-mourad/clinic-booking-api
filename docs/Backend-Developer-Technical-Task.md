# Backend Developer – Technical Task

NestJS + PostgreSQL | Estimated time: 1–2 days

Hi,

Thanks for your time so far. As the next step, we'd like you to work on a small but realistic project. It's designed to look like the kind of problem we actually deal with here, so treat it like real work, not a textbook exercise.

One important note before you start: you are free to use AI tools (ChatGPT, Copilot, Claude, whatever you prefer). We actually encourage it — we use them daily ourselves. What we care about is how you use them, and whether you truly understand and own every line you submit. More on that below.

# The Project: Clinic Appointment Booking API

Build a REST API for a medical clinic where patients book appointments with doctors.

## Core Requirements

- Doctors have weekly working schedules (e.g., Sunday–Thursday, 10:00–16:00) and a configurable slot duration (15 / 30 / 60 minutes). A doctor can also block specific dates or times (vacation, emergencies).
- Patients can list a doctor's available slots for a given date range, book a slot, and cancel a booking. Cancelling less than 2 hours before the appointment is not allowed.
- An endpoint that returns, for a given doctor and month: total appointments, cancellation rate, peak booking hours, and the average utilization of their schedule. This must be done in SQL (raw query or query builder) — not by loading rows into memory and computing in JavaScript.
- Basic auth (JWT is fine) with two roles: patient and doctor. Keep it simple — auth is not the focus of this task.

## Concurrency & Data Volume

The clinic runs several instances of the API behind a load balancer, and slots for popular doctors fill up fast, so keep the following in mind:

- Two patients booking the same slot at the same moment must never both succeed, even with many concurrent requests against multiple app instances. Handle this at the database level, and add a short note in your README about the approach you chose and the alternatives you considered.
- Include a script or test that fires concurrent booking requests at the same slot and shows exactly one success — we'll run it on our side.
- Available-slot listing should stay fast as data grows. Assume around 200 doctors and about 2 million appointment rows, and mention in the README which indexes you added and why.

## Waiting List

The clinic also wants a "waiting list": if a slot is taken, a patient can join a queue for it, and if the booking is cancelled the slot goes to someone from the queue. The details — priority order, notification, expiry, edge cases — are up to you. Make sensible decisions and document your assumptions in the README.

## Background Jobs

Some things shouldn't happen inside the request/response cycle. Use a job queue (BullMQ with Redis, or similar) for at least the following:

- Appointment reminders: when a booking is confirmed, schedule a reminder to be "sent" 24 hours before the appointment (logging it or writing to a notifications table is enough — no real email/SMS needed). If the booking is cancelled, the reminder must not fire.
- Waiting-list processing: when a booking is cancelled, hand the slot reassignment to a background job rather than doing it inline.
- Jobs will fail sometimes (Redis hiccup, worker restart). Make sure a failed job can retry safely without side effects like double reminders or assigning the same slot twice.

# About AI Usage

As mentioned, AI tools are allowed and encouraged. Two conditions:

- Add a short section in your README (10–15 lines is enough) describing how you used AI: what you asked it to do, where it helped, and anything it got wrong that you had to fix. "I didn't use AI" is also a valid answer — just be honest about it.
- After you submit, we'll schedule a 45-minute call to walk through the code together, discuss your decisions, and maybe tweak a couple of things live.

# Deliverables

- A Git repository (GitHub/GitLab) with a meaningful commit history — please don't squash everything into one commit; we like seeing how you work.
- README with: setup steps, your approach to the concurrency problem, index explanations, waiting-list assumptions, and the AI usage section.
- Database migrations (no `synchronize: true` in production config).
- The concurrency proof script/test, plus reasonable test coverage on the booking logic. We don't need 100% coverage — test what matters.
- docker-compose file (app + Postgres + Redis) so we can run everything with one command.
- A short screen recording (5–10 minutes, no editing needed — Loom or any tool is fine): run the project, demo the booking flow and the concurrency test, show a waiting-list scenario end to end, and briefly explain one design decision you're happy with. Talking over the screen is enough; you don't need to appear on camera.

# Timeline & Questions

Please send us the repository link within 4 days of receiving this. The task itself should take one to two focused days — no need to go beyond that; ship what you have and note in the README what you'd do with more time.

If anything is unclear, just reply and ask — happy to clarify.

Good luck, and have fun with it.
