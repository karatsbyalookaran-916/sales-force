// Hosted store. Same interface as the SQLite store, backed by Postgres through Prisma.
import { passwordHash, publicUser, fail } from './core.mjs';

export function prismaStore(prisma, Prisma) {
  const account = a => ({ name: a.name, email: a.email, password: passwordHash(a.password), role: a.role });

  return {
    async hasAnyUser() { return !!(await prisma.user.findFirst({ select: { id: true } })); },
    async hasAdminLock() { return !!(await prisma.adminLock.findUnique({ where: { id: 1 } })); },

    async createAdmin(a) {
      try {
        return await prisma.$transaction(async tx => {
          if (await tx.adminLock.findUnique({ where: { id: 1 } })) fail(403, 'The administrator account already exists');
          const user = await tx.user.create({ data: account({ ...a, role: 'admin' }) });
          await tx.adminLock.create({ data: { id: 1, userId: user.id } });
          return publicUser(user);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error.status) throw error;
        // P2002 unique violation, P2034 serialization failure: both mean someone else won the race.
        if (error.code === 'P2002' || error.code === 'P2034') fail(403, 'The administrator account already exists');
        throw error;
      }
    },
    async createMember(a) {
      try { return publicUser(await prisma.user.create({ data: account({ ...a, role: 'member' }) })); }
      catch (error) { if (error.code === 'P2002') fail(400, 'This email already has an account'); throw error; }
    },

    async userByEmail(email) { return prisma.user.findUnique({ where: { email } }); },
    async userById(id) { return prisma.user.findUnique({ where: { id } }); },
    async listUsers() { return prisma.user.findMany({ select: { id: true, name: true, email: true, role: true }, orderBy: { name: 'asc' } }); },

    async createSession(token, userId, expires) { await prisma.session.create({ data: { token, userId, expires } }); },
    async userBySession(token, now) {
      const session = await prisma.session.findFirst({ where: { token, expires: { gt: now } }, include: { user: true } });
      return session?.user || null;
    },
    async deleteSession(token) { await prisma.session.deleteMany({ where: { token } }); },

    // One atomic statement, so two simultaneous attempts cannot both read the old count.
    async recordLoginAttempt(key, { now, windowMs, max }) {
      const expiry = new Date(now + windowMs), at = new Date(now);
      const rows = await prisma.$queryRaw`
        INSERT INTO login_attempts ("key", "count", "until") VALUES (${key}, 1, ${expiry})
        ON CONFLICT ("key") DO UPDATE SET
          "count" = CASE WHEN login_attempts."until" < ${at} THEN 1 ELSE login_attempts."count" + 1 END,
          "until" = CASE WHEN login_attempts."until" < ${at} THEN ${expiry} ELSE login_attempts."until" END
        RETURNING "count"`;
      const count = Number(rows[0].count);
      return { allowed: count <= max, count };
    },

    async maintenance({ now, mutationsBefore, activityBefore }) {
      const [sessions, mutations, activity, loginAttempts] = await Promise.all([
        prisma.session.deleteMany({ where: { expires: { lt: now } } }),
        prisma.mutation.deleteMany({ where: { createdAt: { lt: mutationsBefore } } }),
        prisma.activity.deleteMany({ where: { createdAt: { lt: activityBefore } } }),
        prisma.loginAttempt.deleteMany({ where: { until: { lt: now } } })
      ]);
      return { sessions: sessions.count, mutations: mutations.count, activity: activity.count, loginAttempts: loginAttempts.count };
    },

    async listLeads() { return (await prisma.lead.findMany({ select: { data: true } })).map(row => row.data); },
    async leadById(id) { return prisma.lead.findUnique({ where: { id } }); },
    async mutationById(id) {
      const row = await prisma.mutation.findUnique({ where: { id } });
      return row ? { userId: row.userId, result: row.result } : null;
    },
    async listActivity(leadId) {
      // A non-uuid id is a driver error on a uuid column, so an unmatched lead returns nothing instead.
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(leadId)) return [];
      const rows = await prisma.activity.findMany({
        where: { leadId }, include: { user: { select: { name: true } } }, orderBy: { id: 'desc' }, take: 100
      });
      // id is BigInt and would throw in JSON.stringify; the shape matches the SQLite store's rows.
      return rows.map(row => ({ id: row.id.toString(), lead_id: row.leadId, user_id: row.userId, text: row.text, created_at: row.createdAt, user_name: row.user.name }));
    },

    async commitLead({ lead, mutationId, userId, baseVersion, isNew, text, now }) {
      try {
        await prisma.$transaction(async tx => {
          if (isNew) {
            await tx.lead.create({ data: { id: lead.id, data: lead, version: lead.version } });
          } else {
            const changed = await tx.lead.updateMany({ where: { id: lead.id, version: baseVersion }, data: { data: lead, version: lead.version } });
            if (changed.count !== 1) fail(409, 'conflict');
          }
          await tx.mutation.create({ data: { id: mutationId, userId, result: lead, createdAt: now } });
          await tx.activity.create({ data: { leadId: lead.id, userId, text, createdAt: now } });
        });
      } catch (error) {
        if (error.status === 409) return 'conflict';
        throw error;
      }
      return 'ok';
    }
  };
}
