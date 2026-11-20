import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

const USER = 'owner';
const PASSWORD = 'correct horse battery';

let app;
let base;
let cookie = '';

async function call(method, url, body, { auth = true } = {}) {
  const headers = {};
  if (auth && cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(base + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data, headers: res.headers };
}

const sampleEntry = (overrides = {}) => ({
  entry_date: '2026-11-20',
  title: 'Spring transactions',
  subject: 'Spring Boot',
  learned: '@Transactional wraps the method in a proxy',
  not_understood: 'why self-invocation skips it',
  questions: 'Does it work with private methods?',
  code: 'class A { void f() {} }',
  references: 'https://docs.spring.io/',
  thoughts: 'Proxies are the root of many surprises',
  is_draft: false,
  category_id: null,
  ...overrides,
});

before(async () => {
  app = await createApp({
    databaseFile: ':memory:',
    username: USER,
    password: PASSWORD,
    cookieSecure: false,
    publicDir: new URL('../public', import.meta.url).pathname,
  });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(() => app.close());

describe('authentication', () => {
  test('health is public', async () => {
    const r = await call('GET', '/api/health', undefined, { auth: false });
    assert.equal(r.status, 200);
    assert.equal(r.data.ok, true);
  });

  test('protected endpoints reject anonymous requests', async () => {
    assert.equal((await call('GET', '/api/me', undefined, { auth: false })).status, 401);
    assert.equal((await call('GET', '/api/entries', undefined, { auth: false })).status, 401);
    assert.equal((await call('GET', '/api/categories', undefined, { auth: false })).status, 401);
  });

  test('wrong password is rejected', async () => {
    const r = await call('POST', '/api/login', { username: USER, password: 'nope nope nope' }, { auth: false });
    assert.equal(r.status, 401);
  });

  test('wrong username is rejected even with the right password', async () => {
    const r = await call('POST', '/api/login', { username: 'someone', password: PASSWORD }, { auth: false });
    assert.equal(r.status, 401);
  });

  test('login sets an HttpOnly, SameSite=Lax session cookie', async () => {
    const r = await call('POST', '/api/login', { username: USER, password: PASSWORD }, { auth: false });
    assert.equal(r.status, 200);
    const setCookie = r.headers.get('set-cookie');
    assert.match(setCookie, /^elog_session=/);
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Lax/);
    cookie = setCookie.split(';')[0];
  });

  test('session works on /api/me', async () => {
    const r = await call('GET', '/api/me');
    assert.equal(r.status, 200);
    assert.equal(r.data.user.username, USER);
  });

  test('write requests without a JSON content type are refused (CSRF guard)', async () => {
    const res = await fetch(`${base}/api/categories`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'text/plain' },
      body: JSON.stringify({ name: 'Sneaky' }),
    });
    assert.equal(res.status, 415);
  });

  test('cross-site origin is refused for writes', async () => {
    const res = await fetch(`${base}/api/categories`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ name: 'Sneaky' }),
    });
    assert.equal(res.status, 403);
  });
});

describe('topics', () => {
  let topicId;

  test('create, list, rename, and reject duplicates', async () => {
    const created = await call('POST', '/api/categories', { name: '  SQL  ' });
    assert.equal(created.status, 201);
    assert.equal(created.data.category.name, 'SQL');
    topicId = created.data.category.id;

    const dup = await call('POST', '/api/categories', { name: 'sql' });
    assert.equal(dup.status, 409, 'names are case-insensitive unique');

    const list = await call('GET', '/api/categories');
    assert.equal(list.data.categories.length, 1);

    const renamed = await call('PATCH', `/api/categories/${topicId}`, { name: 'Databases' });
    assert.equal(renamed.status, 200);
    const again = await call('GET', '/api/categories');
    assert.equal(again.data.categories[0].name, 'Databases');
  });

  test('empty name is rejected', async () => {
    const r = await call('POST', '/api/categories', { name: '   ' });
    assert.equal(r.status, 400);
  });

  test('deleting a topic keeps its notes and clears the topic', async () => {
    const id = (await call('POST', '/api/categories', { name: 'Temp' })).data.category.id;
    const noteId = 'note-topic-delete-1';
    assert.equal((await call('PUT', `/api/entries/${noteId}`, sampleEntry({ category_id: id }))).status, 200);

    assert.equal((await call('DELETE', `/api/categories/${id}`)).status, 200);
    const note = await call('GET', `/api/entries/${noteId}`);
    assert.equal(note.status, 200, 'note must survive topic deletion');
    assert.equal(note.data.entry.category_id, null);
  });
});

