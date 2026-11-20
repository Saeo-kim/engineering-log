import { isIsoDate } from './dates.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Maximum lengths (characters). Keep in sync with the maxlength attributes in public/app.js.
export const TEXT_LIMITS = {
  title: 200,
  subject: 200,
  learned: 20000,
  not_understood: 20000,
  questions: 20000,
  code: 50000,
  references: 10000,
  thoughts: 20000,
};

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function parseId(value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) {
    throw new HttpError(400, 'Invalid id');
  }
  return value;
}

export function parseCategoryName(body) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) throw new HttpError(400, 'Topic name is required');
  if (name.length > 60) throw new HttpError(400, 'Topic name must be 60 characters or fewer');
  if (/[\r\n]/.test(name)) throw new HttpError(400, 'Topic name must be one line');
  return name;
}

export function parseEntry(body) {
  const out = {};
  for (const [field, max] of Object.entries(TEXT_LIMITS)) {
    const value = body[field];
    if (value === undefined || value === null) {
      out[field] = '';
      continue;
    }
    if (typeof value !== 'string') throw new HttpError(400, `${field} must be text`);
    if (value.length > max) throw new HttpError(400, `${field} is too long (max ${max} characters)`);
    out[field] = value;
  }
  out.title = out.title.trim();
  out.subject = out.subject.trim();

  if (!isIsoDate(body.entry_date)) throw new HttpError(400, 'entry_date must be a valid YYYY-MM-DD date');
  out.entry_date = body.entry_date;

  if (body.category_id === undefined || body.category_id === null || body.category_id === '') {
    out.category_id = null;
  } else {
    out.category_id = parseId(body.category_id);
  }

  out.is_draft = body.is_draft === true;
  return out;
}
