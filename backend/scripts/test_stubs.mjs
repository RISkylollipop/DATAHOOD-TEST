// Test-only ESM loader: swaps the two things that cannot run in this
// sandbox, and NOTHING else. The controller under test is loaded unmodified.
//
//  1. bcrypt   — node_modules was installed on Windows, so the native
//                binding is an "invalid ELF header" on this Linux VM.
//  2. models/  — Sequelize would need a live MySQL server.
//
// WHAT THE SUBSTITUTES MUST GET RIGHT, or the tests pass vacuously:
//
//  * The bcrypt stub must be SALTED (so "backup codes are unrecoverable"
//    is a real property) and must emit EXACTLY 60 chars matching
//    /^\$2[aby]\$\d{2}\$/ — utils/crypto.js:48 isBcryptHash() gates on
//    precisely that, and a wrong-shaped hash would silently divert
//    disable() down its legacy-plaintext branch, testing code the
//    production path never reaches.
//
//  * The model stub must behave like Sequelize where the controller
//    depends on it: findByPk returns a mutable instance whose save()
//    persists; .scope('withSecrets') must return the secret fields and
//    the DEFAULT scope must NOT — otherwise a controller that forgot the
//    scope would still pass here and fail in production.
//
// Neither stub is a security control. Nothing in the app may import them.

const B64 = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

const BCRYPT_SRC = `
  import crypto from 'crypto';
  const B64 = ${JSON.stringify(B64)};
  // Deliberately cheap. The COST of bcrypt is a production security
  // property; here it is only latency, and the mutation harness runs the
  // whole suite dozens of times. What must survive is the salting and the
  // verification, which N=1024 preserves exactly.
  const KDF = { N: 1024, r: 8, p: 1 };
  const enc = (buf, n) => {
    let out = '';
    for (let i = 0; i < n; i += 1) out += B64[buf[i % buf.length] % 64];
    return out;
  };
  // '$2b$10$' (7) + salt (22) + digest (31) = 60, exactly bcrypt's shape.
  const hash = async (plain) => {
    const salt = enc(crypto.randomBytes(22), 22);
    return '$2b$10$' + salt + enc(crypto.scryptSync(String(plain), salt, 31, KDF), 31);
  };
  const compare = async (plain, stored) => {
    const s = String(stored || '');
    if (s.length !== 60 || !/^\\$2[aby]\\$\\d{2}\\$/.test(s)) return false;
    const salt = s.slice(7, 29);
    return enc(crypto.scryptSync(String(plain), salt, 31, KDF), 31) === s.slice(29);
  };
  export default { hash, compare };
  export { hash, compare };
`;

// The stub reads and writes globalThis.__DB__ so the test file can seed
// rows and inspect what the controller actually persisted.
const MODELS_SRC = `
  const db = () => globalThis.__DB__;

  // Fields the real SysUser default scope excludes. Kept in one place so
  // the stub cannot drift from models/SysUser.js by accident.
  const SECRET_FIELDS = ['sysToken', 'sysTotpSecret'];

  class Row {
    constructor(store, id, visible) {
      this._store = store;
      this._id = id;
      Object.assign(this, visible);
    }
    async save() {
      const target = this._store.get(this._id);
      for (const k of Object.keys(this)) {
        if (k.startsWith('_')) continue;
        target[k] = this[k];
      }
      db().saveCount += 1;
      return this;
    }
    async increment(field) {
      const target = this._store.get(this._id);
      target[field] = (target[field] || 0) + 1;
      this[field] = target[field];
      return this;
    }
  }

  function project(store, id, withSecrets) {
    const raw = store.get(id);
    if (!raw) return null;
    const visible = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!withSecrets && SECRET_FIELDS.includes(k)) continue;
      visible[k] = v;
    }
    return new Row(store, id, visible);
  }

  export const SysUser = {
    scope(name) {
      const withSecrets = name === 'withSecrets';
      return {
        findByPk: async (id) => project(db().sysusers, Number(id), withSecrets),
        findOne: async ({ where }) => {
          for (const [id, r] of db().sysusers) {
            if (r.sysUsername === where.sysUsername) return project(db().sysusers, id, withSecrets);
          }
          return null;
        },
      };
    },
    findByPk: async (id) => project(db().sysusers, Number(id), false),
    findOne: async ({ where }) => {
      for (const [id, r] of db().sysusers) {
        if (r.sysUsername === where.sysUsername) return project(db().sysusers, id, false);
      }
      return null;
    },
  };

  const matches = (row, where) => Object.entries(where).every(([k, v]) => {
    if (v === null) return row[k] === null || row[k] === undefined;
    return row[k] === v;
  });

  export const OtpCode = {
    async findOne({ where, order }) {
      let hits = [...db().otpcodes.entries()].filter(([, r]) => matches(r, where));
      if (order) hits.sort((a, b) => new Date(b[1].createdAt) - new Date(a[1].createdAt));
      if (!hits.length) return null;
      const [id] = hits[0];
      return project(db().otpcodes, id, true);
    },
    async update(values, { where }) {
      for (const [, r] of db().otpcodes) {
        if (matches(r, where)) Object.assign(r, values);
      }
    },
    async create(values) {
      const id = db().otpSeq += 1;
      db().otpcodes.set(id, { id, attempts: 0, consumedAt: null, createdAt: new Date(), ...values });
      return project(db().otpcodes, id, true);
    },
    async destroy() { return 0; },
  };

  // The rest of models/index.js, so importing the controller's transitive
  // dependencies (blacklistController, etc.) does not fail at link time.
  // Inert on purpose: findOne resolving to null is the "not blacklisted,
  // nothing found" answer, which is the correct neutral default here. If a
  // test ever needs one of these to have behaviour, give it behaviour
  // explicitly rather than letting a silent null stand in for a real row.
  const inert = () => ({
    findOne: async () => null,
    findAll: async () => [],
    findByPk: async () => null,
    create: async (v) => v,
    update: async () => [0],
    destroy: async () => 0,
    count: async () => 0,
  });

  export const sequelize = { transaction: async (fn) => (fn ? fn({}) : null) };
  export const Subscriber = inert();
  export const Transaction = inert();
  export const DataPlan = inert();
  export const CablePlan = inert();
  export const Network = inert();
  export const Blacklist = inert();
  export const Provider = inert();
  export const Airtime = inert();
  export const SiteSettings = inert();
  export const VerificationRecord = inert();
  export const VirtualAccount = inert();
  export const WalletLedger = inert();
  export const IdempotencyKey = inert();

  export default {
    sequelize, SysUser, OtpCode, Subscriber, Transaction, DataPlan, CablePlan,
    Network, Blacklist, Provider, Airtime, SiteSettings, VerificationRecord,
    VirtualAccount, WalletLedger, IdempotencyKey,
  };
`;

const MODEL_RE = /[/\\]models[/\\]index\.js$/;

export async function resolve(specifier, context, next) {
  if (specifier === 'bcrypt') return { url: 'test-stub:bcrypt', shortCircuit: true };
  const resolved = await next(specifier, context);
  if (MODEL_RE.test(decodeURIComponent(resolved.url))) {
    return { ...resolved, url: 'test-stub:models', shortCircuit: true };
  }
  return resolved;
}

export async function load(url, context, next) {
  if (url === 'test-stub:bcrypt') {
    return { format: 'module', shortCircuit: true, source: BCRYPT_SRC };
  }
  if (url === 'test-stub:models') {
    return { format: 'module', shortCircuit: true, source: MODELS_SRC };
  }
  return next(url, context);
}