describe('entries', () => {
  const id = 'entry-aaaa-1111';

  test('create with PUT (client-generated id) and read back', async () => {
    const r = await call('PUT', `/api/entries/${id}`, sampleEntry());
    assert.equal(r.status, 200);
    assert.equal(r.data.entry.id, id);
    assert.equal(r.data.entry.references, 'https://docs.spring.io/');

    const got = await call('GET', `/api/entries/${id}`);
    assert.equal(got.data.entry.learned, '@Transactional wraps the method in a proxy');
    assert.equal(got.data.entry.code, 'class A { void f() {} }');
  });

  test('update keeps created_at and changes content', async () => {
    const before = (await call('GET', `/api/entries/${id}`)).data.entry;
    await new Promise((r) => setTimeout(r, 5));
    const r = await call('PUT', `/api/entries/${id}`, sampleEntry({ thoughts: 'edited later' }));
    assert.equal(r.data.entry.thoughts, 'edited later');
    assert.equal(r.data.entry.created_at, before.created_at);
    assert.notEqual(r.data.entry.updated_at, before.updated_at);
  });

  test('only title/date are needed; every other field is optional', async () => {
    const minimal = { entry_date: '2026-11-21' };
    const r = await call('PUT', '/api/entries/entry-minimal-2', minimal);
    assert.equal(r.status, 200);
    assert.equal(r.data.entry.title, '');
    assert.equal(r.data.entry.category_id, null);
  });

  test('invalid date and unknown topic are rejected', async () => {
    assert.equal((await call('PUT', '/api/entries/entry-bad-date', { entry_date: '2026-02-31' })).status, 400);
    assert.equal((await call('PUT', '/api/entries/entry-bad-date', { entry_date: 'yesterday' })).status, 400);
    const r = await call('PUT', '/api/entries/entry-bad-topic', sampleEntry({ category_id: 'nonexistentid' }));
    assert.equal(r.status, 400);
  });

  test('oversized field is rejected', async () => {
    const r = await call('PUT', '/api/entries/entry-big-1', sampleEntry({ learned: 'x'.repeat(20001) }));
    assert.equal(r.status, 400);
  });

  test('delete removes the note; deleting again is 404', async () => {
    await call('PUT', '/api/entries/entry-del-1', sampleEntry({ title: 'to delete' }));
    assert.equal((await call('DELETE', '/api/entries/entry-del-1')).status, 200);
    assert.equal((await call('GET', '/api/entries/entry-del-1')).status, 404);
    assert.equal((await call('DELETE', '/api/entries/entry-del-1')).status, 404);
  });

  test('search matches title and body text, case-insensitively, and combines words', async () => {
    await call('PUT', '/api/entries/entry-search-1', sampleEntry({ title: 'Kafka partitions', learned: 'Consumers read in order per partition' }));
    await call('PUT', '/api/entries/entry-search-2', sampleEntry({ title: 'Redis', learned: 'Caching with TTL' }));

    const byTitle = await call('GET', '/api/entries?q=kafka');
    assert.ok(byTitle.data.entries.some((e) => e.id === 'entry-search-1'));
    assert.ok(!byTitle.data.entries.some((e) => e.id === 'entry-search-2'));

    const byBody = await call('GET', '/api/entries?q=TTL');
    assert.deepEqual(byBody.data.entries.map((e) => e.id), ['entry-search-2']);

    const both = await call('GET', '/api/entries?q=partition%20order');
    assert.deepEqual(both.data.entries.map((e) => e.id), ['entry-search-1']);

    const none = await call('GET', '/api/entries?q=zzzznotfound');
    assert.equal(none.data.entries.length, 0);
  });

  test('LIKE wildcards in the query are treated literally', async () => {
    await call('PUT', '/api/entries/entry-wild-1', sampleEntry({ title: 'Plain title' }));
    const r = await call('GET', '/api/entries?q=' + encodeURIComponent('%'));
    assert.equal(r.data.entries.length, 0);
  });

  test('filter by date range and by topic / uncategorized', async () => {
    const topic = (await call('POST', '/api/categories', { name: 'Filter topic' })).data.category.id;
    await call('PUT', '/api/entries/entry-f-1', sampleEntry({ entry_date: '2026-03-01', category_id: topic, title: 'March' }));
    await call('PUT', '/api/entries/entry-f-2', sampleEntry({ entry_date: '2026-04-01', title: 'April' }));

    const march = await call('GET', '/api/entries?from=2026-03-01&to=2026-03-31');
    assert.deepEqual(march.data.entries.map((e) => e.title), ['March']);

    const byTopic = await call('GET', `/api/entries?category=${topic}`);
    assert.deepEqual(byTopic.data.entries.map((e) => e.title), ['March']);

    const uncat = await call('GET', '/api/entries?category=none&from=2026-04-01&to=2026-04-30');
    assert.ok(uncat.data.entries.every((e) => e.category_id === null));
    assert.ok(uncat.data.entries.some((e) => e.title === 'April'));
  });

  test('pagination reports hasMore', async () => {
    for (let i = 0; i < 3; i += 1) {
      await call('PUT', `/api/entries/entry-page-${i}`, sampleEntry({ entry_date: '2025-01-0' + (i + 1), title: 'page ' + i }));
    }
    const first = await call('GET', '/api/entries?q=page&limit=2&offset=0');
    assert.equal(first.data.entries.length, 2);
    assert.equal(first.data.hasMore, true);
    const second = await call('GET', '/api/entries?q=page&limit=2&offset=2');
    assert.equal(second.data.entries.length, 1);
    assert.equal(second.data.hasMore, false);
  });
});

