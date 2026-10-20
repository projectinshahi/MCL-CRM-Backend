# MCL CRM Backend

REST API for the MCL CRM frontend (`MCL-CRM-Frontend`). Node.js 22 · Express 5 · TypeScript · Prisma 7 · Neon PostgreSQL · Zod.
Built from the *MCL CRM — Backend Requirements Report*; see [docs/API.md](docs/API.md) for every endpoint.

## What is implemented

| Area | Endpoints | Notes |
| --- | --- | --- |
| Auth | login, logout, me, forgot-password, verify-otp, reset-password | Server-side sessions (hashed ids in PostgreSQL, `HttpOnly` cookie). Forgot password = emailed 6-digit OTP → verify → new password |
| Users | list, create, edit, delete, assignee options | Admin sets the first password. Last-admin and self-protection guards |
| Roles | list, create, edit, delete, permission catalogue | 9 permissions: 8 pages + **All records** |
| Leads | list, create, detail, edit, delete, pipeline, assign, activity, reminders | Server pagination, search, filters, optimistic locking, soft delete, activity log. A new lead needs a contact or company name: its customer is created with it |
| Follow-ups | list, create, edit, delete, complete, history, lead/contact lookup | Overdue derived from the Asia/Kolkata date, never stored. Delete is permanent; the lead's activity and the audit log keep a copy |
| Customers | list, detail, edit, activities, files; lead conversion | One per new lead, created in the same statement as the lead (`customers.lead_id` is unique), owned by the lead's owner (and moved with the lead when it is reassigned, unless the customer was given to someone else), `CU-00001` codes from a sequence. Leads from before that change convert with **Win**. Deactivated, never deleted |
| Dashboard | summary | KPIs and distributions from live data |
| Notifications | feed, unread count, mark read, remove, clear all | Made by the API after a change is saved, and by due-date reminders. See **Notifications** below |
| Settings | lead sources, lead statuses (add, rename, remove) | In-use sources are deactivated, in-use statuses cannot be deleted |

**Record visibility.** Every page permission gates its endpoints on the server. Users whose role lacks **All records** see only leads they own, follow-ups assigned to them and customers assigned to them. The dashboard follows the same rule. Records outside that scope answer 404.

### Notifications

One row per recipient, so reading, removing or clearing is per person. Any active user can receive them, and nobody is told about their own action. They are stored whether or not the recipient's role has the **Notifications** page; that permission only controls who may read them. So someone assigned a lead before their role had the page still sees it once the role gets it.

| Event | Administrators | The record's people |
| --- | --- | --- |
| Lead created (with its customer) | ✓ | owner, if someone else created it |
| Lead stage moved | ✓ | owner |
| Lead reassigned | ✓ | new owner ("assigned to you") |
| Lead edited / deleted / converted | deleted, converted | owner |
| Customer reassigned / deactivated / reactivated / edited | reassigned, (de)activated | assignee (a new one: "assigned to you") |
| Follow-up created / edited / completed / deleted | ✓ | assignee |
| Follow-up due tomorrow / due today | | assignee |
| Follow-up overdue (the day after, still pending) | ✓ | assignee |
| Lead reminder falls due | | whoever scheduled it, and the lead's owner |
| User added | ✓ ("User added: <name>", with the role) | every other active user ("New team member", with the name); not the new user |
| User updated / role changed / deactivated / removed; role created / permissions changed / renamed / deleted | ✓ | |

- **Administrators** are active users whose role has **Users**, the same rule as the last-admin guard. They hear of these events whoever's record it is.
- **What each reader sees** is decided when they read it, not when it was made. A notification carries the record's name and a link only when its reader may open that record now (its page permission, plus **All records** or being its current owner or assignee). Anyone else gets the event alone, for example "New lead" or "Customer deactivated", with no name and no link. So a later permission grant shows the full notification, someone who loses a record loses its name, and receiving a notification never grants access. The list reads each notification's record in the same query.
  - A record that was deleted, or no longer exists, shows the event alone.
  - A notification about a deletion is written in full at that moment, for what its recipient could open then.
