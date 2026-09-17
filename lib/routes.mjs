// The only place API behaviour is defined. Hosts supply a store and a request context;
// this returns a plain { status, body, cookie } result with no framework types involved.
import {
  fail, digest, passwordMatches, DUMMY_HASH, publicUser, newSessionToken,
  validateAccount, validateLead, isUuid, isSessionToken, secretMatches,
  SESSION_MS, MUTATION_RETENTION_MS, ACTIVITY_RETENTION_MS,
  LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS
} from './core.mjs';

async function saveLead(ctx, store, user) {
  const { mutationId, baseVersion, lead } = ctx.body;
  if (!isUuid(mutationId) || !Number.isInteger(baseVersion) || baseVersion < 0
    || !lead || typeof lead !== 'object' || !isUuid(lead.id)) fail(400, 'Invalid lead update');

  // Replaying a mutation must return the original result rather than apply it twice.
  const receipt = await store.mutationById(mutationId);
  if (receipt) {
    if (receipt.userId !== user.id) fail(403, 'Invalid update owner');
    return { status: 200, body: receipt.result };
  }

  const previous = await store.leadById(lead.id);
  if (!previous && baseVersion !== 0) fail(400, 'This lead is missing from the server. Export your saved leads and contact your administrator.');
  if ((previous?.version || 0) !== baseVersion)
    return { status: 409, body: { error: 'A teammate updated this lead. Review both versions.', current: previous.data } };

  const clean = validateLead(lead);
  // Checked before the lookup: a non-uuid id would be a driver error on Postgres, not a miss.
  if (clean.ownerId && (!isUuid(clean.ownerId) || !(await store.userById(clean.ownerId)))) fail(400, 'Choose an existing team member');

  const old = previous?.data || null;
  const now = new Date();
  Object.assign(clean, {
    version: baseVersion + 1,
    updatedAt: now.toISOString(),
    updatedBy: user.id,
    createdAt: old?.createdAt || now.toISOString()
  });
  const text = !old ? `Created lead · ${clean.stage}`
    : old.stage !== clean.stage ? `${old.stage} → ${clean.stage}`
    : 'Updated lead details';

  const outcome = await store.commitLead({ lead: clean, mutationId, userId: user.id, baseVersion, isNew: !previous, text, now });
  if (outcome === 'conflict') {
    const current = await store.leadById(lead.id);
    return { status: 409, body: { error: 'A teammate updated this lead. Review both versions.', current: current?.data } };
  }
  return { status: 200, body: clean };
}

export async function handle(ctx, { store, setupAvailable, cronSecret }) {
  const { method, path, query = {}, body = {}, token = '', clientId = '', authorization = '' } = ctx;

  // Scheduled cleanup. Authenticated by a shared secret rather than a session, because
  // no user is signed in. Vercel Cron sends GET with `Authorization: Bearer <CRON_SECRET>`.
  // Deleting by age is idempotent, which matters: cron delivery may miss or repeat a run.
  if (path === '/maintenance' && method === 'GET') {
    if (!secretMatches(authorization.replace(/^Bearer\s+/i, ''), cronSecret)) fail(401, 'Unauthorized');
    const now = new Date();
    const deleted = await store.maintenance({
      now,
      mutationsBefore: new Date(now.getTime() - MUTATION_RETENTION_MS),
      activityBefore: new Date(now.getTime() - ACTIVITY_RETENTION_MS)
    });
    return { status: 200, body: { ok: true, deleted } };
  }

  if (path === '/setup-status' && method === 'GET')
    return { status: 200, body: { setupAvailable: await setupAvailable() } };

  if (path === '/setup' && method === 'POST') {
    if (!(await setupAvailable())) fail(403, 'Initial setup is only available before the first account is created');
    await store.createAdmin(validateAccount(body, 'admin'));
    return { status: 201, body: { ok: true } };
  }

  if (path === '/login' && method === 'POST') {
    // Counted before the password is checked, so a flood is rejected regardless of outcome.
    const attempt = await store.recordLoginAttempt(String(clientId || 'unknown').slice(0, 120),
      { now: Date.now(), windowMs: LOGIN_WINDOW_MS, max: LOGIN_MAX_ATTEMPTS });
    if (!attempt.allowed) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
    if (typeof body.email !== 'string' || typeof body.password !== 'string' || body.password.length > 256) fail(400, 'Enter your email and password');
    const user = await store.userByEmail(body.email.trim().toLowerCase());
    const valid = passwordMatches(body.password, user?.password || DUMMY_HASH);
    if (!user || !valid) fail(401, 'Email or password is incorrect');
    const raw = newSessionToken();
    await store.createSession(digest(raw), user.id, new Date(Date.now() + SESSION_MS));
    return { status: 200, body: { user: publicUser(user) }, cookie: { value: raw, maxAge: 604800 } };
  }

  // Everything below requires a signed-in user.
  const user = isSessionToken(token) ? await store.userBySession(digest(token), new Date()) : null;
  if (!user) fail(401, 'Sign in to sync your changes');

  if (path === '/me' && method === 'GET') return { status: 200, body: { user: publicUser(user) } };

  if (path === '/logout' && method === 'POST') {
    await store.deleteSession(digest(token));
    return { status: 200, body: { ok: true }, cookie: { value: '', maxAge: 0 } };
  }

  if (path === '/users' && method === 'GET') return { status: 200, body: await store.listUsers() };

  if (path === '/users' && method === 'POST') {
    if (user.role !== 'admin') fail(403, 'Only administrators can add team members');
    return { status: 201, body: await store.createMember(validateAccount(body, 'member')) };
  }

  if (path === '/leads' && method === 'GET') return { status: 200, body: await store.listLeads() };

  if (path === '/activity' && method === 'GET')
    return { status: 200, body: await store.listActivity(String(query.lead || '')) };

  if (path === '/leads' && method === 'POST') return saveLead(ctx, store, user);

  fail(404, 'Not found');
}
