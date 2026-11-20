import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { addDays } from './dates.js';

// Append-only list of schema migrations. Never edit a migration that has shipped;
// add a new entry instead. PRAGMA user_version records how many have run.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE categories (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL COLLATE NOCASE,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (user_id, name)
  );

  CREATE TABLE entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
    title TEXT NOT NULL DEFAULT '',
    entry_date TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',
    learned TEXT NOT NULL DEFAULT '',
    not_understood TEXT NOT NULL DEFAULT '',
    questions TEXT NOT NULL DEFAULT '',
    code TEXT NOT NULL DEFAULT '',
    refs TEXT NOT NULL DEFAULT '',
    thoughts TEXT NOT NULL DEFAULT '',
    is_draft INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX entries_user_date ON entries(user_id, entry_date);
  CREATE INDEX entries_user_category ON entries(user_id, category_id);
  `,
];

// Columns searched by free-text search.
const SEARCH_COLUMNS = ['title', 'subject', 'learned', 'not_understood', 'questions', 'code', 'refs', 'thoughts'];

export function openDatabase(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let version = current; version < MIGRATIONS.length; version += 1) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

const nowIso = () => new Date().toISOString();
const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

function toEntry(row) {
  return {
    id: row.id,
    title: row.title,
    entry_date: row.entry_date,
    category_id: row.category_id,
    subject: row.subject,
    learned: row.learned,
    not_understood: row.not_understood,
    questions: row.questions,
    code: row.code,
    references: row.refs,
    thoughts: row.thoughts,
    is_draft: row.is_draft === 1,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function streakEndingToday(daySet, today) {
  let streak = 0;
  let cursor = daySet.has(today) ? today : addDays(today, -1);
  while (daySet.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export function createStore(db) {
  const cache = new Map();
  const stmt = (sql) => {
    let prepared = cache.get(sql);
    if (!prepared) {
      prepared = db.prepare(sql);
      cache.set(sql, prepared);
    }
    return prepared;
  };
  const one = (sql, ...params) => stmt(sql).get(...params);
  const all = (sql, ...params) => stmt(sql).all(...params);

  return {
    // ----- users & sessions
    getUserByName(username) {
      return one('SELECT id, username, password_hash FROM users WHERE username = ?', username);
    },
    insertUser({ id, username, password_hash }) {
      stmt('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)').run(
        id,
        username,
        password_hash,
        nowIso(),
      );
    },
    setPasswordHash(userId, hash) {
      stmt('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
    },
    deleteUserSessions(userId) {
      stmt('DELETE FROM sessions WHERE user_id = ?').run(userId);
    },
    createSession(userId, tokenHash, now, expiresAt) {
      stmt('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
        tokenHash,
        userId,
        now,
        expiresAt,
      );
    },
    findSession(tokenHash, now) {
      return one(
        `SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
        tokenHash,
        now,
      );
    },
    deleteSession(tokenHash) {
      stmt('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    },
    deleteExpiredSessions(now) {
      stmt('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    },

    // ----- categories (topics)
    listCategories(userId) {
      return all(
        `SELECT c.id, c.name, c.created_at, c.updated_at,
                (SELECT COUNT(*) FROM entries e WHERE e.category_id = c.id AND e.user_id = c.user_id) AS entry_count
         FROM categories c WHERE c.user_id = ? ORDER BY c.name COLLATE NOCASE`,
        userId,
      );
    },
    categoryExists(userId, categoryId) {
      return Boolean(one('SELECT 1 FROM categories WHERE id = ? AND user_id = ?', categoryId, userId));
    },
    insertCategory(userId, name) {
      const id = randomUUID();
      const now = nowIso();
      stmt('INSERT INTO categories (id, user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
        id,
        userId,
        name,
        now,
        now,
      );
      return id;
    },
    renameCategory(userId, categoryId, name) {
      return stmt('UPDATE categories SET name = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(
        name,
        nowIso(),
        categoryId,
        userId,
      ).changes;
    },
    deleteCategory(userId, categoryId) {
      // entries.category_id is ON DELETE SET NULL, so notes are kept and become uncategorized.
      return stmt('DELETE FROM categories WHERE id = ? AND user_id = ?').run(categoryId, userId).changes;
    },

    // ----- entries
    listEntries(userId, { terms = [], categoryId = null, uncategorized = false, from = null, to = null, limit, offset }) {
      const where = ['user_id = ?'];
      const params = [userId];
      for (const term of terms) {
        const pattern = `%${escapeLike(term)}%`;
        where.push(`(${SEARCH_COLUMNS.map((col) => `${col} LIKE ? ESCAPE '\\'`).join(' OR ')})`);
        params.push(...SEARCH_COLUMNS.map(() => pattern));
      }
      if (uncategorized) {
        where.push('category_id IS NULL');
      } else if (categoryId) {
        where.push('category_id = ?');
        params.push(categoryId);
      }
      if (from) {
        where.push('entry_date >= ?');
        params.push(from);
      }
      if (to) {
        where.push('entry_date <= ?');
        params.push(to);
      }
      params.push(limit + 1, offset);
      // Dynamic SQL, so prepared directly instead of going through the statement cache.
      const rows = db
        .prepare(
          `SELECT * FROM entries WHERE ${where.join(' AND ')}
           ORDER BY entry_date DESC, updated_at DESC LIMIT ? OFFSET ?`,
        )
        .all(...params);
      return { entries: rows.slice(0, limit).map(toEntry), hasMore: rows.length > limit };
    },
    getEntry(userId, entryId) {
      const row = one('SELECT * FROM entries WHERE id = ? AND user_id = ?', entryId, userId);
      return row ? toEntry(row) : null;
    },
    /** Insert or update a full entry. Returns 'forbidden' if the id belongs to another user. */
    upsertEntry(userId, entry) {
      const existing = one('SELECT user_id FROM entries WHERE id = ?', entry.id);
      if (existing && existing.user_id !== userId) return 'forbidden';
      const values = [
        entry.category_id,
        entry.title,
        entry.entry_date,
        entry.subject,
        entry.learned,
        entry.not_understood,
        entry.questions,
        entry.code,
        entry.references,
        entry.thoughts,
        entry.is_draft ? 1 : 0,
      ];
      const now = nowIso();
      if (!existing) {
        stmt(
          `INSERT INTO entries (id, user_id, category_id, title, entry_date, subject, learned, not_understood,
             questions, code, refs, thoughts, is_draft, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(entry.id, userId, ...values, now, now);
      } else {
        stmt(
          `UPDATE entries SET category_id = ?, title = ?, entry_date = ?, subject = ?, learned = ?,
             not_understood = ?, questions = ?, code = ?, refs = ?, thoughts = ?, is_draft = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`,
        ).run(...values, now, entry.id, userId);
      }
      return 'ok';
    },
    deleteEntry(userId, entryId) {
      return stmt('DELETE FROM entries WHERE id = ? AND user_id = ?').run(entryId, userId).changes;
    },

    // ----- history / progress
    stats(userId, today) {
      const totals = one(
        `SELECT COUNT(*) AS total, COALESCE(SUM(is_draft), 0) AS drafts,
                COUNT(DISTINCT entry_date) AS days, COUNT(CASE WHEN category_id IS NULL THEN 1 END) AS uncategorized
         FROM entries WHERE user_id = ?`,
        userId,
      );
      const lastSevenDays = one(
        'SELECT COUNT(*) AS n FROM entries WHERE user_id = ? AND entry_date BETWEEN ? AND ?',
        userId,
        addDays(today, -6),
        today,
      ).n;
      const dayRows = all('SELECT DISTINCT entry_date AS d FROM entries WHERE user_id = ?', userId);
      const daySet = new Set(dayRows.map((r) => r.d));
      const byMonth = all(
        `SELECT substr(entry_date, 1, 7) AS month, COUNT(*) AS n FROM entries
         WHERE user_id = ? GROUP BY month ORDER BY month DESC`,
        userId,
      );
      const byCategory = all(
        `SELECT c.id, c.name, COUNT(e.id) AS n FROM categories c
         LEFT JOIN entries e ON e.category_id = c.id
         WHERE c.user_id = ? GROUP BY c.id ORDER BY n DESC, c.name COLLATE NOCASE`,
        userId,
      );
      const sortedDays = [...daySet].sort();
      return {
        total: totals.total,
        drafts: totals.drafts,
        days_with_entries: totals.days,
        uncategorized: totals.uncategorized,
        last_7_days: lastSevenDays,
        streak_days: streakEndingToday(daySet, today),
        first_entry_date: sortedDays[0] ?? null,
        last_entry_date: sortedDays[sortedDays.length - 1] ?? null,
        by_month: byMonth,
        by_category: byCategory,
      };
    },

    exportAll(userId) {
      return {
        categories: all(
          'SELECT id, name, created_at, updated_at FROM categories WHERE user_id = ? ORDER BY name COLLATE NOCASE',
          userId,
        ),
        entries: all('SELECT * FROM entries WHERE user_id = ? ORDER BY entry_date, created_at', userId).map(toEntry),
      };
    },
  };
}
