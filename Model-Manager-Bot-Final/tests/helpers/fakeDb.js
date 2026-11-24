import { randomUUID } from 'node:crypto';

/**
 * Banco em memória que imita a parte da API do supabase-js usada pelo projeto.
 * Permite injetar falhas (failNext) para testar tratamento de erros.
 */
export function createFakeDb(seed = {}) {
  const tables = {
    guild_settings: [], models: [], model_secrets: [], audit_logs: [], registration_sessions: [], ...seed
  };
  const storage = new Map(); // "bucket/path" -> Buffer
  const failures = [];
  const calls = [];
  let publicId = 0;

  const likeToRegex = (pattern) => {
    let out = '';
    for (let i = 0; i < pattern.length; i++) {
      const c = pattern[i];
      if (c === '\\' && i + 1 < pattern.length) { out += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
      if (c === '%') out += '.*'; else if (c === '_') out += '.';
      else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp(`^${out}$`, 'is');
  };

  function takeFailure(table, op) {
    const idx = failures.findIndex((f) => f.table === table && f.op === op);
    if (idx === -1) return null;
    return failures.splice(idx, 1)[0].error;
  }

  function builder(table) {
    const st = { op: 'select', filters: [], payload: null, order: null, range: null, limit: null, count: null, head: false, single: null, returning: false, onConflict: null, ignoreDuplicates: false };
    const api = {
      select(_cols, opts = {}) { if (st.op !== 'select') st.returning = true; st.count = opts.count || st.count; st.head = Boolean(opts.head); return api; },
      insert(payload) { st.op = 'insert'; st.payload = payload; return api; },
      update(payload) { st.op = 'update'; st.payload = payload; return api; },
      delete() { st.op = 'delete'; return api; },
      upsert(payload, opts = {}) { st.op = 'upsert'; st.payload = payload; st.onConflict = opts.onConflict; st.ignoreDuplicates = Boolean(opts.ignoreDuplicates); return api; },
      eq(col, val) { st.filters.push((r) => r[col] === val); return api; },
      lte(col, val) { st.filters.push((r) => new Date(r[col]).getTime() <= new Date(val).getTime()); return api; },
      in(col, vals) { st.filters.push((r) => vals.includes(r[col])); return api; },
      ilike(col, pattern) { const re = likeToRegex(pattern); st.filters.push((r) => re.test(String(r[col] ?? ''))); return api; },
      order(col, { ascending = true } = {}) { st.order = { col, ascending }; return api; },
      range(a, b) { st.range = [a, b]; return api; },
      limit(n) { st.limit = n; return api; },
      maybeSingle() { st.single = 'maybe'; return api; },
      single() { st.single = 'one'; return api; },
      then(resolve, reject) { return Promise.resolve().then(() => run()).then(resolve, reject); }
    };

    function run() {
      calls.push({ table, op: st.op });
      const failure = takeFailure(table, st.op);
      if (failure) return { data: null, error: failure, count: null };
      const rows = tables[table];
      const match = (r) => st.filters.every((f) => f(r));
      let result = [];
      if (st.op === 'insert' || (st.op === 'upsert')) {
        const items = Array.isArray(st.payload) ? st.payload : [st.payload];
        for (const item of items) {
          const row = { ...item };
          if (st.op === 'upsert' && st.onConflict) {
            const keys = st.onConflict.split(',');
            const existing = rows.find((r) => keys.every((k) => r[k] === row[k]));
            if (existing) { if (!st.ignoreDuplicates) Object.assign(existing, row); result.push(existing); continue; }
          }
          if (table === 'models') {
            if (!tables.guild_settings.some((g) => g.guild_id === row.guild_id)) return { data: null, error: { code: '23503', message: 'fk violation' }, count: null };
            row.id ??= randomUUID(); row.public_id ??= ++publicId; row.is_featured ??= false;
            row.public_message_id ??= null; row.public_channel_id ??= null; row.featured_message_id ??= null; row.featured_channel_id ??= null;
            row.created_at ??= new Date().toISOString(); row.observations ??= null;
          }
          if (table === 'registration_sessions') { row.id ??= randomUUID(); }
          if (table === 'model_secrets' && rows.some((r) => r.model_id === row.model_id)) return { data: null, error: { code: '23505', message: 'duplicate' }, count: null };
          rows.push(row); result.push(row);
        }
      } else if (st.op === 'update') {
        result = rows.filter(match);
        for (const r of result) Object.assign(r, st.payload);
      } else if (st.op === 'delete') {
        result = rows.filter(match);
        tables[table] = rows.filter((r) => !match(r));
        if (table === 'models') for (const r of result) tables.model_secrets = tables.model_secrets.filter((s) => s.model_id !== r.id);
      } else {
        result = rows.filter(match);
      }
      let count = null;
      if (st.count) count = result.length;
      if (st.op === 'select') {
        if (st.order) result = [...result].sort((a, b) => (String(a[st.order.col]) < String(b[st.order.col]) ? -1 : 1) * (st.order.ascending ? 1 : -1));
        if (st.range) result = result.slice(st.range[0], st.range[1] + 1);
        if (st.limit != null) result = result.slice(0, st.limit);
      }
      if (st.op !== 'select' && !st.returning) return { data: null, error: null, count };
      if (st.head) return { data: null, error: null, count };
      result = result.map((r) => ({ ...r }));
      if (st.single) {
        if (result.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' }, count };
        if (!result.length) return st.single === 'maybe' ? { data: null, error: null, count } : { data: null, error: { code: 'PGRST116', message: 'no rows' }, count };
        return { data: result[0], error: null, count };
      }
      return { data: result, error: null, count };
    }
    return api;
  }

  const bucketInfo = { id: 'model-photos', public: false, file_size_limit: 8388608 };
  const db = {
    tables, storage, calls,
    failNext(table, op, error = { code: 'XX000', message: 'falha simulada' }) { failures.push({ table, op, error }); },
    from: builder,
    storage_: null
  };
  db.storage = Object.assign(new Map(), {
    from(bucket) {
      return {
        async upload(path, buf) {
          const f = takeFailure('storage', 'upload'); if (f) return { data: null, error: f };
          storageMap.set(`${bucket}/${path}`, Buffer.from(buf)); return { data: { path }, error: null };
        },
        async remove(paths) {
          const f = takeFailure('storage', 'remove'); if (f) return { data: null, error: f };
          for (const p of paths) storageMap.delete(`${bucket}/${p}`); return { data: [], error: null };
        },
        async download(path) {
          const f = takeFailure('storage', 'download'); if (f) return { data: null, error: f };
          const b = storageMap.get(`${bucket}/${path}`);
          if (!b) return { data: null, error: { message: 'not found' } };
          return { data: new Blob([b]), error: null };
        }
      };
    },
    async getBucket() { return { data: bucketInfo, error: null }; }
  });
  const storageMap = new Map();
  db.files = storageMap;
  return db;
}
