# Production readiness checklist

Audit of the KARATS team workspace, 17 September 2026, against commit `b54a673`.

The app is deployable and the hard correctness work is done. What follows is what
stands between "it works" and "it can be relied on by a team without someone
watching it." Items are ordered by when they will actually cause a problem, not by
how interesting they are.

Tick items as they land. Each one records *why* it matters and where the evidence
is, so the reasoning survives after the details are forgotten.

---

## P0 — will cause real problems soon

### - [ ] 1. Expired sessions are never cleaned up on the hosted app

`sweepSessions` exists in both stores but is only ever called from a `setInterval`
in the local server (`server/server.mjs:17`). Vercel functions have no background
loop, so the hosted app never calls it. The `sessions` table grows without limit.

**Fix:** a scheduled job calling `sweepSessions`. Either a Vercel Cron hitting a
protected route, or a Supabase `pg_cron` job running
`DELETE FROM sessions WHERE expires < now()`. The Supabase route is simpler and
does not need an authenticated endpoint.

**Effort:** under an hour.

---

### - [ ] 2. Preview deployments write to the production database

Both `DATABASE_URL` and `DIRECT_URL` are set for Production *and* Preview, so any
preview branch reads and writes real lead data. A migration tested on a preview
would alter production.

**Fix:** create a second Supabase project, point the Preview environment at it, and
run `npm run db:migrate` against it. Keep Production variables scoped to
Production only.

**Effort:** ~30 minutes, mostly waiting for the project to provision.

---

### - [ ] 3. Login throttling is ineffective when hosted

`makeRateLimiter` in `lib/core.mjs` keeps attempt counts in an in-process `Map`.
That works for the single long-running local server. On Vercel, requests spread
across instances, so an attacker gets roughly the limit *per instance*. The
limitation is noted in a comment at the function.

**Fix:** Vercel WAF rate limiting on `/api/login` (no code change), or move the
counter into Postgres so it is shared. The WAF route is preferable — it rejects
before the function runs and so also protects against cost abuse.

**Effort:** ~15 minutes for the WAF rule.

---

### - [ ] 4. `mutations` and `activity` grow unbounded

Nothing prunes either table. `mutations` stores an idempotency receipt per lead
save, forever; `activity` stores one row per edit, forever. Only `sessions` has a
sweep, and per item 1 that sweep does not run when hosted.

**Fix:** decide a retention window and enforce it in the same scheduled job as
item 1. Suggested starting point: `mutations` older than 30 days (they only guard
against retried requests, which resolve in minutes), `activity` older than 12
months. Confirm the activity window against how far back the team actually looks.

**Effort:** ~1 hour including the retention decision.

---

## P1 — security hardening

### - [ ] 5. No Content-Security-Policy, HSTS, or Permissions-Policy

`vercel.json` sets `X-Content-Type-Options`, `Referrer-Policy` and
`X-Frame-Options` only. CSP matters here specifically because the app renders
user-entered lead notes.

**Fix:** add a CSP to the `headers` block in `vercel.json`. The app loads no
third-party scripts, so a strict policy is achievable — start with
`default-src 'self'` and tighten from the browser console. Add
`Strict-Transport-Security` and a `Permissions-Policy` denying features the app
does not use.

---

### - [ ] 6. Weak password policy

`validateAccount` in `lib/core.mjs` requires six characters and nothing else. No
strength rule, no check against known-breached passwords.

**Fix:** raise the minimum to 12, and consider the Have I Been Pwned range API
for a breach check. Note this changes behaviour for existing accounts — decide
whether to force a reset or apply it only to new passwords.

---

### - [ ] 7. No password reset

Documented as out of scope in the README, but the operational consequence is that
a locked-out staff member requires manual database editing. That does not scale
past a handful of users.

**Fix:** needs an email provider. Until then, document the manual recovery
procedure so it is not improvised under pressure.

---

### - [ ] 8. No account offboarding

Also documented. When someone leaves there is no way to disable their account, and
no "sign out everywhere". Their existing session stays valid for up to seven days.

