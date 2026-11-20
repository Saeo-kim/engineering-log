import { createServer } from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDatabase, createStore } from './db.js';
import { hashPassword, verifyPassword, newSessionToken, hashToken, RateLimiter } from './auth.js';
import { HttpError, parseId, parseEntry, parseCategoryName } from './validate.js';
import { isIsoDate, todayIso } from './dates.js';
import { applySecurityHeaders, sendJson, readJson, parseCookies, serveStatic } from './http.js';

const SESSION_COOKIE = 'elog_session';
const SESSION_DAYS = 30;
const MIN_PASSWORD_LENGTH = 12;
const DEFAULT_PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * Builds the application. Resolves once the owner account exists and is in sync
 * with APP_PASSWORD. Returns { server, close }.
 */
export async function createApp({
  databaseFile,
  username,
  password,
  cookieSecure = 'auto',
  trustProxy = false,
  publicDir = DEFAULT_PUBLIC_DIR,
}) {
  if (!username) throw new Error('APP_USERNAME is required');
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`APP_PASSWORD is required and must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const db = openDatabase(databaseFile);
  const store = createStore(db);
  const owner = await ensureOwner(store, username, password);
  const deps = {
    store,
    owner,
    cookieSecure,
    trustProxy,
    publicDir: path.resolve(publicDir),
    limiter: new RateLimiter({ max: 10, windowMs: 15 * 60 * 1000 }),
  };

  const server = createServer((req, res) => {
    handleRequest(req, res, deps);
  });
  return {
    server,
    close() {
      server.close();
      db.close();
    },
  };
}

async function ensureOwner(store, username, password) {
  let row = store.getUserByName(username);
  if (!row) {
    row = { id: randomUUID(), username, password_hash: await hashPassword(password) };
    store.insertUser(row);
  } else if (!(await verifyPassword(password, row.password_hash))) {
    // APP_PASSWORD changed: store the new hash and sign out existing sessions.
    row.password_hash = await hashPassword(password);
    store.setPasswordHash(row.id, row.password_hash);
    store.deleteUserSessions(row.id);
  }
  return { id: row.id, username: row.username, passwordHash: row.password_hash };
}

async function handleRequest(req, res, deps) {
  applySecurityHeaders(res);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url, deps);
    } else {
      await serveStatic(req, res, url, deps.publicDir);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      sendJson(res, err.status, { error: err.message });
      return;
    }
    console.error(err);
    sendJson(res, 500, { error: 'Something went wrong. Please try again.' });
  }
}

// ---------------------------------------------------------------- routing

const ROUTES = [
  { method: 'GET', pattern: /^\/api\/health$/, handler: health, auth: false },
  { method: 'POST', pattern: /^\/api\/login$/, handler: login, auth: false },
  { method: 'POST', pattern: /^\/api\/logout$/, handler: logout, auth: false },
  { method: 'GET', pattern: /^\/api\/me$/, handler: me },
  { method: 'GET', pattern: /^\/api\/categories$/, handler: listCategories },
  { method: 'POST', pattern: /^\/api\/categories$/, handler: createCategory },
  { method: 'PATCH', pattern: /^\/api\/categories\/([^/]+)$/, handler: renameCategory },
  { method: 'DELETE', pattern: /^\/api\/categories\/([^/]+)$/, handler: deleteCategory },
  { method: 'GET', pattern: /^\/api\/entries$/, handler: listEntries },
  { method: 'GET', pattern: /^\/api\/entries\/([^/]+)$/, handler: getEntry },
  { method: 'PUT', pattern: /^\/api\/entries\/([^/]+)$/, handler: putEntry },
  { method: 'DELETE', pattern: /^\/api\/entries\/([^/]+)$/, handler: deleteEntry },
  { method: 'GET', pattern: /^\/api\/stats$/, handler: stats },
  { method: 'GET', pattern: /^\/api\/export$/, handler: exportBackup },
];

async function handleApi(req, res, url, deps) {
  const method = req.method;
  const pathMatched = ROUTES.filter((r) => r.pattern.test(url.pathname));
  if (pathMatched.length === 0) throw new HttpError(404, 'Not found');
  const route = pathMatched.find((r) => r.method === method);
  if (!route) throw new HttpError(405, 'Method not allowed');

  if (method !== 'GET' && method !== 'HEAD') {
    // Defense in depth against cross-site requests, on top of SameSite=Lax cookies.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked');
  }

  const user = route.auth === false ? null : authenticate(req, deps);
  if (route.auth !== false && !user) throw new HttpError(401, 'Please sign in');

  const match = route.pattern.exec(url.pathname);
  const ctx = {
    req,
    res,
    url,
    params: match.slice(1),
    user,
    deps,
    store: deps.store,
    body: () => readJson(req),
  };
  await route.handler(ctx);
}

function authenticate(req, deps) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  return deps.store.findSession(hashToken(token), Date.now()) ?? null;
}

function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function isSecureRequest(req) {
  return Boolean(req.socket.encrypted) || req.headers['x-forwarded-proto'] === 'https';
}

function sessionCookie(req, deps, value, maxAgeSeconds) {
  const secure = deps.cookieSecure === true || (deps.cookieSecure === 'auto' && isSecureRequest(req));
  const parts = [
    `${SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

// ---------------------------------------------------------------- handlers

async function health({ res }) {
  sendJson(res, 200, { ok: true });
}

async function login(ctx) {
  const { req, res, deps } = ctx;
  const ip = clientAddress(req, deps.trustProxy);
  if (deps.limiter.isLimited(ip)) {
    throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
  }
  const body = await ctx.body();
  const username = typeof body.username === 'string' ? body.username.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';

  const ok =
    username === deps.owner.username && (await verifyPassword(password, deps.owner.passwordHash));
  if (!ok) {
    deps.limiter.fail(ip);
    throw new HttpError(401, 'Wrong username or password');
  }
  deps.limiter.reset(ip);

  const token = newSessionToken();
  const now = Date.now();
  deps.store.deleteExpiredSessions(now);
  deps.store.createSession(deps.owner.id, hashToken(token), now, now + SESSION_DAYS * 86_400_000);
  sendJson(
    res,
    200,
    { user: { username: deps.owner.username } },
    { 'Set-Cookie': sessionCookie(req, deps, token, SESSION_DAYS * 86_400) },
  );
}

async function logout({ req, res, deps }) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) deps.store.deleteSession(hashToken(token));
  sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, deps, '', 0) });
}

