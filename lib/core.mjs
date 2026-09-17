// Shared primitives for both hosts. No HTTP framework and no database driver here.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const STAGES = ['New', 'Contacted', 'Presented', 'Interested', 'Negotiating', 'Joined', 'Closed'];
export const LEAD_FIELDS = { name: 150, contact: 150, phone: 60, email: 200, location: 300, notes: 10000, followUp: 10, ownerId: 80, stage: 30 };
export const SESSION_MS = 7 * 86400000;
export const MAX_BODY_BYTES = 100000;

// Retention windows applied by the maintenance route. Mutation receipts only guard
// against a retried request, which resolves in minutes, so they need days rather than
// years. Activity is team-visible history, so it is kept far longer.
export const MUTATION_RETENTION_MS = 30 * 86400000;
export const ACTIVITY_RETENTION_MS = 365 * 86400000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const isUuid = value => typeof value === 'string' && UUID.test(value);
export const isSessionToken = value => /^[a-f0-9]{64}$/.test(value || '');

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

// Shared by both adapters. Previously each parsed cookies itself, and the hosted copy
// built its pattern from a template literal where \s is not a valid escape — it collapsed
// to a literal "s", so the session cookie was unreadable whenever it was not the first
// one in the header. Browsers separate cookies with "; ", so that was most of the time.
export function readCookie(header, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Whitespace is allowed after the start of the header as well as after a separator.
  return new RegExp(`(?:^|;)\\s*${escaped}=([^;]*)`).exec(header || '')?.[1] || '';
}

export const digest = value => createHash('sha256').update(value).digest('hex');
export const newSessionToken = () => randomBytes(32).toString('hex');
export const publicUser = ({ id, name, email, role }) => ({ id, name, email, role });

export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(password, salt, 64).toString('hex');
}
export function passwordMatches(password, hash) {
  const [salt, expected = ''] = String(hash).split(':');
  const actual = scryptSync(password, salt, 64);
  const bytes = Buffer.from(expected, 'hex');
  return bytes.length === actual.length && timingSafeEqual(actual, bytes);
}
// Compared against when no user matches, so a missing account costs the same time as a wrong password.
export const DUMMY_HASH = passwordHash(randomBytes(32).toString('hex'));

// Constant-time compare for shared secrets. Hashing first keeps the comparison at a
// fixed length, so an attacker learns nothing from timing or from a length mismatch.
export function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || !expected) return false;
  return timingSafeEqual(createHash('sha256').update(provided).digest(), createHash('sha256').update(expected).digest());
}

export function validateAccount(body, role = 'member') {
  if (typeof body?.name !== 'string' || !body.name.trim() || body.name.length > 100
    || typeof body.email !== 'string' || !EMAIL.test(body.email) || body.email.length > 200
    || typeof body.password !== 'string' || body.password.length < 6 || body.password.length > 256
    || !['admin', 'member'].includes(role)) fail(400, 'Enter a name, a valid email, and a password of 6–256 characters.');
  return { name: body.name.trim(), email: body.email.trim().toLowerCase(), password: body.password, role };
}

export function validateLead(lead) {
  const clean = { id: lead.id };
  for (const [key, max] of Object.entries(LEAD_FIELDS)) {
    if (typeof lead[key] !== 'string' || lead[key].length > max) fail(400, `Invalid ${key}`);
    clean[key] = lead[key].trim();
  }
  if (!clean.name || !STAGES.includes(clean.stage)
    || (clean.email && !EMAIL.test(clean.email))
    || (clean.followUp && (!/^\d{4}-\d{2}-\d{2}$/.test(clean.followUp) || !Number.isFinite(Date.parse(clean.followUp)))))
    fail(400, 'Check the business name, stage, email and follow-up date');
  return clean;
}

// Login throttling. The counter lives in the database rather than in process memory,
// because serverless instances do not share memory and an in-process counter would give
// an attacker the full allowance against each instance separately.
export const LOGIN_MAX_ATTEMPTS = 30;
export const LOGIN_WINDOW_MS = 900000;
