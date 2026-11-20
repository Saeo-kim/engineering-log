/* Engineering Log — client. Plain JavaScript, no build step.
 *
 * Save path for every note:
 *   1. Each edit is written to localStorage synchronously (survives closing the app, bad signal).
 *   2. A debounced PUT sends the latest copy to the server (serialized, so older copies never win).
 *   3. Pending copies are retried when the app regains focus, comes back online, and every 20s.
 */
(() => {
  'use strict';

  // ------------------------------------------------------------------ constants

  const PENDING_PREFIX = 'elog:pending:';
  const NOTES_CACHE_KEY = 'elog:cache:notes';
  const TOPICS_CACHE_KEY = 'elog:cache:topics';
  const USER_KEY = 'elog:user';
  const PAGE_SIZE = 30;
  const TEXT_FIELDS = ['title', 'subject', 'learned', 'not_understood', 'questions', 'code', 'references', 'thoughts'];
  // Must match the server limits in src/validate.js.
  const LIMITS = {
    title: 200, subject: 200, learned: 20000, not_understood: 20000,
    questions: 20000, code: 50000, references: 10000, thoughts: 20000,
  };
  const LABELS = {
    learned: 'What I learned',
    not_understood: "What I don't understand",
    questions: 'Questions',
    code: 'Code snippet',
    references: 'References',
    thoughts: 'Personal thoughts',
  };
  const PLACEHOLDERS = {
    learned: 'Explain it in your own words…',
    not_understood: 'What still does not make sense?',
    questions: 'Things to look up later',
    code: 'Paste code here',
    references: 'One link or source per line',
    thoughts: 'Anything else on your mind',
  };
  const SUGGESTED_TOPICS = ['Programming', 'Java', 'Spring Boot', 'Database', 'SQL', 'Security', 'DevOps', 'AI', 'Robotics', 'Other'];

  // ------------------------------------------------------------------ state

  const state = { user: null, topics: [], offline: false };
  let renderSeq = 0;
  let teardown = null;
  let lastPath = null;

  // ------------------------------------------------------------------ utilities

  const $ = (sel) => document.querySelector(sel);
  const pad = (n) => String(n).padStart(2, '0');

  /** Tiny DOM builder. Text is always inserted with textContent, so note content cannot inject markup. */
  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        if (val === null || val === undefined || val === false) continue;
        if (key === 'class') el.className = val;
        else if (key === 'value' || key === 'checked') el[key] = val;
        else if (key.startsWith('on') && typeof val === 'function') el.addEventListener(key.slice(2), val);
        else el.setAttribute(key, val === true ? '' : String(val));
      }
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }

  function mount(...nodes) {
    $('#app').replaceChildren(...nodes.flat().filter(Boolean));
  }

  function todayIso() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function uid() {
    if (globalThis.crypto && crypto.randomUUID) return crypto.randomUUID();
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(36).padStart(2, '0')).join('') + Date.now().toString(36);
  }

  function toast(message) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 2800);
  }

  const storage = {
    get(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    },
    del(key) {
      try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
    },
    keys(prefix) {
      try {
        const out = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const k = localStorage.key(i);
          if (k && k.startsWith(prefix)) out.push(k);
        }
        return out;
      } catch { return []; }
    },
  };

  // ------------------------------------------------------------------ API

  class ApiError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  async function api(method, url, body) {
    const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body ?? {});
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch {
      state.offline = true;
      throw new ApiError('You are offline', 0);
    }
    state.offline = false;
    const data = await res.json().catch(() => null);
    if (res.status === 401 && url !== '/api/login') {
      state.user = null;
      go('/login');
      throw new ApiError('Please sign in again', 401);
    }
    if (!res.ok) throw new ApiError((data && data.error) || `Something went wrong (${res.status})`, res.status);
    return data;
  }

  async function loadTopics() {
    try {
      const { categories } = await api('GET', '/api/categories');
      state.topics = categories;
      storage.set(TOPICS_CACHE_KEY, categories);
    } catch (err) {
      if (err.status === 0) state.topics = storage.get(TOPICS_CACHE_KEY) || state.topics;
    }
  }

  // ------------------------------------------------------------------ note model

  function blankEntry(id) {
    return {
      id, title: '', entry_date: todayIso(), category_id: null, subject: '',
      learned: '', not_understood: '', questions: '', code: '', references: '', thoughts: '', is_draft: false,
    };
  }

  function isEmpty(entry) {
    return TEXT_FIELDS.every((f) => !String(entry[f] || '').trim());
  }

  function toPayload(e) {
    return {
      entry_date: e.entry_date,
      category_id: e.category_id || null,
      title: e.title || '',
      subject: e.subject || '',
      learned: e.learned || '',
      not_understood: e.not_understood || '',
      questions: e.questions || '',
      code: e.code || '',
      references: e.references || '',
      thoughts: e.thoughts || '',
      is_draft: Boolean(e.is_draft),
    };
  }

  function snippetOf(e) {
    for (const f of ['learned', 'not_understood', 'questions', 'thoughts', 'code']) {
      const text = String(e[f] || '').replace(/\s+/g, ' ').trim();
      if (text) return text.slice(0, 180);
    }
    return '';
  }

  // ------------------------------------------------------------------ offline queue

  const pendingKey = (id) => PENDING_PREFIX + id;
  let revSeq = 0;

  function readPending(id) {
    const rec = storage.get(pendingKey(id));
    return rec && rec.entry ? rec : null;
  }

  /** Durable local copy of a note. Returns false if localStorage is unavailable. */
  function writePending(entry, onServer) {
    return storage.set(pendingKey(entry.id), { entry, onServer, rev: `${Date.now()}-${++revSeq}` });
  }

  function listPending() {
    return storage.keys(PENDING_PREFIX)
      .map((k) => ({ id: k.slice(PENDING_PREFIX.length), rec: storage.get(k) }))
      .filter((p) => p.rec && p.rec.entry);
  }

  let chain = Promise.resolve();
  /** Runs tasks one at a time, so saves reach the server in the order they were made. */
  function queue(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  /** Sends the latest local copy of one note. Resolves true if the server now has it. */
  async function pushPending(id) {
    const rec = readPending(id);
    if (!rec) return false;
    const entry = rec.entry;
    if (isEmpty(entry) && !rec.onServer) {
      // Never reached the server and is blank: nothing to keep.
      storage.del(pendingKey(id));
      return false;
    }
    try {
      await api('PUT', `/api/entries/${encodeURIComponent(id)}`, toPayload(entry));
    } catch (err) {
      // A topic deleted on another device: keep the note, drop the stale topic, retry once.
      if (err.status === 400 && entry.category_id && /topic/i.test(err.message)) {
        entry.category_id = null;
        writePending(entry, rec.onServer);
        return pushPending(id);
      }
      throw err;
    }
    const latest = readPending(id);
    if (latest && latest.rev === rec.rev) {
      storage.del(pendingKey(id));
    } else if (latest) {
      // A newer edit arrived while this request was in flight; keep it and mark that the server has this note.
      storage.set(pendingKey(id), { ...latest, onServer: true });
    }
    return true;
  }

  async function syncAll() {
    if (!state.user) return;
    for (const { id } of listPending()) {
      try {
        await queue(() => pushPending(id));
      } catch (err) {
        if (err.status === 401 || err.status === 0) return; // stop; retry later
      }
    }
  }

  // ------------------------------------------------------------------ routing

  function parseRoute() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, query = ''] = raw.split('?');
    return { path: path || '/', query: new URLSearchParams(query) };
  }

  function go(path) {
    const target = '#' + path;
    if (location.hash === target) render();
    else location.hash = target;
  }

  function setTabs(visible, path) {
    const tabs = $('#tabs');
    tabs.hidden = !visible;
    const active = path.startsWith('/note') ? 'notes' : path.slice(1);
    for (const a of tabs.querySelectorAll('a')) {
      if (a.dataset.tab === active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  async function render() {
    const seq = ++renderSeq;
    if (teardown) {
      const finish = teardown;
      teardown = null;
      finish();
    }
    let { path, query } = parseRoute();

    if (!state.user) {
      setTabs(false, path);
      if (path !== '/login') history.replaceState(null, '', '#/login');
      lastPath = '/login';
      return renderLogin();
    }
    if (path === '/login' || path === '/') {
      history.replaceState(null, '', '#/notes');
      path = '/notes';
    }
    if (path !== lastPath) window.scrollTo(0, 0);
    lastPath = path;
    setTabs(true, path);

    try {
      if (path === '/notes') return await viewNotes(seq, query);
      if (path.startsWith('/note/')) return await viewEditor(seq, decodeURIComponent(path.slice(6)), query);
      if (path === '/write') return go(`/note/${uid()}?new=1`);
      if (path === '/history') return await viewHistory(seq);
      if (path === '/topics') return await viewTopics(seq);
      if (path === '/account') return await viewAccount();
      return go('/notes');
    } catch (err) {
      if (seq !== renderSeq || err.status === 401) return;
      mount(
        h('div', { class: 'empty' }, err.message || 'Something went wrong.'),
        h('p', { class: 'btn-row' }, h('a', { class: 'btn', href: '#/notes' }, 'Back to notes')),
      );
    }
  }

  // ------------------------------------------------------------------ login

  function renderLogin() {
    const error = h('p', { class: 'error', role: 'alert' });
    const username = h('input', {
      type: 'text', name: 'username', autocomplete: 'username', autocapitalize: 'none',
      spellcheck: 'false', required: true, placeholder: 'Username', 'aria-label': 'Username',
    });
    const password = h('input', {
      type: 'password', name: 'password', autocomplete: 'current-password', required: true,
      placeholder: 'Password', 'aria-label': 'Password',
    });
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');
    const form = h('form', {
      class: 'auth',
      onsubmit: async (event) => {
        event.preventDefault();
        error.textContent = '';
        submit.disabled = true;
        try {
          const { user } = await api('POST', '/api/login', { username: username.value.trim(), password: password.value });
          state.user = user;
          storage.set(USER_KEY, user);
          await loadTopics();
          go('/notes');
        } catch (err) {
          error.textContent = err.message;
          password.value = '';
          password.focus();
        } finally {
          submit.disabled = false;
        }
      },
    },
      h('h1', null, 'Engineering Log'),
      h('p', { class: 'muted center tight' }, 'Sign in to open your notes.'),
      username,
      password,
      error,
      submit,
    );
    mount(form);
  }

  // ------------------------------------------------------------------ notes list

  async function viewNotes(seq, query) {
    const filters = {
      q: query.get('q') || '',
      category: query.get('category') || '',
      from: query.get('from') || '',
      to: query.get('to') || '',
    };
    const hasFilters = Boolean(filters.category || filters.from || filters.to);

    const search = h('input', {
      type: 'search', value: filters.q, placeholder: 'Search what you wrote…',
      'aria-label': 'Search notes', enterkeyhint: 'search', autocapitalize: 'none',
    });
    const topicSelect = h('select', { 'aria-label': 'Filter by topic' },
      h('option', { value: '' }, 'All topics'),
      h('option', { value: 'none' }, 'No topic'),
      state.topics.map((t) => h('option', { value: t.id }, t.name)),
    );
    topicSelect.value = filters.category;
    const fromInput = h('input', { type: 'date', 'aria-label': 'From date', value: filters.from });
    const toInput = h('input', { type: 'date', 'aria-label': 'To date', value: filters.to });
    const clearBtn = h('button', { class: 'btn ghost small-btn', type: 'button' }, 'Clear filters');
    const filtersBox = h('details', { class: 'filters', open: hasFilters },
      h('summary', null, 'Filters'),
      h('div', { class: 'filter-body' },
        topicSelect,
        h('div', { class: 'field-row' }, fromInput, toInput),
        h('div', null, clearBtn),
      ),
    );

    const pendingBanner = h('div', { class: 'banner hidden', role: 'status' });
    const list = h('div', { class: 'list' });
    const moreBtn = h('button', { class: 'btn block hidden more-btn', type: 'button' }, 'Load more');

    mount(
      h('div', { class: 'page-head' }, h('h1', null, 'Notes')),
      h('a', { class: 'write-big', href: '#/write' }, h('span', { class: 'plus', 'aria-hidden': 'true' }, '+'), 'Write something'),
      h('div', { class: 'search-wrap' }, search, filtersBox),
      pendingBanner,
      list,
      moreBtn,
    );

    const current = () => ({
      q: search.value.trim(),
      category: topicSelect.value,
      from: fromInput.value,
      to: toInput.value,
    });
    const isPlain = (f) => !f.q && !f.category && !f.from && !f.to;

    let offset = 0;
    let loading = false;

    function syncUrl(f) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
      const qs = params.toString();
      history.replaceState(null, '', '#/notes' + (qs ? '?' + qs : ''));
    }

    function updatePendingBanner() {
      const unsynced = listPending().filter((p) => !isEmpty(p.rec.entry)).length;
      pendingBanner.classList.toggle('hidden', unsynced === 0);
      pendingBanner.textContent = unsynced
        ? `${unsynced} note${unsynced === 1 ? '' : 's'} saved on this phone, waiting to sync.`
        : '';
    }

    async function load(reset) {
      if (loading) return;
      loading = true;
      const f = current();
      syncUrl(f);
      if (reset) {
        offset = 0;
        list.replaceChildren();
      }
      const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      for (const [k, v] of Object.entries(f)) if (v) params.set(k, v);
      const plain = isPlain(f);
      // Notes that never reached the server appear at the top of the first page.
      const unsynced = reset && plain
        ? listPending().filter((p) => !p.rec.onServer && !isEmpty(p.rec.entry)).sort((a, b) => b.rec.entry.entry_date.localeCompare(a.rec.entry.entry_date))
        : [];

      try {
        const data = await api('GET', `/api/entries?${params}`);
        if (seq !== renderSeq) return;
        if (reset && plain) storage.set(NOTES_CACHE_KEY, data);
        const items = reset ? [...unsynced.map((p) => ({ ...p.rec.entry, _unsynced: true })), ...data.entries] : data.entries;
        appendCards(items);
        offset += data.entries.length;
        moreBtn.classList.toggle('hidden', !data.hasMore);
        if (reset && items.length === 0) list.append(emptyState(plain));
      } catch (err) {
        if (seq !== renderSeq || err.status === 401) return;
        const cached = reset && plain ? storage.get(NOTES_CACHE_KEY) : null;
        if (err.status === 0 && cached) {
          const items = [...unsynced.map((p) => ({ ...p.rec.entry, _unsynced: true })), ...cached.entries];
          appendCards(items);
          moreBtn.classList.add('hidden');
          pendingBanner.classList.remove('hidden');
          pendingBanner.textContent = 'Offline. Showing the list from your last visit. Search needs a connection.';
        } else if (err.status === 0) {
          list.replaceChildren(h('div', { class: 'empty' }, 'You are offline. Search and filters need a connection. Your notes on this phone are still saved.'));
        } else {
          toast(err.message);
        }
      } finally {
        loading = false;
        updatePendingBanner();
      }
    }

    function appendCards(items) {
      for (const e of items) list.append(noteCard(e, e._unsynced));
    }

    function emptyState(plain) {
      return h('div', { class: 'empty' }, plain
        ? 'No notes yet. Tap “Write something” to record what you learned today.'
        : 'Nothing matches these filters.');
    }

    let searchTimer = null;
    search.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => load(true), 280);
    });
    for (const el of [topicSelect, fromInput, toInput]) el.addEventListener('change', () => load(true));
    clearBtn.addEventListener('click', () => {
      search.value = '';
      topicSelect.value = '';
      fromInput.value = '';
      toInput.value = '';
      load(true);
    });
    moreBtn.addEventListener('click', () => load(false));

    updatePendingBanner();
    await load(true);
  }

  function barFill(fraction) {
    const fill = h('span');
    fill.style.width = `${Math.round(fraction * 100)}%`;
    return fill;
  }

  function noteCard(e, unsynced = false) {
    const topic = state.topics.find((t) => t.id === e.category_id);
    const meta = [formatDate(e.entry_date), topic ? topic.name : null].filter(Boolean).join(' · ');
    const snippet = snippetOf(e);
    return h('a', { class: 'card', href: `#/note/${encodeURIComponent(e.id)}` },
      h('div', { class: 'card-top' },
        h('span', { class: 'card-title' }, e.title || 'Untitled note'),
        e.is_draft ? h('span', { class: 'badge' }, 'Draft') : null,
        unsynced ? h('span', { class: 'badge warn' }, 'Not synced') : null,
      ),
      h('div', { class: 'card-meta' }, meta),
      snippet ? h('p', { class: 'card-snippet' }, snippet) : null,
    );
  }

  // ------------------------------------------------------------------ editor

  async function viewEditor(seq, id, query) {
    const isNew = query.get('new') === '1';
    const local = readPending(id);
    let current;
    let onServer;

    if (local) {
      current = { ...local.entry };
      onServer = Boolean(local.onServer);
    } else {
      try {
        current = (await api('GET', `/api/entries/${encodeURIComponent(id)}`)).entry;
        onServer = true;
      } catch (err) {
        if (seq !== renderSeq) return;
        if (err.status === 404 && isNew) {
          // Freshly created note that was never saved (e.g. reloaded before typing).
          current = blankEntry(id);
          onServer = false;
        } else if (err.status === 404) {
          return mount(h('div', { class: 'empty' }, 'This note could not be found.'), backLink());
        } else if (err.status === 0) {
          return mount(h('div', { class: 'empty' }, 'This note is not on this phone and you are offline.'), backLink());
        } else {
          throw err;
        }
      }
    }

    await loadTopics();
    if (seq !== renderSeq) return;
    if (current.category_id && !state.topics.some((t) => t.id === current.category_id)) {
      current.category_id = null; // topic was deleted
    }

    let live = true;
    let saveTimer = null;
    let onServerNow = onServer;
    const createdHere = isNew;

    const statusEl = h('span', { class: 'save-state', 'aria-live': 'polite' }, onServer ? 'Saved' : 'Saved on this phone');
    const setStatus = (text, bad = false) => {
      statusEl.textContent = text;
      statusEl.classList.toggle('bad', bad);
    };

    const inputs = {};
    const grow = (el) => {
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight + 2}px`;
    };

    function onEdited() {
      if (!live) return;
      const saved = writePending(current, onServerNow);
      setStatus(saved ? 'Editing…' : 'Could not save on this phone', !saved);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveNow, 700);
    }

    async function saveNow() {
      saveTimer = null;
      if (!live) return;
      setStatus('Saving…');
      try {
        const pushed = await queue(() => pushPending(id));
        if (pushed) {
          onServerNow = true;
          if (createdHere) history.replaceState(null, '', `#/note/${encodeURIComponent(id)}`); // drop ?new=1
        }
        if (!live || saveTimer) return; // newer edits are already queued
        setStatus(pushed ? 'Saved' : 'Saved on this phone', false);
      } catch (err) {
        if (err.status === 401 || !live) return;
        setStatus('Saved on this phone · will sync', true);
      }
    }

    function textField(field) {
      const el = h('textarea', {
        name: field, maxlength: LIMITS[field], placeholder: PLACEHOLDERS[field],
        rows: 3, 'aria-label': LABELS[field], class: field === 'code' ? 'code' : null,
        spellcheck: field === 'code' ? 'false' : null,
        autocapitalize: field === 'code' ? 'none' : 'sentences',
        autocorrect: field === 'code' ? 'off' : null,
        value: current[field] || '',
        oninput: () => {
          current[field] = el.value;
          grow(el);
          onEdited();
        },
      });
      inputs[field] = el;
      return h('div', null,
        h('label', { class: 'field' }, h('span', { class: 'label' }, LABELS[field]), el),
      );
    }

    const titleInput = h('input', {
      type: 'text', class: 'title-input', name: 'title', maxlength: LIMITS.title, placeholder: 'Title (optional)',
      value: current.title || '', 'aria-label': 'Title',
      oninput: () => { current.title = titleInput.value; onEdited(); },
    });

    const dateInput = h('input', {
      type: 'date', name: 'entry_date', value: current.entry_date, 'aria-label': 'Date',
      onchange: () => {
        if (dateInput.value) { current.entry_date = dateInput.value; onEdited(); }
      },
    });

    const topicSelect = h('select', {
      name: 'category_id', 'aria-label': 'Topic',
      onchange: () => { current.category_id = topicSelect.value || null; onEdited(); },
    },
      h('option', { value: '' }, 'No topic'),
      state.topics.map((t) => h('option', { value: t.id }, t.name)),
    );
    topicSelect.value = current.category_id || '';

    const subjectInput = h('input', {
      type: 'text', name: 'subject', maxlength: LIMITS.subject, placeholder: 'Subject (optional), e.g. Spring Boot',
      value: current.subject || '', 'aria-label': 'Subject',
      oninput: () => { current.subject = subjectInput.value; onEdited(); },
    });

    const draftBox = h('input', {
      type: 'checkbox', checked: Boolean(current.is_draft),
      onchange: () => { current.is_draft = draftBox.checked; onEdited(); },
    });

    const deleteBtn = h('button', { class: 'btn danger block', type: 'button' }, 'Delete note');
    deleteBtn.addEventListener('click', async () => {
      if (!confirm('Delete this note? This cannot be undone.')) return;
      clearTimeout(saveTimer);
      try {
        if (onServerNow) await queue(() => api('DELETE', `/api/entries/${encodeURIComponent(id)}`).catch((err) => {
          if (err.status !== 404) throw err;
        }));
      } catch (err) {
        if (err.status === 401) return;
        toast('Could not delete. Check your connection and try again.');
        return;
      }
      live = false;
      teardown = null;
      storage.del(pendingKey(id));
      toast('Note deleted');
      go('/notes');
    });

    // Runs when the user leaves this note (any route change).
    teardown = () => {
      if (!live) return;
      live = false;
      clearTimeout(saveTimer);
      if (!readPending(id)) return;
      if (createdHere && isEmpty(current)) {
        // Opened "Write something" and left it blank: don't leave an empty note behind.
        storage.del(pendingKey(id));
        if (onServerNow) queue(() => api('DELETE', `/api/entries/${encodeURIComponent(id)}`).catch(() => {}));
        return;
      }
      queue(() => pushPending(id)).catch(() => {});
    };

    mount(
      h('div', { class: 'editor-top' },
        h('a', { class: 'btn ghost small-btn', href: '#/notes' }, '← Notes'),
        statusEl,
      ),
      h('div', { class: 'editor' },
        titleInput,
        h('div', { class: 'field-row' },
          h('label', { class: 'field' }, h('span', { class: 'label' }, 'Date'), dateInput),
          h('label', { class: 'field' }, h('span', { class: 'label' }, 'Topic'), topicSelect),
        ),
        h('label', { class: 'field' }, h('span', { class: 'label' }, 'Subject'), subjectInput),
        textField('learned'),
        textField('not_understood'),
        textField('questions'),
        textField('code'),
        textField('references'),
        textField('thoughts'),
        h('label', { class: 'toggle' }, draftBox, 'Keep as draft'),
        h('div', { class: 'foot' }, deleteBtn),
      ),
    );

    for (const el of Object.values(inputs)) grow(el);
    if (isNew) requestAnimationFrame(() => inputs.learned && inputs.learned.focus());
    if (!isNew && !local) setStatus('Saved');
  }

  function backLink() {
    return h('p', { class: 'center' }, h('a', { class: 'btn', href: '#/notes' }, 'Back to notes'));
  }

  // ------------------------------------------------------------------ history

  async function viewHistory(seq) {
    const s = await api('GET', `/api/stats?today=${todayIso()}`);
    if (seq !== renderSeq) return;

    const stat = (num, label) => h('div', { class: 'stat' }, h('div', { class: 'num' }, String(num)), h('div', { class: 'lbl' }, label));
    const monthName = (ym) => {
      const [y, m] = ym.split('-').map(Number);
      return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    };
    const maxTopic = Math.max(1, ...s.by_category.map((c) => c.n));

    const range = s.total
      ? `First note ${formatDate(s.first_entry_date)} · latest ${formatDate(s.last_entry_date)}`
      : 'Nothing written yet.';

    mount(
      h('div', { class: 'page-head' }, h('h1', null, 'History')),
      h('p', { class: 'muted small lead' }, range),
      h('div', { class: 'stat-grid spaced' },
        stat(s.total, 'notes written'),
        stat(s.days_with_entries, 'days with notes'),
        stat(s.streak_days, 'day streak'),
        stat(s.last_7_days, 'notes this week'),
      ),
      h('div', { class: 'section-title' }, 'By month'),
      s.by_month.length
        ? h('ul', { class: 'list-plain' }, s.by_month.map((m) => {
          const [y, mo] = m.month.split('-').map(Number);
          const last = new Date(y, mo, 0).getDate();
          return h('li', null, h('a', { href: `#/notes?from=${m.month}-01&to=${m.month}-${pad(last)}` },
            h('span', null, monthName(m.month)), h('span', { class: 'count' }, String(m.n))));
        }))
        : h('div', { class: 'empty' }, 'Months with notes will appear here.'),
      h('div', { class: 'section-title' }, 'By topic'),
      s.by_category.length
        ? h('ul', { class: 'list-plain' }, s.by_category.map((c) => h('li', null,
          h('a', { href: `#/notes?category=${encodeURIComponent(c.id)}`, class: 'topic-link' },
            h('span', { class: 'topic-line' }, h('span', null, c.name), h('span', { class: 'count' }, String(c.n))),
            h('div', { class: 'bar' }, barFill(c.n / maxTopic)),
          ))))
        : h('div', { class: 'empty' }, 'Create topics in the Topics tab if you want to group notes.'),
      h('p', { class: 'muted small note-foot' },
        `${s.uncategorized} note${s.uncategorized === 1 ? '' : 's'} without a topic. Counts come from your saved notes only.`),
    );
  }

  // ------------------------------------------------------------------ topics

  async function viewTopics(seq) {
    await loadTopics();
    if (seq !== renderSeq) return;

    const input = h('input', { type: 'text', placeholder: 'New topic, e.g. Kafka', maxlength: 60, 'aria-label': 'New topic name', autocapitalize: 'words' });
    const addTopic = async (name) => {
      try {
        await api('POST', '/api/categories', { name });
        await loadTopics();
        render();
      } catch (err) {
        if (err.status !== 401) toast(err.message);
      }
    };
    const addForm = h('form', {
      class: 'row add-form',
      onsubmit: (event) => {
        event.preventDefault();
        const name = input.value.trim();
        if (name) addTopic(name);
      },
    }, h('div', { class: 'grow' }, input), h('button', { class: 'btn primary', type: 'submit' }, 'Add'));

    const existing = new Set(state.topics.map((t) => t.name.toLowerCase()));
    const suggestions = SUGGESTED_TOPICS.filter((n) => !existing.has(n.toLowerCase()));

    const rows = state.topics.map((t) => {
      const rename = h('button', { class: 'btn small-btn', type: 'button' }, 'Rename');
      const remove = h('button', { class: 'btn small-btn danger', type: 'button' }, 'Delete');
      rename.addEventListener('click', async () => {
        const name = prompt('Rename topic', t.name);
        if (!name || !name.trim() || name.trim() === t.name) return;
        try {
          await api('PATCH', `/api/categories/${encodeURIComponent(t.id)}`, { name: name.trim() });
          await loadTopics();
          render();
        } catch (err) { if (err.status !== 401) toast(err.message); }
      });
      remove.addEventListener('click', async () => {
        if (!confirm(`Delete the topic “${t.name}”? Its notes stay and just lose this topic.`)) return;
        try {
          await api('DELETE', `/api/categories/${encodeURIComponent(t.id)}`);
          await loadTopics();
          render();
        } catch (err) { if (err.status !== 401) toast(err.message); }
      });
      return h('li', null,
        h('a', { href: `#/notes?category=${encodeURIComponent(t.id)}`, class: 'grow' },
          h('span', null, t.name),
          h('span', { class: 'count' }, String(t.entry_count))),
        h('span', { class: 'row actions' }, rename, remove),
      );
    });

    mount(
      h('div', { class: 'page-head' }, h('h1', null, 'Topics')),
      h('p', { class: 'muted small lead' }, 'Topics are optional. Use them to group notes however you like.'),
      addForm,
      suggestions.length
        ? h('div', null,
          h('div', { class: 'section-title' }, 'Quick add'),
          h('div', { class: 'chips' }, suggestions.map((name) => {
            const chip = h('button', { class: 'chip', type: 'button' }, `+ ${name}`);
            chip.addEventListener('click', () => addTopic(name));
            return chip;
          })),
        )
        : null,
      h('div', { class: 'section-title' }, 'Your topics'),
      rows.length
        ? h('ul', { class: 'list-plain' }, rows)
        : h('div', { class: 'empty' }, 'No topics yet. Notes work fine without one.'),
    );
  }

  // ------------------------------------------------------------------ account

  async function viewAccount() {
    const user = state.user || {};
    const backupBtn = h('button', { class: 'btn block', type: 'button' }, 'Download backup (JSON)');
    backupBtn.addEventListener('click', downloadBackup);
    const signOutBtn = h('button', { class: 'btn danger block', type: 'button' }, 'Sign out');
    signOutBtn.addEventListener('click', signOut);
    mount(
      h('div', { class: 'page-head' }, h('h1', null, 'Account')),
      h('div', { class: 'stack' },
        h('div', { class: 'stat' },
          h('div', { class: 'lbl' }, 'Signed in as'),
          h('div', { class: 'username' }, user.username || '—'),
        ),
        backupBtn,
        h('p', { class: 'muted small' }, 'A backup file contains every note and topic as JSON. Keep a copy somewhere safe.'),
        h('div', { class: 'signout' }, signOutBtn),
      ),
    );
  }

  async function downloadBackup() {
    try {
      const res = await fetch('/api/export', { credentials: 'same-origin' });
      if (res.status === 401) return go('/login');
      if (!res.ok) throw new Error('Backup failed. Try again.');
      const url = URL.createObjectURL(await res.blob());
      const a = h('a', { href: url, download: `engineering-log-backup-${todayIso()}.json` });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 15000);
    } catch (err) {
      toast(err.message || 'Backup failed. Try again.');
    }
  }

  async function signOut() {
    const unsynced = listPending().filter((p) => !isEmpty(p.rec.entry)).length;
    if (unsynced && !confirm(`${unsynced} note(s) are not synced yet. They stay on this phone and sync next time you sign in. Sign out anyway?`)) {
      return;
    }
    try { await api('POST', '/api/logout', {}); } catch { /* signing out locally anyway */ }
    state.user = null;
    storage.del(USER_KEY);
    go('/login');
  }

  // ------------------------------------------------------------------ boot

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => { /* offline shell is optional */ });
    }
  }

  async function boot() {
    registerServiceWorker();
    try {
      const { user } = await api('GET', '/api/me');
      state.user = user;
      storage.set(USER_KEY, user);
    } catch (err) {
      // No connection: if this phone has signed in before, let the app open for offline writing.
      const remembered = storage.get(USER_KEY);
      if (err.status === 0 && remembered) state.user = remembered;
    }
    if (state.user) {
      await loadTopics();
      syncAll();
    }

    window.addEventListener('hashchange', render);
    window.addEventListener('online', () => { loadTopics(); syncAll(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') syncAll();
    });
    setInterval(syncAll, 20000);
    render();
  }

  boot();
})();