describe('stats and export', () => {
  test('stats reflect actual entries only', async () => {
    const r = await call('GET', '/api/stats?today=2026-11-20');
    assert.equal(r.status, 200);
    assert.ok(r.data.total > 0);
    assert.ok(Array.isArray(r.data.by_month));
    assert.ok(Array.isArray(r.data.by_category));
    assert.ok(r.data.streak_days >= 0);
    assert.equal(typeof r.data.days_with_entries, 'number');
  });

  test('streak counts consecutive days ending today', async () => {
    const id = 'streak-user-2';
    // A separate app instance keeps this isolated from the other tests' data.
    const fresh = await createApp({
      databaseFile: ':memory:',
      username: 'streak',
      password: PASSWORD,
      cookieSecure: false,
      publicDir: new URL('../public', import.meta.url).pathname,
    });
    await new Promise((resolve) => fresh.server.listen(0, '127.0.0.1', resolve));
    const b = `http://127.0.0.1:${fresh.server.address().port}`;
    try {
      const login = await fetch(`${b}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'streak', password: PASSWORD }),
      });
      const c = login.headers.get('set-cookie').split(';')[0];
      const put = (eid, date) =>
        fetch(`${b}/api/entries/${eid}`, {
          method: 'PUT',
          headers: { cookie: c, 'content-type': 'application/json' },
          body: JSON.stringify(sampleEntry({ entry_date: date, title: eid })),
        });
      await put(id + '-a', '2026-11-18');
      await put(id + '-b', '2026-11-19');
      await put(id + '-c', '2026-11-20');
      await put(id + '-d', '2026-11-10');
      const stats = await (await fetch(`${b}/api/stats?today=2026-11-20`, { headers: { cookie: c } })).json();
      assert.equal(stats.streak_days, 3);
      assert.equal(stats.days_with_entries, 4);
      assert.equal(stats.last_7_days, 3);
      assert.equal(stats.last_entry_date, '2026-11-20');
    } finally {
      fresh.close();
    }
  });

  test('backup export includes all notes and topics as an attachment', async () => {
    const r = await call('GET', '/api/export');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /attachment; filename="engineering-log-backup-/);
    assert.ok(Array.isArray(r.data.entries));
    assert.ok(Array.isArray(r.data.categories));
  });
});

describe('logout', () => {
  test('logout invalidates the session', async () => {
    const login = await call('POST', '/api/login', { username: USER, password: PASSWORD }, { auth: false });
    const c = login.headers.get('set-cookie').split(';')[0];
    const out = await fetch(`${base}/api/logout`, {
      method: 'POST',
      headers: { cookie: c, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(out.status, 200);
    const after = await fetch(`${base}/api/me`, { headers: { cookie: c } });
    assert.equal(after.status, 401);
  });
});

describe('static files', () => {
  test('serves the app shell with security headers', async () => {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });

  test('path traversal is blocked', async () => {
    const res = await fetch(base + '/..%2F..%2Fpackage.json');
    assert.equal(res.status, 404);
    const res2 = await fetch(base + '/%2e%2e/src/server.js');
    assert.equal(res2.status, 404);
  });
});
