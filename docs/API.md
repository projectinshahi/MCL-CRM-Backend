# MCL CRM API — v1

Base path `/api/v1`. JSON in and out. Implements the report's section 7 contract, with the changes noted below.

## Conventions

- **Auth.** The `mcl_session` cookie, set by `POST /auth/login`, is `HttpOnly` and `SameSite=Lax`. It is `Secure` in production.
- **CSRF.** Every `POST`, `PATCH` and `DELETE` must carry `Origin: <FRONTEND_ORIGIN>`, or it gets 403 `ORIGIN_REJECTED`.
- **Ids, dates and money:**
  - Ids are UUIDs.
  - Timestamps are ISO 8601 UTC. Date-only fields are `YYYY-MM-DD`.
  - Money is a JSON number of rupees with up to 2 decimals, for example `249000.55`. Requests may send it as a number or a numeric string.
  - The `₹` and Indian digit grouping are added by the frontend.
- **Lists** return `{ "items": [...], "page": 1, "pageSize": 20, "total": 200 }`. Query `page` defaults to 1, `pageSize` to 20, max 100.
- **Errors** return `{ "error": { "code": "VALIDATION_FAILED", "message": "...", "fields": { "email": "Invalid email" } } }`.
- **Status codes:**
  - 400 malformed or invalid token/OTP
  - 401 not signed in
  - 403 missing permission or bad origin
  - 404 not found, or outside your scope
  - 409 conflict
  - 413 body too large
  - 422 validation
  - 429 rate limited
  - 500 server error
- **Strict bodies.** Unknown fields are rejected with 422. Blank strings in optional fields are stored as `null`.
- **Phone numbers** (`phone`, `contact.phone`) are checked against the international numbering plan (libphonenumber-js,
  full metadata) and stored and returned as E.164, e.g. `"+919876543210"`. Send `"+<code> <number>"`; digits without `+`
  are read as numbers of `DEFAULT_PHONE_COUNTRY` (India by default). Field messages: "This number appears incomplete.",
  "Please check the country code and number.", "Enter a valid phone number for the selected country.", "Enter the number
  without an extension." (E.164 has no extensions; they are refused, never dropped). On PATCH, leave
  `phone` out to keep the stored value. Values saved before this check (any format) are returned unchanged until edited.
- **Scope.** Without the `all_records` permission, a user sees only their own records: leads they own, and follow-ups and customers assigned to them.

Permission codes:

- `dashboard`
- `leads`
- `customers`
- `follow_ups`
- `users`
- `notifications`
- `calculator`
- `settings`
- `all_records`

## Auth

| Method | Path | Access | Body → response |
| --- | --- | --- | --- |
| POST | `/auth/login` | public, 5/min per IP+email | `{ email, password, remember? }` → `{ user }` + cookie (30 days if `remember`, else 12 h browser-session cookie). 401 `INVALID_CREDENTIALS`, 403 `ACCOUNT_INACTIVE` |
| POST | `/auth/logout` | signed in | → 204, session revoked |
| GET | `/auth/me` | signed in | → `{ user: { id, name, email, phone, initials, role{id,name}, permissions[] } }` |
| POST | `/auth/forgot-password` | public, rate-limited | `{ email }` → 202 always. Active accounts get a 6-digit code by email: valid 10 min, 60 s between sends, max 5/hour |
| POST | `/auth/verify-otp` | public, rate-limited | `{ email, otp }` → `{ resetToken }` (valid 15 min). 400 `INVALID_OTP`; 5 wrong tries burn the code |
| POST | `/auth/reset-password` | public, rate-limited | `{ resetToken, password }` → 204. Every session of that user is revoked. 400 `INVALID_RESET_TOKEN` |

*Change from the report:* forgot-password uses an emailed OTP instead of a link, as decided by the business owner. It adds `POST /auth/verify-otp`, and `reset-password` takes the `resetToken` issued after verification.

## Users and roles (`users`)

