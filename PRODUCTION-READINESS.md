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

### - [x] 1. Expired sessions are never cleaned up on the hosted app

`sweepSessions` existed in both stores but was only ever called from a `setInterval`
in the local server. Vercel functions have no background loop, so the hosted app
never called it and the `sessions` table grew without limit.

**Done.** Both stores now implement `maintenance()`, reached through a
`GET /api/maintenance` route authenticated by `CRON_SECRET` rather than a session.
`vercel.json` schedules it daily at 03:00 UTC. The local server keeps its own
interval and calls the same function, so the two hosts cannot drift.

Deleting by age is idempotent, which matters because Vercel documents cron delivery
as best-effort — a run may be missed or repeated.

**Remaining manual step:** set `CRON_SECRET` in Vercel (Settings → Environment
Variables), a random string of 16+ characters. Vercel sends it automatically as
`Authorization: Bearer <value>`. **Without it the route returns 401 and cleanup
never runs** — it fails closed by design, so this step is not optional.

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

### - [x] 3. Login throttling is ineffective when hosted

`makeRateLimiter` kept attempt counts in an in-process `Map`. That worked for the
single long-running local server, but on Vercel requests spread across instances, so
an attacker got roughly the full allowance against each instance separately.

**Done.** The counter moved into the database — `login_attempts`, migration
`20260917130000_login_attempts`, applied to Supabase. Both stores implement
`recordLoginAttempt()` as a single atomic upsert, so two simultaneous attempts cannot
both read the old count. The in-memory limiter is gone entirely rather than left as a
second code path. Limits live in `lib/core.mjs`: 30 attempts per 15 minutes.

Stale counters are pruned by the same maintenance job as item 1.

Verified against live Postgres: increments, blocks past the limit, resets once the
window passes, and ten concurrent attempts produced counts 1–10 with no lost updates.
The SQLite equivalent is covered in `tests/routes.test.mjs`.

**Known limit:** the counter keys on client IP, matching the previous behaviour. That
does not stop credential stuffing spread across many IPs against one account. Keying
additionally on the submitted email would close that, and is worth doing if the app
ever faces the open internet with more than a handful of accounts. Vercel WAF rate
limiting in front of `/api/login` would also reject before the function runs, which
protects against cost abuse as well.

---

### - [x] 4. `mutations` and `activity` grow unbounded

Nothing pruned either table. `mutations` stored an idempotency receipt per lead
save, forever; `activity` stored one row per edit, forever.

**Done.** Pruned by the same scheduled job as item 1, with windows declared in
`lib/core.mjs`: `MUTATION_RETENTION_MS` 30 days, `ACTIVITY_RETENTION_MS` 365 days.

`Mutation` had no timestamp at all, so there was nothing to prune by. Added
`created_at` with an index — migration `20260917120000_mutation_created_at`, applied
to Supabase on 17 September 2026. Local SQLite databases upgrade themselves on next
open; rows predating the column are treated as ancient and pruned on the first run,
which is correct because they only ever guarded against a retried request.

**Review the 365-day activity window** against how far back the team actually looks.
It is a guess, and it is the one number here worth a human decision.

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
