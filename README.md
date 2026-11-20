# Engineering Log

A personal learning journal. Write what you learned, anywhere, mostly from your phone.
It is not a course platform: there is no pre-filled content, and progress is only your own entries.

## What it does

- **Write something**: one tap creates a note. Every keystroke is saved on the phone first, then synced.
- **Notes**: title, date, optional topic and subject, what I learned, what I don't understand,
  questions, code snippet, references, personal thoughts, and a draft flag. Only the date is required.
- **Edit and delete** any note. Notes are never deleted automatically except a brand-new note you leave completely blank.
- **Topics**: create, rename, delete. Deleting a topic keeps its notes. Topics are optional.
- **Search and filters**: free text across all fields (every word must match), plus topic and date range.
- **History**: real counts only: notes written, days with notes, current streak, by month, by topic.
- **Backup**: download all notes and topics as JSON from the Account tab.
- **Installable**: add to Home Screen from Safari (Share → Add to Home Screen). Works offline for the app shell,
  and writing works offline; unsynced notes are sent when the connection returns.

## Stack

- Node.js 22 with the built-in `http` server and `node:sqlite`. **No npm dependencies.**
- SQLite database file (WAL mode) on a persistent disk.
- Plain HTML/CSS/JavaScript PWA, no build step. Service worker caches the app shell only.
- Auth: one owner account from environment variables, scrypt password hashes, HttpOnly SameSite=Lax
  session cookie valid 30 days, login rate limit (10 failures per 15 minutes per client address).

## Run locally

Requires Node.js 22.13 or newer.

```bash
cp .env.example .env          # then edit APP_USERNAME and APP_PASSWORD
export $(grep -v '^#' .env | xargs)
npm start                     # http://localhost:3000
npm test                      # API test suite (uses an in-memory database)
```

To use it from your iPhone on the same Wi-Fi, a plain HTTP address will work for trying things out, but
the session cookie is only marked `Secure` over HTTPS. For real use, deploy with HTTPS (below).

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `APP_USERNAME` | yes | – | The one account that can sign in. |
| `APP_PASSWORD` | yes | – | Password, at least 12 characters. Stored only as a scrypt hash. Changing it signs out all sessions on next start. |
| `DATABASE_FILE` | no | `./data/engineering-log.db` | SQLite file. Must be on persistent storage in production. |
| `PORT` | no | `3000` | HTTP port. |
| `HOST` | no | `0.0.0.0` | Bind address. |
| `COOKIE_SECURE` | no | `auto` | `true` / `false` / `auto` (Secure when the request is HTTPS). |
| `TRUST_PROXY` | no | `0` | `1` only behind a proxy you control, so rate limiting sees real client addresses. |

Secrets go in the host's secret/environment settings, never in the repository.

## Deploy (Docker, any host with a persistent volume)

The app needs one writable volume for the SQLite file. Any host that runs a Dockerfile and offers a
persistent disk works (for example Fly.io, Render with a disk, or a small VPS with Docker).

1. Build and run:
   ```bash
   docker build -t engineering-log .
   docker run -d -p 3000:3000 \
     -e APP_USERNAME=... -e APP_PASSWORD=... \
     -e TRUST_PROXY=1 \
     -v engineering-log-data:/data \
     --name engineering-log engineering-log
   ```
   The image runs as the non-root `node` user, so the volume must be writable by uid 1000
   (Docker named volumes handle this; for bind mounts run `chown -R 1000 <dir>`).
2. Put HTTPS in front of it (the host's TLS, Caddy, or nginx). The app itself speaks plain HTTP.
   Set `TRUST_PROXY=1` only when a proxy sits in front of it.
3. Check: `curl https://your-domain/api/health` returns `{"ok":true}`.

### Keeping the deployment on `main`

Deploy from the `main` branch in your host's dashboard (auto-deploy on push). Merge this work into `main`
first; the host should not be pointed at a feature branch.

### Backups

Use the Account tab to download JSON, or copy the SQLite file while the app is stopped
(or with `sqlite3 <file> ".backup backup.db"` while it runs).

## Data and privacy

- Notes are stored only in your database. The app makes no third-party requests and loads no CDN assets.
- Nothing is pre-filled. Topic suggestions in the Topics tab are buttons you tap to add, not created automatically.

## Known limits (MVP)

- Single owner account. Signup is intentionally absent.
- Last write wins across devices if the same note is edited on two phones while offline.
- Deleting a note needs a connection (so a delete cannot be lost silently).
- Rendered output is plain text with clickable links for references; no Markdown.

## Project layout

```
src/main.js      entrypoint (reads environment variables)
src/server.js    routing, sessions, handlers
src/db.js        schema migrations and queries
src/auth.js      password hashing, session tokens, rate limiter
src/validate.js  input validation and limits
src/http.js      JSON/static helpers, security headers
public/          app shell: index.html, app.js, app.css, sw.js, manifest, icons
scripts/make-icons.py   regenerates the PWA icons (stdlib only)
test/api.test.js        API tests
```
