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
| Customers | list, detail, edit, activities, files; lead conversion | One per new lead, created in the same statement as the lead (`customers.lead_id` is unique), owned by the lead's owner, `CU-00001` codes from a sequence. Leads from before that change convert with **Win**. Deactivated, never deleted |
| Dashboard | summary | KPIs and distributions from live data |
| Notifications | feed + unread count | Nothing creates notifications yet |
| Settings | lead sources, lead statuses (add, rename, remove) | In-use sources are deactivated, in-use statuses cannot be deleted |

**Record visibility.** Every page permission gates its endpoints on the server. Users whose role lacks **All records** see only leads they own, follow-ups assigned to them and customers assigned to them. The dashboard follows the same rule. Records outside that scope answer 404.

### Blocked, waiting on business decisions

| Feature | Blocked by |
| --- | --- |
| Courier rate calculator (quotes, history, rate charts) | Real rate sheets, tariff formula and worked examples (report Q21, Q22). Mock prices are not used |
| Lead attachments | Object-storage bucket and credentials, allowed file types and size (Q9) |
| **Disqualify** | Q1, Q2, Q3 |
| Notification triggers and mark-as-read; reminder delivery | Q18, Q19 |
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
   - **Direct** (same host without `-pooler`) → `DIRECT_URL`. Prisma Migrate, the seed and `create-admin` need it, because migrations take an advisory lock that PgBouncer cannot hold.
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
- **Dashboard:** exact aggregates.
- **Settings.**
- **Database:** CHECK, foreign-key and unique constraints.

## Deploying

- Set every variable from `.env.example` in the host's environment. Leave out `TEST_DATABASE_URL`.
- Run `npm run build`, then `npm run db:deploy` as a release step, then `npm start`.
- The frontend reaches the API through a Next.js rewrite of `/api/*`, so the browser sees one origin and the session cookie is first-party. No CORS is enabled.
  - Set `FRONTEND_ORIGIN` to the site's exact origin.
  - Set `TRUST_PROXY` so rate limits see real client IPs.
  - Cookies are `Secure` when `NODE_ENV=production`, which requires HTTPS.
- Rate limits are kept in process memory. Add a shared store before running more than one instance.
- Backups: enable Neon point-in-time restore on the production branch and rehearse a restore before launch.

## Security notes

- **Passwords:** Argon2id (`@node-rs/argon2`).
- **Session ids, reset tokens and OTPs:** stored only as hashes. OTPs use an HMAC keyed by `SESSION_SECRET`. A new login rotates the session.
- **Session revocation:** logout, password reset and deactivation end sessions. Role and permission changes apply on the user's next request.
- **Request validation:** bodies use strict Zod schemas, so unknown fields are rejected (`422`). Errors use one shape, `{ "error": { "code", "message", "fields?" } }`, with no stack traces or SQL.
- **CSRF:** `SameSite=Lax` cookie plus an `Origin` check on every state-changing request.
- **Logging:** structured pino logs with an `X-Request-Id`. Cookies are redacted, and OTPs, tokens and passwords are never logged.
- **Audit:** an append-only `audit_logs` table records logins (and failures), password resets, user and role changes, lead deletes and assignments, customer deletes, and settings changes.
