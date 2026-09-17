# KARATS Team Workspace

An online/offline team sales workspace around the existing KARATS presentation and capital calculator. The original HTML files remain usable on their own.

## Start locally

Requires Node.js 22.17 or newer (Node 24 LTS recommended). No runtime packages or build step are required.

1. Double-click **Start KARATS App.bat**, or run `npm start` in this folder. While editing files in `server/`, run `npm run dev` instead — it restarts the server on change. Front-end edits under `app/` never need a restart, only a browser refresh.
2. Open **http://localhost:4173**. Keep the server terminal running.
3. Create the single administrator account in the browser. Initial local account creation is available only on localhost, before any accounts exist.
4. Open **Employee management**, then use **Onboard staff** to register employees. Each staff member receives a separate login; the application never creates a second administrator.

Alternatively run `npm run create-admin` in an interactive terminal to create an administrator. The password is entered without echo. There are no default accounts or passwords.

**Open KARATS Elite Plan.bat** still opens the original standalone presentation. It does not start the team app.

## Included workflows

- Shared team pipeline: New → Contacted → Presented → Interested → Negotiating → Joined / Closed.
- Create and edit leads, assign a team member, record contact details and meeting notes, and set a follow-up date.
- Search and filter by team member or follow-up status. The board scrolls horizontally on smaller screens; open a lead to change its stage.
- Lead counts, due follow-ups, CSV export, and server activity history.
- One administrator plus separate staff accounts, with hashed passwords and HttpOnly session cookies. Passwords must contain at least 6 characters. Staff can view and edit **all** leads in this single team; only the administrator registers accounts.
- Existing presentation, calculator, fonts, and PDF libraries cached for offline use.
- IndexedDB saves lead updates locally. While the app is open it syncs after saving, after reconnecting, and every 30 seconds while visible.
- Version checks detect simultaneous edits. Review both versions and explicitly choose which to keep. Repeated requests after a lost connection are safe to retry.

## Offline and device behavior

Open the app online and sign in once on each device. Wait for the sidebar to confirm the presentation is available offline. Use the browser's install option where available. Service workers require HTTPS online or localhost during development; opening the HTML with `file://` does not enable the team app.

Offline access uses the last signed-in account on that browser profile, for up to seven days from sign-in. New logins and team account creation need the server. Do not use a shared browser profile for private offline records. Offline lead data is stored in the browser, not encrypted by this application. Clearing browser storage removes unsynced changes. Keep device access protected.

Sign-out requires connectivity and no pending edits; it clears the local lead cache and KARATS calculator/profile storage. The app will ask you to sync or resolve conflicts first. Presentation files remain cached. Closing the browser preserves pending changes for the next launch. Sync does not run after the app is closed.

Existing jewellery profiles, calculator settings, and edited presentation templates remain in their original browser-local storage. They are **not** automatically imported into or synchronized with team leads. Data saved under the original `file://` URL is not available under `http://localhost:4173` or a new online domain. The team lead database starts empty.

## Supabase + Prisma + Vercel deployment

The app has not been deployed. The hosted path is prepared for Vercel serverless functions, Prisma, and a Supabase Postgres database. The local launcher continues to use its local SQLite database for offline development; local and hosted records are separate.

1. Create a Supabase project and copy its transaction-pooler connection string and direct database connection string.
2. Copy `.env.example` to `.env` locally. Set `DATABASE_URL` to the transaction pooler (normally port 6543) and `DIRECT_URL` to the direct connection (normally port 5432).
3. Run `npm run db:migrate` to create the hosted tables. The database contains a singleton administrator lock, so even two simultaneous setup requests cannot create two administrators.
4. Import this project into Vercel. Add the same `DATABASE_URL` and `DIRECT_URL` environment variables to Production and Preview as appropriate. Vercel runs `npm run build` (`prisma generate`) on every deployment, so a cached dependency install cannot leave a stale Prisma Client behind. Set the runtime explicitly under **Settings → Build and Deployment → Node.js Version**.
5. Deploy, visit the Vercel URL, and create the one administrator account. Then register staff from **Employee management**.

Vercel routes `/api/*` to the Prisma function and serves the existing presentation, calculator, fonts, and PWA files as static assets. The API accepts same-origin browser requests only and sets Secure, HttpOnly cookies. Do not put Supabase's service-role key or database URLs in browser code or variables beginning with `NEXT_PUBLIC_`.

Use Supabase's pooler for `DATABASE_URL`; direct database connections from serverless functions can exhaust Postgres connection limits. The direct URL is for migrations. The app is intended for one shared team, not separate client organizations. Account disabling, password recovery, email notifications, and organization-level access separation are not included in this version.

Enable Supabase backups appropriate to your plan. CSV export includes lead details but not user accounts, passwords, or full activity history.

The Dockerfile remains available for the local SQLite version, but the recommended shared deployment is Vercel + Supabase.

## Verification

```text
npm install
npm test
npm run test:browser
```

Browser tests require Microsoft Edge and use Playwright in a temporary test database. Tests cover sign-in, permissions, private-file protection, lead saving, retry deduplication, concurrent edit conflicts, offline persistence, offline presentation loading, team creation, mobile overflow, and local cache clearing on sign-out. Screenshots are written to ignored `test-results/`. Test accounts never enter the real database.

## Files

- `app/` — responsive lead workspace and offline data handling
- `lib/` — the shared API: route table, validation, and one store per database
- `api/` — Vercel adapter over `lib/`, using Prisma and Supabase Postgres
- `prisma/` — hosted database schema and migration
- `server/` — local Node adapter over `lib/`, static file serving, and account setup
- `sw.js`, `manifest.webmanifest` — offline shell and install metadata
- `data/` — local SQLite database, created on first launch and excluded from Git
- `Karats-Elite-Plan-Brochure-source.html` — original presentation and PDF export
- `Karats-Smart-Capital-Calculator.html` — original capital calculator and jewellery profiles
- `fonts/`, `karats-pdf-libs/` — bundled offline assets