| Method | Path | Body / query → response |
| --- | --- | --- |
| GET | `/users` | `q, roleId, status, page, pageSize` → list of `{ id, name, email, phone, status, createdAt, role{id,name}, assignedLeads, convertedLeads }` |
| POST | `/users` | `{ name, email, phone?, roleId, password }` → 201 user. 409 `EMAIL_TAKEN`, 422 unknown role |
| PATCH | `/users/:id` | any of `{ name, email, phone, roleId, status, password }` → user (never includes the password or its hash). `password` is optional: left out, `null` or `""` keep the current one; otherwise 8–128 characters (422 `fields.password`, and nothing in the request is applied). A new password is hashed like everywhere else (argon2), ends that user's sessions (when admins change their own, the current session stays) and is audited as `user_password_changed` without the password. 409 `CANNOT_DEACTIVATE_SELF`, `LAST_ADMIN`, `EMAIL_TAKEN` |
| DELETE | `/users/:id` | → 204. Deactivates and revokes sessions, then hard-deletes only if nothing references the user. 409 `CANNOT_DELETE_SELF`, `LAST_ADMIN` |
| GET | `/users/options` (`leads`, `follow_ups` or `customers`) | `roleId?` → `[{ id, name }]`, active users only |
| GET | `/roles` | → `[{ id, name, permissions[], userCount, members[{initials}], extraMembers }]` |
| POST | `/roles` | `{ name, permissions[] }` → 201. 409 `ROLE_NAME_TAKEN` (case-insensitive) |
| PATCH | `/roles/:id` | `{ name?, permissions? }` → role. 409 `LAST_ADMIN` |
| DELETE | `/roles/:id` | → 204. 409 `ROLE_IN_USE` |
| GET | `/permissions` | → `[{ code, label }]` |

`LAST_ADMIN`: at least one active user must keep the `users` permission.

## Leads (`leads`)

Lead object:

```json
{
  "id": "uuid", "title": "…", "description": null, "address": null, "district": null,
  "contact": { "name": null, "phone": null, "email": null },
  "customerType": "direct | b2b | null",
  "company": { "name": null, "location": null, "email": null },
  "source": { "id": "uuid", "name": "Meta Ads" } ,
  "status": { "id": "uuid", "name": "New", "isWon": false, "isLost": false },
  "priority": "low | medium | high",
  "expectedValue": 249000.55,
  "paymentStatus": "pending | completed",
  "owner": { "id": "uuid", "name": "…" },
  "shipment": { "destinationCountry": null, "commodity": null, "shipmentType": null /* "air" | "water" | null; "Air"/"AIR" accepted on input */, "weightKg": 1.5,
                "volume": null, "pickupLocation": null, "deliveryLocation": null },
  "customer": null /* after conversion: { "id": "uuid", "code": "CU-00001", "name": "…", "deleted": false } */, "convertedAt": null,
  "version": 1, "createdAt": "…", "updatedAt": "…"
}
```

