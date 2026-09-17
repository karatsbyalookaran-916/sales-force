// Local/offline store. Synchronous driver wrapped in the async store interface.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { passwordHash, validateAccount, fail } from './core.mjs';

export function openDatabase(path = process.env.KARATS_DB || resolve('data/karats.sqlite')) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member')));
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS leads (id TEXT PRIMARY KEY, data TEXT NOT NULL, version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mutations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, lead_id TEXT NOT NULL, user_id TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS one_administrator ON users(role) WHERE role='admin';
  `);
  // CREATE TABLE IF NOT EXISTS leaves existing databases untouched, so added columns
  // need an explicit check. Rows predating the column keep '' and are pruned on the
  // first maintenance run, which is correct: they are far older than the window.
  // This must run before the indexes below, which reference the new column.
  if (!db.prepare('PRAGMA table_info(mutations)').all().some(column => column.name === 'created_at'))
    db.exec("ALTER TABLE mutations ADD COLUMN created_at TEXT NOT NULL DEFAULT ''");
  db.exec(`CREATE INDEX IF NOT EXISTS mutations_created_at ON mutations(created_at);
    CREATE INDEX IF NOT EXISTS activity_created_at ON activity(created_at);
  `);
  return db;
}

function insertUser(db, account) {
  const user = { id: randomUUID(), name: account.name, email: account.email, role: account.role };
  try {
    db.prepare('INSERT INTO users VALUES (?,?,?,?,?)').run(user.id, user.name, user.email, passwordHash(account.password), user.role);
  } catch (error) {
    if (!/UNIQUE/i.test(error.message)) throw error;
    fail(/one_administrator/.test(error.message) ? 403 : 400,
      /one_administrator/.test(error.message) ? 'The administrator account already exists' : 'This email already has an account');
  }
  return user;
}

// Kept for tests and `npm run create-admin`, which hold a raw db handle.
export function createUser(db, { name, email, password, role = 'member' }) {
  return insertUser(db, validateAccount({ name, email, password }, role));
}

export function sqliteStore(db) {
  return {
    async hasAnyUser() { return !!db.prepare('SELECT id FROM users LIMIT 1').get(); },
    async createAdmin(account) { return insertUser(db, account); },
    async createMember(account) { return insertUser(db, account); },
    async userByEmail(email) { return db.prepare('SELECT * FROM users WHERE email=?').get(email) || null; },
    async userById(id) { return db.prepare('SELECT * FROM users WHERE id=?').get(id) || null; },
    async listUsers() { return db.prepare('SELECT id,name,email,role FROM users ORDER BY name').all(); },

    async createSession(token, userId, expires) { db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(token, userId, expires.getTime()); },
    async userBySession(token, now) {
      return db.prepare('SELECT users.* FROM users JOIN sessions ON sessions.user_id=users.id WHERE token=? AND expires>?').get(token, now.getTime()) || null;
    },
    async deleteSession(token) { db.prepare('DELETE FROM sessions WHERE token=?').run(token); },

    // One atomic statement, so two simultaneous attempts cannot both read the old count.
    async recordLoginAttempt(key, { now, windowMs, max }) {
      const row = db.prepare(`INSERT INTO login_attempts (key,count,until) VALUES (?,1,?)
        ON CONFLICT(key) DO UPDATE SET
          count = CASE WHEN login_attempts.until < ? THEN 1 ELSE login_attempts.count + 1 END,
          until = CASE WHEN login_attempts.until < ? THEN ? ELSE login_attempts.until END
        RETURNING count`).get(key, now + windowMs, now, now, now + windowMs);
      return { allowed: row.count <= max, count: row.count };
    },

    async maintenance({ now, mutationsBefore, activityBefore }) {
      return {
        sessions: Number(db.prepare('DELETE FROM sessions WHERE expires < ?').run(now.getTime()).changes),
        mutations: Number(db.prepare('DELETE FROM mutations WHERE created_at < ?').run(mutationsBefore.toISOString()).changes),
        activity: Number(db.prepare('DELETE FROM activity WHERE created_at < ?').run(activityBefore.toISOString()).changes),
        loginAttempts: Number(db.prepare('DELETE FROM login_attempts WHERE until < ?').run(now.getTime()).changes)
      };
    },

    async listLeads() { return db.prepare('SELECT data FROM leads').all().map(row => JSON.parse(row.data)); },
    async leadById(id) {
      const row = db.prepare('SELECT data,version FROM leads WHERE id=?').get(id);
      return row ? { data: JSON.parse(row.data), version: row.version } : null;
    },
    async mutationById(id) {
      const row = db.prepare('SELECT user_id,result FROM mutations WHERE id=?').get(id);
      return row ? { userId: row.user_id, result: JSON.parse(row.result) } : null;
    },
    async listActivity(leadId) {
      return db.prepare('SELECT activity.*,users.name AS user_name FROM activity JOIN users ON users.id=activity.user_id WHERE lead_id=? ORDER BY id DESC LIMIT 100').all(leadId);
    },

    async commitLead({ lead, mutationId, userId, baseVersion, isNew, text }) {
      db.exec('BEGIN IMMEDIATE');
      try {
        if (isNew) {
          db.prepare('INSERT INTO leads VALUES (?,?,?)').run(lead.id, JSON.stringify(lead), lead.version);
        } else {
          // Re-checked inside the transaction so a concurrent writer cannot slip between read and write.
          const changed = db.prepare('UPDATE leads SET data=?,version=? WHERE id=? AND version=?')
            .run(JSON.stringify(lead), lead.version, lead.id, baseVersion);
          if (changed.changes !== 1) { db.exec('ROLLBACK'); return 'conflict'; }
        }
        db.prepare('INSERT INTO mutations (id,user_id,result,created_at) VALUES (?,?,?,?)').run(mutationId, userId, JSON.stringify(lead), lead.updatedAt);
        db.prepare('INSERT INTO activity (lead_id,user_id,text,created_at) VALUES (?,?,?,?)').run(lead.id, userId, text, lead.updatedAt);
        db.exec('COMMIT');
        return 'ok';
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
  };
}
