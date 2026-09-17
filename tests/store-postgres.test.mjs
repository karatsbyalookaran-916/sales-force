// Exercises the Prisma store's actual SQL against a real Postgres database.
//
// tests/routes.test.mjs covers the shared route logic through a fake store, which is the
// code path both hosts run — but it cannot catch a mistake in a Prisma query or a raw
// statement. This closes that gap.
//
// Skipped unless TEST_DATABASE_URL points at a THROWAWAY database. CI provides one as a
// service container. Never point it at production: the suite writes and deletes rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { prismaStore } from '../lib/store-prisma.mjs';

const url = process.env.TEST_DATABASE_URL;
const skip = url ? false : 'set TEST_DATABASE_URL to a throwaway database to run these';

test('prisma store against a real postgres database', { skip }, async t => {
  const prisma = new PrismaClient({ datasourceUrl: url });
  const store = prismaStore(prisma, Prisma);
  const made = { users: [], leads: [], mutations: [], attempts: [] };

  t.after(async () => {
    // FK-safe order. Runs even if an assertion above failed.
    await prisma.activity.deleteMany({ where: { leadId: { in: made.leads } } });
    await prisma.mutation.deleteMany({ where: { id: { in: made.mutations } } });
    await prisma.lead.deleteMany({ where: { id: { in: made.leads } } });
    await prisma.session.deleteMany({ where: { userId: { in: made.users } } });
    await prisma.adminLock.deleteMany({ where: { userId: { in: made.users } } });
    await prisma.user.deleteMany({ where: { id: { in: made.users } } });
    await prisma.loginAttempt.deleteMany({ where: { key: { in: made.attempts } } });
    await prisma.$disconnect();
  });

  await t.test('accounts', async () => {
    const member = await store.createMember({ name: 'PG Member', email: `pg-${randomUUID()}@example.invalid`, password: 'pg-password-123', role: 'member' });
    made.users.push(member.id);
    assert.equal(member.role, 'member');
    assert.equal(member.password, undefined, 'the hash never leaves the store');
    assert.equal((await store.userById(member.id)).id, member.id);
    assert.equal(await store.userById(randomUUID()), null, 'a uuid that matches nothing returns null');
  });

  await t.test('duplicate email is rejected as a 400', async () => {
    const email = `pg-dup-${randomUUID()}@example.invalid`;
    const first = await store.createMember({ name: 'First', email, password: 'pg-password-123', role: 'member' });
    made.users.push(first.id);
    await assert.rejects(
      () => store.createMember({ name: 'Second', email, password: 'pg-password-123', role: 'member' }),
      /** @param {any} error */ error => error.status === 400,
      'a unique violation must surface as a 400, not a raw driver error'
    );
  });

  await t.test('sessions round-trip and expire', async () => {
    const user = await store.createMember({ name: 'PG Session', email: `pg-${randomUUID()}@example.invalid`, password: 'pg-password-123', role: 'member' });
    made.users.push(user.id);
    const token = randomUUID().replace(/-/g, '').padEnd(64, '0');
    await store.createSession(token, user.id, new Date(Date.now() + 60000));
    assert.equal((await store.userBySession(token, new Date()))?.id, user.id);
    assert.equal(await store.userBySession(token, new Date(Date.now() + 120000)), null, 'an expired session does not authenticate');
    await store.deleteSession(token);
    assert.equal(await store.userBySession(token, new Date()), null);
  });

  await t.test('lead versioning, conflict and replay', async () => {
    const user = await store.createMember({ name: 'PG Lead', email: `pg-${randomUUID()}@example.invalid`, password: 'pg-password-123', role: 'member' });
    made.users.push(user.id);
    const leadId = randomUUID(), first = randomUUID(), second = randomUUID(), stale = randomUUID();
    made.leads.push(leadId); made.mutations.push(first, second, stale);
    const base = { id: leadId, name: 'PG Jewellers', contact: '', phone: '', email: '', location: '', stage: 'New', ownerId: '', followUp: '', notes: '' };
    const now = new Date();

    const v1 = { ...base, version: 1, updatedAt: now.toISOString(), updatedBy: user.id, createdAt: now.toISOString() };
    assert.equal(await store.commitLead({ lead: v1, mutationId: first, userId: user.id, baseVersion: 0, isNew: true, text: 'Created lead · New', now }), 'ok');
    assert.equal((await store.leadById(leadId)).version, 1);

    // Writing against a version that is no longer current must not overwrite.
    const wrong = { ...base, stage: 'Closed', version: 99, updatedAt: now.toISOString(), updatedBy: user.id, createdAt: now.toISOString() };
    assert.equal(await store.commitLead({ lead: wrong, mutationId: stale, userId: user.id, baseVersion: 98, isNew: false, text: 'x', now }), 'conflict');
    assert.equal((await store.leadById(leadId)).data.stage, 'New', 'the losing write left no trace');

    const v2 = { ...base, stage: 'Presented', version: 2, updatedAt: now.toISOString(), updatedBy: user.id, createdAt: now.toISOString() };
    assert.equal(await store.commitLead({ lead: v2, mutationId: second, userId: user.id, baseVersion: 1, isNew: false, text: 'New → Presented', now }), 'ok');
    assert.equal((await store.leadById(leadId)).version, 2);

    const receipt = await store.mutationById(first);
    assert.equal(receipt.userId, user.id, 'the receipt records who made the change, so a replay by someone else is refused');

    const rows = await store.listActivity(leadId);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].user_name, 'PG Lead', 'activity joins the user name');
    assert.doesNotThrow(() => JSON.stringify(rows), 'BigInt activity ids must survive JSON serialisation');
    assert.deepEqual(await store.listActivity('not-a-uuid'), [], 'a non-uuid must not reach the driver as a uuid comparison');
  });

  await t.test('login throttle counter is atomic', async () => {
    const key = `pg-throttle-${randomUUID()}`;
    made.attempts.push(key);
    const now = Date.now();
    const opts = { now, windowMs: 60000, max: 3 };
    assert.deepEqual(await store.recordLoginAttempt(key, opts), { allowed: true, count: 1 });
    assert.deepEqual(await store.recordLoginAttempt(key, opts), { allowed: true, count: 2 });
    assert.deepEqual(await store.recordLoginAttempt(key, opts), { allowed: true, count: 3 });
    assert.deepEqual(await store.recordLoginAttempt(key, opts), { allowed: false, count: 4 });
    assert.deepEqual(await store.recordLoginAttempt(key, { now: now + 120000, windowMs: 60000, max: 3 }), { allowed: true, count: 1 }, 'the counter restarts once the window passes');

    // Ten at once must produce ten distinct counts. A non-atomic upsert loses updates.
    const raceKey = `pg-race-${randomUUID()}`;
    made.attempts.push(raceKey);
    const race = await Promise.all(Array.from({ length: 10 }, () =>
      store.recordLoginAttempt(raceKey, { now: now + 200000, windowMs: 60000, max: 100 })));
    assert.equal(new Set(race.map(r => r.count)).size, 10, 'concurrent attempts must not lose updates');
  });

  await t.test('maintenance prunes only what is past its window', async () => {
    const key = `pg-sweep-${randomUUID()}`;
    made.attempts.push(key);
    await store.recordLoginAttempt(key, { now: Date.now() - 600000, windowMs: 1000, max: 5 });
    const deleted = await store.maintenance({
      now: new Date(), mutationsBefore: new Date(0), activityBefore: new Date(0)
    });
    assert.ok(deleted.loginAttempts >= 1, 'the stale counter is removed');
    assert.equal(typeof deleted.sessions, 'number');
    assert.equal(typeof deleted.mutations, 'number');
    assert.equal(typeof deleted.activity, 'number');
  });
});