| Method | Path | Body / query → response |
| --- | --- | --- |
| GET | `/leads` | `q, sourceId, statusId, priority, sort (newest·oldest·value_desc·value_asc·title), page, pageSize` → list of leads. `q` searches title, contact, company, source, status, owner, priority |
| POST | `/leads` | the fields above minus `status/source/owner/paymentStatus/version/dates`, plus `sourceId?, statusId?, ownerId?` and an optional client-chosen `id` (UUID). Only `title` is required → 201 lead. Defaults: first status, owner = you, priority low, payment pending. Sending the same `id` again (a retry) returns the lead already saved with **200** instead of creating another; an `id` used by someone else's lead → 409 `LEAD_ID_TAKEN`. **With files:** `multipart/form-data` with `lead` (the same JSON), `files` (up to 5, 10 MB each: PDF, DOC/DOCX, XLS/XLSX, JPG, PNG, WEBP, HEIC — checked by content, not name) and optional `originalSizes` (JSON array, size before in-browser compression or null). Errors: 422 / 413 with `fields.attachments`, 502 `UPLOAD_FAILED` (nothing saved, uploaded files removed again), 503 `UPLOADS_UNAVAILABLE` when Cloudinary is not configured |
| GET | `/leads/pipeline` | `q, sourceId, priority, perColumn (≤100, default 20)` → `{ columns: [{ status, count, totalValue, items[] }] }` |
| GET | `/leads/:id` | → lead, plus `attachments: [{ id, fileName, mimeType, sizeBytes, originalSizeBytes, createdAt }]` (lists and the pipeline never include files) |
| GET | `/leads/:id/attachments/:attachmentId` | → the file, streamed with its original name (`Content-Disposition: attachment`). Same visibility as the lead (404 otherwise). Files are private Cloudinary assets; no Cloudinary URL is ever returned |
| PATCH | `/leads/:id` | any create field, plus optional `version` → lead. 409 `STALE_VERSION` if someone saved first. Logs status, owner and detail changes |
| DELETE | `/leads/:id` | → 204, soft delete |
| POST | `/leads/:id/assign` | `{ ownerId }` → lead. Active users only. Audited |
| GET | `/leads/:id/activities` | `page` → list of `{ id, type, text, actor{id,name}, createdAt }`, newest first |
| POST | `/leads/:id/reminders` | `{ title, dueAt (ISO with offset, future), notes? }` → 201 `{ id, title, dueAt, notes, createdAt }`. Stored only; delivery awaits Q18/Q19 |
| GET | `/leads/:id/conversion` | Needs `leads` **and** `customers`. → `{ alreadyConverted: false, customer (what the new customer would hold), missing: ["name"]?, matches: [customer + matchedOn: email·phone·company] (only customers you may see; others are neither shown nor counted), moveTo: stage \| null }`, or the converted result below when already converted |
| POST | `/leads/:id/convert` | Needs `leads` **and** `customers`. `{}` or `{ createNew: true }` creates the customer from the lead → 201; `{ customerId }` links the lead to that existing customer (left unchanged) → 200. Response `{ created, alreadyConverted, customer, lead }`. The lead moves to the first won stage and logs `converted`. Once only: a repeat or concurrent request returns the existing customer (200, `alreadyConverted: true`). Errors: 409 `POSSIBLE_DUPLICATE` (matches found and neither `customerId` nor `createNew` sent), 422 `CUSTOMER_NAME_MISSING` (no contact or company name on the lead), 409 `ALREADY_CONVERTED` / `CUSTOMER_DELETED` when its customer isn't visible to you or was deleted |

**Conversion.** Copied once from the lead: contact name (or company name when there is no contact) → `name`; `company`, contact `phone` and `email`, `address`, `district`, company `location` → `companyLocation`, company `email` → `companyEmail`, `customerType` → `type`, source, owner → assignee. Not copied: the description (an internal deal note) and the deal — stage, priority, value, payment, shipment, files — which stay on the lead and are listed on the customer through the link. Later edits to either side never change the other.

`paymentStatus` cannot be set through the API yet (report C5).

## Follow-ups (`follow_ups`)

| Method | Path | Body / query → response |
| --- | --- | --- |
| GET | `/follow-ups` | `q, status (pending·overdue·completed), page, pageSize` → list of `{ id, note, lead{id,label}, type, assignee, status, dueDate, nextFollowUpDate, completedAt, createdAt }` plus `pendingCount`, `overdueCount` |
| POST | `/follow-ups` | `{ leadId, followUpDate, nextFollowUpDate?, note, type (whatsapp·call·email·meeting), assignedUserId? }` → 201. Assignee defaults to you; the lead must be visible to you |
| POST | `/follow-ups/:id/complete` | → follow-up (idempotent) |
| GET | `/follow-ups/history` | `page` → list of `{ lead{id,label}, completedCount, entries[] }` |
| GET | `/lookups/lead-contacts` | `q?` → `[{ leadId, label }]`, up to 20 visible leads, label "Company - Contact" |

`overdue` means pending with a due date before today's date in Asia/Kolkata.