- **When.** Notifications are saved after the change has succeeded, in the background, so no request waits for them. A failed or refused change notifies nobody. Saving makes up to three attempts. Each notification is keyed by its event (`dedupe_key`, unique per user), so retries, repeated reminder runs or a second API instance never notify anyone twice. Saving a form without changing anything notifies nobody. The log records each event's key and how many people were told, so you can see when nobody qualified.
- **Reminders** run in the API at startup, then every 15 minutes, and wake early for a lead reminder that is due sooner. They use the India calendar day (Asia/Kolkata):
  - a follow-up gets "due tomorrow" the day before and "due today" on the day;
  - from the day after, while it is still pending, it gets "overdue";
  - a missed run skips a stage instead of sending it late;
  - reminders are worked out from the current data, so a moved due date is reminded about anew and a completed or deleted follow-up is never reminded;
  - overdue follow-ups and lead reminders look back 7 days only, so a first run sends no backlog.
- **There are no expiry dates in the data model** (contracts, documents, subscriptions and so on), so there are no expiry reminders. Follow-up due dates and lead reminders are the deadlines it has. A future expiry field would plug into `src/modules/notifications/reminders.ts` in the same way.
- **Clearing.** Removing a notification sets `deleted_at`. Cleared rows are purged after 30 days, and are kept until then so that a cleared reminder is not created again. **Clear all** removes notifications only up to the newest one the page showed, so one that arrives meanwhile is not lost unseen.
- **In the browser**, the bell asks for the unread count:
  - every 30 seconds, one request at a time;
  - at once when the tab is shown or focused, on every page change, and after the user's own changes.

  A changed answer refreshes the open list. The sound is synthesised by the browser (no audio file), plays once per arrival in one tab only, and is switched on by the first click, tap or key press, the sign-in included.
- **Rate limits.** The frontend's `/api` rewrite adds no client address, so every request reaches the API from the Next server. Signed-in users therefore each get their own 300 requests a minute, and count towards nothing shared. Requests without a session share 300 a minute per address, under a 3000 a minute ceiling; sign-in also locks an account for 15 minutes after 10 wrong passwords.
  - Behind the bare rewrite, "per address" means one address for everyone. `TRUST_PROXY` defaults to `false` because Next passes on whatever `X-Forwarded-For` the browser sent: trusting it would let anyone pick a new address to escape the login and password-reset limits.
  - Set `TRUST_PROXY` only for a proxy you run in front of the API that overwrites that header (see Deploying).

### Blocked, waiting on business decisions

| Feature | Blocked by |
| --- | --- |
| Courier rate calculator (quotes, history, rate charts) | Real rate sheets, tariff formula and worked examples (report Q21, Q22). Mock prices are not used |
| Lead attachments | Object-storage bucket and credentials, allowed file types and size (Q9) |
| **Disqualify** | Q1, Q2, Q3 |
| Meaning of "Next Follow Up Date" (stored, no behaviour) | Q17 |
| Exports (Report / Download buttons) | Q23 |

Provisional choices that need sign-off: dashboard KPI definitions (`src/modules/dashboard/routes.ts`), session lengths of 12 hours (30 days with "remember me"), password minimum of 8 characters, and that a new lead or follow-up defaults to the creator as owner or assignee.

## Setup

Requires Node.js 22.12+ and npm.

```bash
npm install
cp .env.example .env    # then fill it in (see below)
npm run db:generate
```

### Neon

