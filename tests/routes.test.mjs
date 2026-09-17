// Exercises the shared route table directly, through a fake store.
// This is the code path BOTH hosts run, so it covers the hosted logic without Postgres.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { handle } from '../lib/routes.mjs';
import { passwordHash, makeRateLimiter } from '../lib/core.mjs';
import { sqliteStore } from '../lib/store-sqlite.mjs';
import { prismaStore } from '../lib/store-prisma.mjs';

// Every store method the route table calls. Both stores must implement all of them.
const REQUIRED = ['createAdmin', 'createMember', 'userByEmail', 'userById', 'listUsers', 'createSession',
  'userBySession', 'deleteSession', 'listLeads', 'leadById', 'mutationById', 'listActivity', 'commitLead'];

function memoryStore() {
  const users = [], sessions = new Map(), leads = new Map(), mutations = new Map(), activity = [];
  const add = account => {
    const user = { id: randomUUID(), name: account.name, email: account.email, password: passwordHash(account.password), role: account.role };
    users.push(user);
    return { id: user.id, name: user.name, email: user.email, role: user.role };
  };
  return {
    users, leads,
    async createAdmin(a) { return add({ ...a, role: 'admin' }); },
    async createMember(a) { return add({ ...a, role: 'member' }); },
    async userByEmail(email) { return users.find(u => u.email === email) || null; },
    async userById(id) { return users.find(u => u.id === id) || null; },
    async listUsers() { return users.map(({ id, name, email, role }) => ({ id, name, email, role })); },
    async createSession(token, userId, expires) { sessions.set(token, { userId, expires }); },
    async userBySession(token, now) {
      const session = sessions.get(token);
      return session && session.expires > now ? users.find(u => u.id === session.userId) : null;
    },
    async deleteSession(token) { sessions.delete(token); },
    async listLeads() { return [...leads.values()].map(entry => entry.data); },
    async leadById(id) { return leads.get(id) || null; },
    async mutationById(id) { return mutations.get(id) || null; },
    async listActivity(leadId) { return activity.filter(row => row.lead_id === leadId).reverse(); },
    async commitLead({ lead, mutationId, userId, baseVersion, isNew, text }) {
      const current = leads.get(lead.id);
      if (!isNew && (!current || current.version !== baseVersion)) return 'conflict';
      leads.set(lead.id, { data: lead, version: lead.version });
      mutations.set(mutationId, { userId, result: lead });
      activity.push({ lead_id: lead.id, user_id: userId, text, user_name: users.find(u => u.id === userId)?.name });
      return 'ok';
    }
  };
}

const run = async (ctx, deps) => {
  try { return await handle(ctx, deps); }
  catch (error) { return { status: error.status || 500, body: { error: error.message } }; }
};

test('shared route table: auth, setup, leads, conflicts and replay', async () => {
  const store = memoryStore();
  let open = true;
  const deps = { store, limiter: makeRateLimiter(), setupAvailable: async () => open };
  const call = (method, path, extra = {}) => run({ method, path, body: {}, query: {}, token: '', clientId: 'test', ...extra }, deps);

  assert.equal((await call('GET', '/setup-status')).body.setupAvailable, true);

  const admin = { name: 'Admin', email: 'admin@example.test', password: 'test-password-123' };
  assert.equal((await call('POST', '/setup', { body: admin })).status, 201);
  open = false;
  assert.equal((await call('POST', '/setup', { body: admin })).status, 403, 'setup closes after the first account');

  assert.equal((await call('POST', '/login', { body: { email: admin.email, password: 'wrong' } })).status, 401);
  const login = await call('POST', '/login', { body: { email: admin.email, password: admin.password } });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.password, undefined, 'password never leaves the server');
  const token = login.cookie.value;

  assert.equal((await call('GET', '/leads')).status, 401, 'no cookie means no access');
  assert.equal((await call('GET', '/me', { token })).body.user.email, admin.email);

  assert.equal((await call('POST', '/users', { token, body: { name: 'Member', email: 'm@example.test', password: 'another-password' } })).status, 201);
  const memberLogin = await call('POST', '/login', { body: { email: 'm@example.test', password: 'another-password' } });
  assert.equal((await call('POST', '/users', { token: memberLogin.cookie.value, body: { name: 'X', email: 'x@example.test', password: 'password-here' } })).status, 403,
    'only an administrator registers accounts');

  const lead = { id: randomUUID(), name: 'Example Jewellers', contact: 'Alex', phone: '1234', email: '', location: 'Kochi', stage: 'New', ownerId: store.users[0].id, followUp: '2026-09-20', notes: 'First call' };
  const operation = { mutationId: randomUUID(), baseVersion: 0, lead };

  const created = await call('POST', '/leads', { token, body: operation });
  assert.equal(created.status, 200);
  assert.equal(created.body.version, 1);

  const replay = await call('POST', '/leads', { token, body: operation });
  assert.deepEqual(replay.body, created.body, 'replaying a mutation returns the first result');
  assert.equal((await call('POST', '/leads', { token: memberLogin.cookie.value, body: operation })).status, 403,
    'replay by another user is rejected');

  const conflict = await call('POST', '/leads', { token, body: { mutationId: randomUUID(), baseVersion: 0, lead: { ...lead, stage: 'Interested' } } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.current.stage, 'New');

  // Regression: a non-uuid ownerId must be a 400, not a database driver error.
  assert.equal((await call('POST', '/leads', { token, body: { mutationId: randomUUID(), baseVersion: 1, lead: { ...lead, ownerId: 'missing-user' } } })).status, 400);
  assert.equal((await call('POST', '/leads', { token, body: { mutationId: 'not-a-uuid', baseVersion: 1, lead } })).status, 400);

  assert.equal((await call('GET', '/activity', { token, query: { lead: lead.id } })).body.length, 1);

  assert.equal((await call('POST', '/logout', { token })).status, 200);
  assert.equal((await call('GET', '/me', { token })).status, 401);
});

test('login throttling rejects a flood of attempts', async () => {
  const deps = { store: memoryStore(), limiter: makeRateLimiter({ max: 2 }), setupAvailable: async () => false };
  const attempt = () => run({ method: 'POST', path: '/login', body: { email: 'nobody@example.test', password: 'x' }, query: {}, token: '', clientId: 'flooder' }, deps);
  assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429, 'third attempt is throttled');
});

test('both stores implement the full route-table interface', () => {
  const stub = { exec() {}, prepare: () => ({ run() {}, get() {}, all: () => [] }) };
  for (const [name, store] of Object.entries({ sqlite: sqliteStore(stub), prisma: prismaStore({}, {}) }))
    for (const method of REQUIRED)
      assert.equal(typeof store[method], 'function', `${name} store is missing ${method}()`);
});