**Fix:** a `disabled` flag on `User`, checked in `userBySession`, plus deleting
that user's sessions when the flag is set. This is the single most likely thing to
matter in practice — staff turnover is routine.

---

## P2 — engineering practice

### - [ ] 9. No CI

Three test suites exist and nothing runs them automatically. **This is the highest
value-per-effort item on the list.** The drift between the two API implementations
(which had produced three real defects, see the initial commit message) would have
been caught earlier by a workflow running `npm test` on every push.

**Fix:** a GitHub Actions workflow on push and pull request running `npm ci`,
`npm run build`, `npm test`.

**Effort:** ~30 minutes.

---

### - [ ] 10. No linter, formatter, or `.editorconfig`

Nothing enforces consistency. Low urgency while the codebase has one author;
it becomes a real cost the moment it has two.

---

### - [ ] 11. No type checking

No TypeScript and no JSDoc types. The store interface is currently enforced only
by the parity test in `tests/routes.test.mjs`, which checks that both stores
implement every method the route table calls — but not that the signatures agree.

**Fix:** JSDoc plus `checkJs` gives most of the benefit without a build step,
which suits a project that deliberately has no bundler.

---

### - [ ] 12. The Prisma store's SQL is not covered by automated tests

`tests/routes.test.mjs` covers the shared route logic through a fake store, so the
code path the hosted app runs *is* tested. The Prisma queries themselves were
verified manually against the live database on 17 September 2026 — every store
method, including the version-conflict guard and BigInt serialisation — but
nothing re-checks them.

**Fix:** a disposable Postgres database in CI, running the same scenarios against
`prismaStore`.

---

### - [ ] 13. Open `engines` range and no `.nvmrc`

`package.json` declares `>=22.17.0`. Vercel resolves open ranges to the newest
available major, so the runtime can shift without any change on your side.

**Fix:** pin the Node version explicitly in Vercel project settings, and add an
`.nvmrc` so local and CI agree.

---

## P3 — operations

### - [ ] 14. No error monitoring

Failures reach `console.error` and land in Vercel logs that nobody reads. You will
not know about a broken save unless a user reports it.

### - [ ] 15. No structured logging or request IDs

A user saying "it failed around lunchtime" cannot currently be traced to a request.

### - [ ] 16. No health endpoint

Nothing for an uptime monitor to poll, and no quick way to confirm the database
connection is alive after a deploy.

### - [ ] 17. Backups are untested

Supabase backups depend on the plan. An untested restore is not a backup — do one
restore drill into a scratch project and record how long it took.

---

## Already solid — do not regress these

Worth stating, because this part is unusual for a project at this stage:

- **One runtime dependency** (`@prisma/client`), `npm audit` clean.
- **No vendor SDK lock-in.** No `@vercel/*`, no `@aws-*`, not even
  `@supabase/supabase-js`. Supabase is used as plain Postgres, with no Auth,
  Storage, Realtime or RLS coupling — so the database is portable.
- **Optimistic concurrency** with version guards checked inside the transaction.
- **Idempotent mutation replay**, so a retried save after a dropped connection
  cannot double-apply.
- **Serializable-transaction admin lock**, so two simultaneous setup requests
  cannot both create an administrator.
- **One shared API implementation** in `lib/`, with thin per-host adapters, and a
  test that fails if the two stores stop implementing the same interface.

---

## Suggested order

1. **Item 9 (CI)** — it protects everything you do afterwards.
2. **Item 1 (session cleanup)** — cheap, and the table only grows until it is done.
3. **Item 2 (separate Preview database)** — before anyone else starts contributing.
4. **Item 8 (account offboarding)** — before the team grows enough for someone to leave.
5. Everything else as it becomes relevant.

Items 1 and 9 are each well under an hour. Item 2 is mostly waiting.

---

## Out of scope by decision

Recorded so they are not rediscovered as gaps. These are deliberate, per the README:

- Email notifications.
- Organisation-level access separation — this is one shared team, not multi-tenant.
- Importing existing browser-local calculator and presentation data into team leads.
