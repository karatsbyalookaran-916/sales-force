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

### - [ ] 2. Preview deployments write to the production database — deferred, not yet a risk

Both `DATABASE_URL` and `DIRECT_URL` are scoped to Production *and* Preview, so a
preview branch would read and write the same data as production, and a migration
tested on a preview would alter it.

**Deliberately deferred on 17 September 2026.** The risk is currently zero, not
merely small: the database is empty (no users, no leads, no administrator yet), and
Vercel only builds Preview deployments for non-production branches. Work is pushed
straight to `main`, which builds Production, so no preview deployment exists.

**Trigger — act when both become true:**

1. Real lead data exists that would matter if overwritten, and
2. Anyone pushes a branch or opens a pull request, which is what creates a preview

**Do this first, because it is free.** When the team starts entering real leads, untick
**Preview** on both variables in Vercel so only Production keeps them. A preview deploy
then has no database and fails loudly, instead of silently writing to live data. That
removes the whole class of problem in about thirty seconds.

**Only then, if wanted:** create a second Supabase project so previews have a database
of their own to develop against, and run `npm run db:migrate` against it. Use the
transaction pooler (6543) and session pooler (5432) — the direct `db.*.supabase.co`
host is IPv6-only and unreachable from this network.

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

### - [x] 9. No CI

Three test suites exist and nothing runs them automatically. **This is the highest
value-per-effort item on the list.** The drift between the two API implementations
(which had produced three real defects, see the initial commit message) would have
been caught earlier by a workflow running `npm test` on every push.

**Done.** `.github/workflows/ci.yml` runs on every push to `main` and every pull
request, in two jobs:

- **check** — `npm ci`, lint, type check, `prisma migrate deploy` against a throwaway
  Postgres service container, the unit and route suites, then the Postgres store suite
- **browser** — the Playwright suite, with screenshots uploaded as an artifact

Each step was run locally first and its real exit code confirmed. A newer push cancels
the older run for the same branch.

It paid for itself immediately: adding the linter surfaced a live cookie-parsing bug in
the hosted adapter (see item 11).

---

### - [x] 10. No linter, formatter, or `.editorconfig`

**Done.** ESLint 9 flat config in `eslint.config.mjs`, deliberately small — rules that
catch real mistakes, nothing stylistic that `.editorconfig` and review already handle.
Separate global sets for Node and browser code, because the two halves of this project
genuinely differ. `npm run lint`, clean at zero problems.

Also added `.editorconfig` and `.gitattributes`. The latter normalises line endings,
which were producing noisy CRLF warnings on every Windows commit.

---

### - [x] 11. No type checking

**Done.** `tsconfig.json` with `checkJs` and `noEmit` — it type-checks the JavaScript
in place and never emits, so the no-build-step design is preserved. `npm run typecheck`,
clean at zero errors. Started permissive (`strict: false`); tightening it is a reasonable
follow-up once the existing surface is annotated.

**This is where the linter earned its keep.** It flagged `\s` inside a template literal in
the hosted adapter's cookie parser. Inside a template literal `\s` is not a valid escape,
so it collapsed to a literal `s` and the pattern became `(?:^|;s*)` — zero-or-more letter
"s", not whitespace. Browsers separate cookies with `"; "`, so **the hosted app could not
read the session cookie whenever it was not the first cookie in the header**, which would
have shown up as users being randomly signed out.

Root cause was the familiar one: both adapters parsed cookies separately. It is now
`readCookie()` in `lib/core.mjs`, shared, with a regression test covering nine header
shapes.

---

### - [x] 12. The Prisma store's SQL is not covered by automated tests

`tests/routes.test.mjs` covers the shared route logic through a fake store, so the
code path the hosted app runs *is* tested. The Prisma queries themselves were
verified manually against the live database on 17 September 2026 — every store
method, including the version-conflict guard and BigInt serialisation — but
nothing re-checks them.

**Done.** `tests/store-postgres.test.mjs` exercises the real SQL — accounts, duplicate
email handling, session expiry, lead versioning and conflict, idempotent replay, activity
joins and BigInt serialisation, the atomic throttle counter, and maintenance pruning.

It skips unless `TEST_DATABASE_URL` names a throwaway database, so a normal `npm test`
is unaffected; CI supplies one as a service container. It tracks every row it creates and
removes them in an `after` hook that runs even when an assertion fails.

Verified by running it against a live database and confirming every table was back to
zero rows afterwards.

---

### - [x] 13. Open `engines` range and no `.nvmrc`

`package.json` declares `>=22.17.0`. Vercel resolves open ranges to the newest
available major, so the runtime can shift without any change on your side.

**Done.** `engines.node` pinned to `22.x`, `.nvmrc` added, and CI reads the version from
`.nvmrc` so all three environments agree. Previously `>=22.17.0` resolved to whatever the
newest major on Vercel happened to be — 24.x today, silently something else later. That
matters more than usual here because `node:sqlite` is still experimental and its behaviour
can change between majors.

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
