# Architecture & Implementation Diagrams

Mermaid diagrams for the core implementations. These render on GitHub and in most
Mermaid-aware editors. Each diagram reflects the actual code paths.

- [System architecture](#system-architecture)
- [Data model (ER)](#data-model-er)
- [Slot availability](#slot-availability)
- [Booking + concurrency guard](#booking--concurrency-guard)
- [Doctor analytics (pure SQL)](#doctor-analytics-pure-sql)
- [Waiting-list lifecycle](#waiting-list-lifecycle)
- [Reminder background job (idempotency)](#reminder-background-job-idempotency)

---

## System architecture

```mermaid
flowchart LR
    subgraph Clients
        B["Browser / Bruno / scripts"]
    end

    subgraph Edge
        LB["nginx load balancer\n(round-robin, :8080)"]
    end

    subgraph API["API replicas (stateless)"]
        A1["api-1 :3000"]
        A2["api-2 :3000"]
    end

    subgraph Workers["BullMQ workers (reminders + waitlist)"]
        W1["RemindersProcessor"]
        W2["WaitlistProcessor"]
    end

    DB[("PostgreSQL 16\nshared, single source of truth")]
    RD[("Redis 7\nshared broker")]

    B --> LB
    LB --> A1
    LB --> A2
    A1 --> DB
    A2 --> DB
    A1 --> RD
    A2 --> RD
    W1 --> DB
    W2 --> DB
    W1 --> RD
    W2 --> RD

    A1 -.enqueue.-> RD
    A2 -.enqueue.-> RD
    RD -.deliver jobs.-> W1
    RD -.deliver jobs.-> W2
```

No in-app locks: the double-booking shield lives in Postgres, so any number of
replicas stays correct. JWT is stateless; job state lives in Redis.

---

## Data model (ER)

```mermaid
erDiagram
    users ||--o{ schedules : "doctor has weekly recurring"
    users ||--o{ blocked_slots : "doctor blocks"
    users ||--o{ appointments : "as doctor"
    users ||--o{ appointments : "as patient"
    users ||--o{ waiting_list : "as patient"
    users ||--o{ notifications : "receives"

    users {
        serial id PK
        varchar email UK "uq_users_email"
        text password_hash
        varchar name
        user_role role
        int slot_duration_min
    }

    schedules {
        serial id PK
        int doctor_id FK
        int day_of_week
        time start_time
        time end_time
    }

    blocked_slots {
        serial id PK
        int doctor_id FK
        date block_date
        time start_time "NULL = full day"
        time end_time "NULL = full day"
    }

    appointments {
        serial id PK
        int doctor_id FK
        int patient_id FK
        timestamptz start_time
        timestamptz end_time
        appointment_status status
        timestamptz cancelled_at
    }

    waiting_list {
        serial id PK
        int doctor_id FK
        int patient_id FK
        timestamptz slot_start
        int position
        waitlist_status status
        timestamptz offered_at
        timestamptz offer_expires_at
    }

    notifications {
        serial id PK
        int user_id FK
        notification_type type
        jsonb payload
        timestamptz sent_at
    }
```

Key indexes (full rationale in `README.md`):

- `uq_appt_active_slot` partial unique on `appointments(doctor_id, start_time)
  WHERE status = 'scheduled'` — the concurrency guard.
- `idx_appointments_doctor_start` — availability anti-join + active-slot listing.
- `idx_appointments_patient_start` — "my appointments" + cancel lookups.
- `idx_blocked_slots_doctor_date`, `idx_schedules_doctor`, `idx_waiting_list_slot` —
  fast subtraction/lookup in availability, analytics, and queue claims.

---

## Slot availability

```mermaid
flowchart TD
    S["GET /doctors/:id/slots?from&to"] --> V{"doctor exists?"}
    V -- no --> E404["404 Not Found"]
    V -- yes --> LOAD["loadSlotSource (indexed range queries)"]
    LOAD --> SCH[(schedules)]
    LOAD --> BLK[(blocked_slots)]
    LOAD --> BOK[(appointments status = 'scheduled')]
    LOAD --> GEN["generateSlots() in JS"]

    SCH --> GEN
    BLK --> GEN
    BOK --> GEN

    GEN --> DAY{"next day in [from, to]"}
    DAY -- none left --> OUT["return available slots"]
    DAY -- yes --> ON{"dayOfWeek on weekly schedule?"}
    ON -- no --> NEXT["advance day"]
    ON -- yes --> FULL{"date fully blocked?"}
    FULL -- yes --> NEXT
    FULL -- no --> TILE["tile working hours at slot_duration steps"]
    TILE --> OLAP{"overlaps a partial block range?"}
    OLAP -- yes --> SKIP["exclude slot"]
    OLAP -- no --> TAKEN{"start in bookedStarts Set?"}
    TAKEN -- yes --> SKIP
    TAKEN -- no --> KEEP["emit {start, end} available"]
    SKIP --> NEXT
    KEEP --> NEXT
    NEXT --> DAY
```

Notes:

- Availability is computed on the fly (no materialized slot table).
- `bookedStarts` uniqueness is guaranteed by `uq_appt_active_slot`, so a simple
  `Set` exclusion is always correct.
- Booking *validation* calls `getSchedulableSlots` (bookings ignored) so a
  legit-but-taken slot flows to the INSERT guard and returns **409**, not 400.

---

## Booking + concurrency guard

```mermaid
flowchart TD
    BK["POST /appointments { doctorId, startTime }"] --> DR{"doctor exists?"}
    DR -- no --> N404["404 Not Found"]
    DR -- yes --> GRID["getSchedulableSlots (grid minus blocks)"]
    GRID --> RT{"slot on grid?"}
    RT -- no --> B400["400 Slot not available"]
    RT -- yes --> INS["INSERT INTO appointments\n... ON CONFLICT DO NOTHING RETURNING *"]
    INS --> ROW{"row returned?"}
    ROW -- no --> C409["409 Slot already taken"]
    ROW -- yes --> OK["201 Created"]
    OK --> RM["enqueue T-24h reminder\n(deterministic jobId)"]
    RM --> ERR{"enqueue failed?"}
    ERR -- yes --> LG["log error\n(booking still valid)"]
    ERR -- no --> DONE["done"]
```

The application-level grid check is **only a fast-fail for invalid slots**. Correctness
comes from the partial unique index applied at commit time in Postgres — under any
number of concurrent requests and replicas, exactly one `INSERT` returns a row; all
others conflict and return nothing ⇒ **409**.

---

## Doctor analytics (pure SQL)

```mermaid
flowchart TD
    A["GET /doctors/:id/analytics?month=YYYY-MM"] --> DV{"doctor exists?"}
    DV -- no --> A404["404 Not Found"]
    DV -- yes --> SQL["one SQL statement (no rows pulled into JS)"]

    subgraph SQL
        direction TB
        CTEB["booked CTE\nappointments where start_time in month"]
        CTES["scheduled CTE\ngenerate_series(days) x schedules - blocked_slots"]
        CTEB --> AGG["count total\ncount FILTER cancelled\nmode() peak booking hour\nsum booked minutes"]
        CTES --> AVAIL["sum available minutes"]
        AGG --> ROW0["single aggregated row"]
        AVAIL --> ROW0
    end

    ROW0 --> OUT2["total_appointments, cancellation_rate,\npeak_booking_hours, avg_utilization"]
```

- `total_appointments` = appointments whose slot falls in the month.
- `cancellation_rate` = `cancelled / total` (0 when none).
- `peak_booking_hours` = `mode() OVER extract(hour FROM start_time)`.
- `avg_utilization` = `booked_minutes / (scheduled_minutes − blocks)`.

All aggregation happens in Postgres; JavaScript only formats the returned row.

---

## Waiting-list lifecycle

```mermaid
flowchart TD
    subgraph Join
        J["POST /waiting-list"] --> JV{"slot bookable?"}
        JV -- no --> J400["400 / 409 duplicate"]
        JV -- yes --> JINS["insert waiting_list\nposition = max+1, status = waiting"]
    end

    subgraph Cancel["cancellation frees the slot"]
        C["DELETE /appointments/:id"] --> CW{">= 2h before start?"}
        CW -- no --> C422["422 Unprocessable"]
        CW -- yes --> CU["status = cancelled\nremove reminder job"]
        CU --> ENQ["enqueue waitlist job\n(deterministic jobId)"]
    end

    ENQ --> CLAIM["claimNext:\nguarded UPDATE ... rowCount == 1\n(FIFO by position, created_at)"]
    CLAIM --> RC{"rowCount == 1?"}
    RC -- no --> NOC["no candidate (still booked / none waiting)"]
    RC -- yes --> OFF["status = offered\noffer_expires_at = now + 15min\nwrite waitlist_offer notification"]

    OFF --> ACC["patient POST /waitlist/:id/accept"]
    ACC --> AV{"entry offered AND not expired?"}
    AV -- no --> A409["409 no active offer"]
    AV -- yes --> ATX["transaction:\nINSERT appointment ON CONFLICT DO NOTHING"]
    ATX --> AC{"created?"}
    AC -- yes --> ADONE["accepted + waitlist_confirmation notification"]
    AC -- no --> ABEAT["409 beaten by a direct booking\n(sweep will clean up)"]

    OFF --> SW["sweep job (every 5 min)"]
    SW --> SWV{"offer expired?"}
    SWV -- no --> SWN["nothing to do"]
    SWV -- yes --> SWX["status = expired\nclaimNext -> next FIFO candidate"]
    SWX --> CLAIM
```

- Offers are **FIFO**, valid **15 minutes**, then swept and the slot recurses.
- `claimNext`'s `UPDATE ... rowCount == 1` makes concurrent/retried jobs unable to
  double-offer the same slot.
- Accept reuses the booking INSERT guard, so a slot can never be assigned twice.

---

## Reminder background job (idempotency)

```mermaid
flowchart TD
    B["booking confirmed"] --> ENQ["enqueue send-reminder\njobId = reminder-{appointmentId}\ndelay = start - 24h"]
    ENQ --> P["RemindersProcessor"]
    P --> P1{"appointment still status = 'scheduled'?"}
    P1 -- no --> PSKIP["skip (cancelled / missing)"]
    P1 -- yes --> P2{"reminder row already exists?"}
    P2 -- yes --> PSKIP
    P2 -- no --> PINS["insert reminder notification row"]
    PINS --> PLOG["log [job] run"]

    C["cancel"] --> CR["remove job by deterministic jobId"]
    CR --> DEAD["reminder will not fire"]

    PSKIP --> PLOG
```

- The deterministic `jobId` means a re-enqueue or retry can never schedule a
  duplicate.
- On execution the job re-checks the appointment is still `scheduled` and that no
  reminder row exists yet — belt-and-suspenders so retries are side-effect free.