1. Create a Neon project. Keep **one branch for the app** (e.g. `dev`, later `main` for production) and **a separate branch for tests**.
2. From the app branch's **Connect** dialog copy two strings:
   - **Pooled** (host contains `-pooler`) → `DATABASE_URL`. The running API uses it.
   - **Direct** (same host without `-pooler`) → `DIRECT_URL` (or `DATABASE_UNPOOLED_URL`, Neon's name for it). Prisma Migrate, the seed and `create-admin` need it, because migrations take an advisory lock that PgBouncer cannot hold.
3. Use `sslmode=verify-full`. TLS is required either way.
4. Put the test branch's pooled URL in `TEST_DATABASE_URL`. Tests derive its direct URL by dropping `-pooler`, or read `TEST_DIRECT_URL`.

### Database

```bash
npm run db:deploy       # apply migrations (prisma migrate deploy, uses DIRECT_URL)
npm run db:seed         # permissions, lead sources, lead statuses, Admin role — safe to re-run
ADMIN_NAME="Your Name" ADMIN_EMAIL=you@company.com ADMIN_PASSWORD='at-least-12-chars' npm run create-admin
```

`create-admin` refuses to run once an active administrator exists. There is no public sign-up. Every later user is created from the Users screen, with the admin setting their password.

While changing the schema locally, use `npm run db:migrate` (`prisma migrate dev`) against a development branch only.

## Run

```bash
npm run dev             # tsx watch, http://localhost:4000
npm run build && npm start
```

Health checks: `GET /healthz` (process up) and `GET /readyz` (database reachable, 503 otherwise).

### With the frontend

The Next.js app (`MCL-CRM-Frontend`) forwards `/api/*` to this API via a rewrite in its `next.config.ts`. The target is `API_URL`, default `http://localhost:4000`.

1. Start this API (`npm run dev`, port 4000). Make sure `FRONTEND_ORIGIN` lists the address the frontend runs on, e.g. `http://localhost:3000,http://localhost:3001` (`next dev` moves to 3001 when another app holds 3000; sign-in from an unlisted address fails with 403 ORIGIN_REJECTED).
2. Start the frontend (`npm run dev`, port 3000).
3. Open `http://localhost:3000`. Without a session cookie, `proxy.ts` sends you to `/login`.

The frontend has no mock data left for leads, follow-ups, customers, users, roles, settings, dashboard or notifications. The calculator and Modules screens remain static until their requirements are decided.

## Tests

```bash
npm test
```

- **Unit tests** always run.
- **Integration tests** (Supertest against a real database) run when `TEST_DATABASE_URL` is set, in `.env.test`, `.env` or the environment.
  - Global setup applies all migrations first.
  - **Every table in that database is truncated on each run.** Never point it at real data. The suite refuses to run if it equals `DATABASE_URL` or `DIRECT_URL` in `.env`.
  - For a local throwaway database: run `npx prisma dev --name mcl-tests --detach`. Put the TCP URL it prints into `.env.test` as `TEST_DATABASE_URL`, using `127.0.0.1` rather than `localhost`. The suite then uses a pool of one connection, which that embedded server needs.

What the tests cover:

- **Permissions:** a permission matrix covering every protected endpoint (401 anonymous, 403 without the permission, allowed with it).
- **Record scope:** another user's lead, follow-up or customer returns 404.
- **Auth:** sessions and OTP reset.
- **User and role safety.**
- **Leads:** CRUD, pagination, locking, assignment and pipeline.
- **Follow-ups:** overdue derivation and completion.
- **Notifications:**
  - who is told what, including generic messages for readers who can't open the record;
  - retries and failures notify nobody;
  - reminder stages, India midnight, moved dates, the backlog limit and lead reminders, with repeated runs creating no duplicates;
  - read, remove and clear all, where another user's ids answer 404.
- **Dashboard:** exact aggregates.
- **Settings.**
- **Database:** CHECK, foreign-key and unique constraints.

## Deploying

The hosting platform isn't chosen yet; this works on any of them. Three parts, each with its own settings:

| Part | Runs | Configure (in the host's settings, never a committed file) |
|---|---|---|
| **API** (this repo) | an always-on Node.js 22.12+ process: `npm start` | `DATABASE_URL`, `FRONTEND_ORIGIN`, `SESSION_SECRET`; optionally `SMTP_URL` + `EMAIL_FROM`, the three `CLOUDINARY_*`, `CLOUDINARY_FOLDER`, `TRUST_PROXY`, `LOG_LEVEL`, `DATABASE_POOL_MAX`, `DEFAULT_PHONE_COUNTRY`. `PORT` usually comes from the host. |
| **Release step** (migrations) | once per release, before the new API starts | `DIRECT_URL` (or `DATABASE_UNPOOLED_URL`): the direct Neon endpoint |
| **Frontend** (`MCL-CRM-Frontend`) | `next build` / `next start`, or Vercel | `API_URL` at **build** time (see its README) |

Why always-on: due-date reminders run on a timer inside the API (every 15 minutes, sooner for lead reminders). An
instance that sleeps, or serverless functions, would deliver them late or not at all.

### Release procedure

```bash
npm ci                  # dev dependencies too: the build and migrations use the prisma CLI and TypeScript
npm run build           # prisma generate + tsc → dist/
npm run db:deploy       # prisma migrate deploy: applies pending migrations only, never resets; needs DIRECT_URL
npm start               # node dist/server.js — runs as production unless NODE_ENV says otherwise
```

- Run `db:deploy` as an explicit release step, after a backup point, and only once its migrations have been checked
  against a copy of the data. Never run `prisma migrate dev`, `migrate reset` or `db:seed` against production data
  (`db:seed` only adds missing reference rows, but has no reason to run there).
- A fresh, empty database needs `npm run db:seed` once and then the first administrator:
  `ADMIN_NAME=… ADMIN_EMAIL=… ADMIN_PASSWORD='…' npm run create-admin` (given on the command line, never stored).
- Health checks: `GET /healthz` (process up) for liveness, `GET /readyz` (database reachable, 503 otherwise) for
  readiness. Neither needs a session; `/readyz` runs one query, so poll it sparingly to let Neon's compute suspend.
- Startup refuses to run with a missing or invalid setting and names each one (never its value). In production it
  also refuses a plain-http `FRONTEND_ORIGIN` other than localhost, and the test suite's `SESSION_SECRET`. It warns
  (by name) when email or file storage is off.
- Logs are JSON lines on stdout (pino) with an `X-Request-Id`; cookies are redacted. On SIGTERM the API stops
  accepting requests, lets in-flight ones finish (up to 10 s), saves pending notifications and closes the database.

### Settings that matter in production

- **HTTPS.** Session cookies are `Secure` in production, so the site must be served over https. The browser only talks
  to the frontend; its `/api/*` rewrite forwards to `API_URL`, so the cookie is first-party and no CORS is enabled.
- **`FRONTEND_ORIGIN`**: the site's exact public origin, e.g. `https://crm.example.com`.
- **`SESSION_SECRET`**: a new random value for production (it keys password-reset codes; changing it later only
  voids codes already sent, not sessions).
- **`TRUST_PROXY`**: leave `false` unless a proxy you control sits in front of the API and overwrites
  `X-Forwarded-For`. Per-address rate limits then see the Next server, not each visitor; per-user limits and the
  per-account sign-in lock are unaffected.
- **One instance.** Rate-limit counters live in process memory: add a shared store (e.g. Redis) before running more
  than one API instance. Reminders and notifications are safe with several (the database refuses duplicates).
- **Database.** `DATABASE_URL` is Neon's pooled endpoint; `DIRECT_URL` is only for the release step. Enable Neon
  point-in-time restore on the production branch and rehearse a restore before launch.
- **Files.** Cloudinary keeps uploads private; give each environment its own `CLOUDINARY_FOLDER`.
- **Email.** Without `SMTP_URL` + `EMAIL_FROM`, Forgot password says it isn't set up and administrators reset
  passwords in Users. The sending domain needs SPF/DKIM set up with the email provider.

## Security notes

- **Passwords:** Argon2id (`@node-rs/argon2`).
- **Session ids, reset tokens and OTPs:** stored only as hashes. OTPs use an HMAC keyed by `SESSION_SECRET`. A new login rotates the session.
- **Session revocation:** logout, password reset and deactivation end sessions. Role and permission changes apply on the user's next request.
- **Request validation:** bodies use strict Zod schemas, so unknown fields are rejected (`422`). Errors use one shape, `{ "error": { "code", "message", "fields?" } }`, with no stack traces or SQL.
- **CSRF:** `SameSite=Lax` cookie plus an `Origin` check on every state-changing request.
- **Logging:** structured pino logs with an `X-Request-Id`. Cookies are redacted, and OTPs, tokens and passwords are never logged.
- **Audit:** an append-only `audit_logs` table records logins (and failures), password resets, user and role changes, lead deletes and assignments, customer deletes, and settings changes.