async function me({ res, user }) {
  sendJson(res, 200, { user: { username: user.username } });
}

async function listCategories({ res, store, user }) {
  sendJson(res, 200, { categories: store.listCategories(user.id) });
}

async function createCategory(ctx) {
  const name = parseCategoryName(await ctx.body());
  try {
    const id = ctx.store.insertCategory(ctx.user.id, name);
    sendJson(ctx.res, 201, { category: { id, name, entry_count: 0 } });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'A topic with this name already exists');
    throw err;
  }
}

async function renameCategory(ctx) {
  const id = parseId(ctx.params[0]);
  const name = parseCategoryName(await ctx.body());
  try {
    if (!ctx.store.renameCategory(ctx.user.id, id, name)) throw new HttpError(404, 'Topic not found');
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (String(err.message).includes('UNIQUE')) throw new HttpError(409, 'A topic with this name already exists');
    throw err;
  }
  sendJson(ctx.res, 200, { ok: true });
}

async function deleteCategory({ res, store, user, params }) {
  const id = parseId(params[0]);
  if (!store.deleteCategory(user.id, id)) throw new HttpError(404, 'Topic not found');
  sendJson(res, 200, { ok: true });
}

async function listEntries({ res, url, store, user }) {
  const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
  const category = url.searchParams.get('category') || '';
  const from = url.searchParams.get('from') || '';
  const to = url.searchParams.get('to') || '';
  if (from && !isIsoDate(from)) throw new HttpError(400, 'from must be a YYYY-MM-DD date');
  if (to && !isIsoDate(to)) throw new HttpError(400, 'to must be a YYYY-MM-DD date');

  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '30', 10) || 30, 1), 100);
  const offset = Math.max(Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

  const filters = {
    terms: q.split(/\s+/).filter(Boolean).slice(0, 8),
    uncategorized: category === 'none',
    categoryId: category && category !== 'none' ? parseId(category) : null,
    from: from || null,
    to: to || null,
    limit,
    offset,
  };
  sendJson(res, 200, store.listEntries(user.id, filters));
}

async function getEntry({ res, store, user, params }) {
  const id = parseId(params[0]);
  const entry = store.getEntry(user.id, id);
  if (!entry) throw new HttpError(404, 'Note not found');
  sendJson(res, 200, { entry });
}

async function putEntry(ctx) {
  const id = parseId(ctx.params[0]);
  const fields = parseEntry(await ctx.body());
  if (fields.category_id && !ctx.store.categoryExists(ctx.user.id, fields.category_id)) {
    throw new HttpError(400, 'Unknown topic');
  }
  const result = ctx.store.upsertEntry(ctx.user.id, { id, ...fields });
  if (result === 'forbidden') throw new HttpError(404, 'Note not found');
  sendJson(ctx.res, 200, { entry: ctx.store.getEntry(ctx.user.id, id) });
}

async function deleteEntry({ res, store, user, params }) {
  const id = parseId(params[0]);
  if (!store.deleteEntry(user.id, id)) throw new HttpError(404, 'Note not found');
  sendJson(res, 200, { ok: true });
}

async function stats({ res, url, store, user }) {
  const today = url.searchParams.get('today');
  if (today && !isIsoDate(today)) throw new HttpError(400, 'today must be a YYYY-MM-DD date');
  sendJson(res, 200, store.stats(user.id, today || todayIso()));
}

async function exportBackup({ res, store, user }) {
  const date = todayIso();
  sendJson(
    res,
    200,
    { app: 'engineering-log', exported_at: new Date().toISOString(), ...store.exportAll(user.id) },
    { 'Content-Disposition': `attachment; filename="engineering-log-backup-${date}.json"` },
  );
}
