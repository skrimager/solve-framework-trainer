# SOLVE Framework Trainer

Discovery-training platform: trainees practice live role-play scenarios with
realistic customers, every session is scored and tracked, and reps work toward
certification. Express + Drizzle (Postgres) API, React (Vite) client.

## Development

```bash
npm install
npm run dev      # NODE_ENV=development tsx server/index.ts
npm run check    # tsc typecheck
npm test         # node:test suite (server/*.test.ts)
```

Database migrations live in `migrations/` and run automatically on boot
(`runMigrations()` in `server/migrate.ts`).

## Opportunity Intelligence (admin-only)

An admin-only outbound lead-gen and email-drip system for SOLVE Framework's own
marketing, in the Vault admin area at `/admin/opportunities` (behind the
existing admin session — same auth as the rest of `/admin`). It is **not** a
trainee-facing feature.

A "batch" is one weekly discovery run for a market segment + geography (first
test market: Phoenix, AZ). Each batch holds companies, their contacts, and a
drafted three-step discovery-training email drip per contact. An admin reviews a
batch, then **approves** it (which schedules the drip) or **rejects** it.

### How new discovery batches get created

Discovery itself runs **externally / out-of-band** — the parent agent runs
Perplexity/Apollo/SimilarWeb connectors that are not available inside the
deployed app — so batches are **inserted via a JSON payload**, not generated
live by the server.

Post the results of a discovery run to:

```
POST /api/admin/opportunities/batches
Cookie: solve_admin_session=<admin session>
Content-Type: application/json
```

```jsonc
{
  "segment": "Manufactured Housing",   // free text; drives the email angle
  "geography": "Phoenix, AZ",          // free text
  "runAt": "2026-07-10T00:00:00.000Z", // optional; defaults to now
  "companies": [
    {
      "name": "Acme Communities",
      "domain": "acme.com",            // optional
      "city": "Phoenix",               // optional
      "state": "AZ",                   // optional
      "employeeCount": 45,             // optional
      "signalType": "hiring",          // e.g. hiring | growth | news
      "signalDetail": "Hiring 3 community managers",
      "source": "apollo",              // e.g. apollo | similarweb
      "status": "new",                 // optional; defaults to "new"
      "contacts": [
        {
          "fullName": "Dana Smith",
          "title": "Owner",
          "email": "dana@acme.com",
          "phone": "",                 // optional
          "linkedinUrl": "",           // optional
          "emails": []                 // optional; see below
        }
      ]
    }
  ]
}
```

The batch is created with status `pending_review` and every drafted email starts
as `draft` (nothing is scheduled or sent on insert).

By default the server generates each contact's three-step drip from the
segment-specific templates in `server/opportunities.ts` (`buildSequence`). The
segment string is normalized (`normalizeSegment`) onto a canonical angle:

| Segment keywords | Angle |
| --- | --- |
| manufactured / housing / mobile home | Resident-facing team consistency and de-escalation |
| hvac / plumbing / home service | Diagnosing the homeowner's real frustration, not just the repair |
| auto / dealer | Moving off the pressure-close toward discovery |
| mortgage / lending / loan / bank | Discovery over pressure on a major financial decision |
| rental / equipment | B2B discovery — uncover the job behind the request |
| conflict / customer service / grievance | De-escalation and root-cause discovery |
| *(anything else)* | General discovery-training angle |

Every generated email mentions live role-play scenarios, scoring/tracking, the
path to certification, and a free-demo CTA, and uses "discovery training"
language (never "sales" or "AI roleplay"). To override the generated copy for a
contact, supply an explicit `emails` array of `{ step, subject, body }` objects.

### Approving a batch (scheduling)

`POST /api/admin/opportunities/searches/:id/approve` (admin) flips the batch to
`approved` and schedules its draft outreach:

- **Step 1** → `scheduled` for **now**
- **Step 2** → `scheduled` for **now + 3 days**
- **Step 3** → `scheduled` for **now + 7 days**

`POST /api/admin/opportunities/searches/:id/reject` flips the batch to
`rejected`; its outreach stays `draft` and is never sent.

### The drip sender

A background job (`startOutreachScheduler`, started once from `registerRoutes`)
wakes every ~20 minutes and sends any `scheduled` outreach whose `scheduledAt`
has passed, via the existing Resend transport (`sendProspectEmail`, reusing
`RESEND_API_KEY` — no new key). On a real 2xx the row is set to `sent` with
`sentAt = now` and a `sent` activity row is logged; a failed send leaves the row
`scheduled` for the next tick, so a message is never resent and never lost.

To trigger a send manually (or from an external platform scheduler instead of
the in-process interval): `POST /api/admin/opportunities/run-drip` (admin).