## Customers (`customers`), dashboard (`dashboard`), notifications (`notifications`)

| Method | Path | Response |
| --- | --- | --- |
| GET | `/customers` | `q (also matches the CU code), status (active·inactive), type (direct·b2b), sourceId, assignedUserId, createdFrom (YYYY-MM-DD, India time), page, pageSize` → list of `{ id, code (CU-00001), name, company, phone, email, address, district, companyLocation, companyEmail, type, source, assignee, status, note, leadId (source lead), createdAt, updatedAt }`, newest first, plus `activeCount` = every active customer you may see, regardless of search and filters (`total` is the filtered count) |
| GET | `/customers/:id` | → customer plus `attachments` (its own files: `{ id, fileName, mimeType, sizeBytes, originalSizeBytes, createdAt, uploadedBy }`), `leads` (converted leads you may see, with shipment and `attachments`; none without `leads`) and `hiddenLeads` (linked leads you can't open) |
| PATCH | `/customers/:id` | any of `name, company, phone, email, address, district, companyLocation, companyEmail, type, sourceId, assignedUserId (active user; changing it needs `all_records`, else 403), status, note` → customer. Blank optional fields are cleared. Audited by field name only. `status: "inactive"` deactivates (the record stays, out of the active count) |
| DELETE | `/customers/:id` | 405 `CUSTOMER_DELETE_DISABLED`: customers are deactivated, never deleted |
| POST | `/customers/:id/attachments` | multipart: `files` (up to 5, 10 MB each, same types as lead files, checked by content), `ids` (JSON array, one UUID per file: a retry with the same ids saves nothing twice), `originalSizes` → 201 `{ items }` (all the customer's files). 422 / 413 with `fields.attachments`; 502 `UPLOAD_FAILED` (nothing saved, uploaded files removed) |
| GET | `/customers/:id/attachments/:attachmentId` | → the file, streamed with its original name. Same visibility as the customer |
| DELETE | `/customers/:id/attachments/:attachmentId` | → 204. Removes the file (audited). Files of the original lead stay with the lead and are not affected |
| GET | `/customers/:id/activities` | `page, pageSize` → list of `{ id, type (initial·follow_up·call), occurredAt, notes, actor, createdAt }`, most recent first |
| POST | `/customers/:id/activities` | `{ id? (UUID: the same id again returns the saved entry, 200), type, occurredAt (ISO with offset, not in the future), notes? }` → 201 |
| GET | `/dashboard/summary` | `{ kpis: { totalLeads, newLeads, activeLeads, convertedLeads, lostLeads, activeCustomers, followUpsDueToday, followUpsOverdue, openLeadValue, convertedValue, conversionRate }, byStatus: [{ status, count }], bySource: [{ source \| null, count, share }] }` |
| GET | `/notifications` | list of `{ id, title, detail, link, read, createdAt }` plus `unreadCount` |

## Settings

| Method | Path | Access | Response |
| --- | --- | --- | --- |
| GET | `/settings/lead-sources` | signed in | `[{ id, name, active }]` |
| POST | `/settings/lead-sources` | `settings` | `{ name }` → 201. Re-adding a deactivated name revives it. 409 `DUPLICATE_NAME` |
| DELETE | `/settings/lead-sources/:id` | `settings` | 204: deleted if unused, deactivated if leads or customers use it |
| GET | `/settings/lead-statuses` | signed in | `[{ id, name, sortOrder, isWon, isLost }]`, in pipeline order |
| POST | `/settings/lead-statuses` | `settings` | `{ name }` → 201, appended last |
| DELETE | `/settings/lead-statuses/:id` | `settings` | 204. 409 `STATUS_IN_USE`, `LAST_STATUS` |

## Not built yet

- Calculator endpoints: blocked until the business supplies rate data (Q21).
- Adding files to an existing lead, and deleting files: not built yet (needs a decision on who may remove files and how long they are kept). Files can be attached when a lead is created.
- Every "potential future" endpoint from report section 7.
