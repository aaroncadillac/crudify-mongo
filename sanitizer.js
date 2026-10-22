// Query and body sanitizer for Crudify. Dependency-free and usable on its own
// (`@aaroncadillac/crudify-mongo/sanitizer`) from custom handlers.
//
// `createSanitizer(config)` compiles the allowlists once and returns
// { filter, options, update, create }. Every function builds a NEW object from
// the input (which is never mutated) and throws a 400 `CrudifyError` on
// anything outside the allowed shape.

class CrudifyError extends Error {
  constructor (status, message, { code, details } = {}) {
    super(message)
    this.name = 'CrudifyError'
    this.statusCode = status
    if (code) this.code = code
    if (details) this.details = details
  }
}

const SCALAR_OPS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte'])
const LIST_OPS = new Set(['$in', '$nin', '$all'])
const LOGICAL_OPS = new Set(['$or', '$and', '$nor'])
const SUPPORTED_OPS = new Set([...SCALAR_OPS, ...LIST_OPS, ...LOGICAL_OPS, '$exists', '$size'])
// Never configurable: arbitrary code, client regex (ReDoS) or text search.
const FORBIDDEN_OPS = new Set(['$where', '$expr', '$function', '$accumulator', '$regex', '$text', '$jsonSchema', '$elemMatch'])
const DEFAULT_OPERATORS = Object.freeze(['$eq', '$ne', '$in', '$nin', '$gt', '$gte', '$lt', '$lte', '$exists', '$or', '$and'])

const ALWAYS_DENIED = ['_id', '__v', 'createdAt', 'updatedAt']
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
const SORT_FIELD_RE = /^[A-Za-z0-9_.]+$/

const DEFAULTS = {
  operators: DEFAULT_OPERATORS,
  maxDepth: 4,
  maxKeys: 100,
  maxArray: 1000,
  maxBranches: 20,
  search: 'contains', // '/text/' -> /text/i ('contains'), /^text/ ('prefix') or left as a string (false)
  maxSearchLength: 64,
  filterable: null, // allowlist of root fields usable in filters and sort
  defaultLimit: 50,
  maxLimit: 100,
  maxSort: 5,
  populate: [], // paths a client may ask for in `options.populate`
  writable: null, // allowlist of root fields for create/update
  readonly: [], // root fields never written by the client
  hidden: [] // never filterable, sortable or populable
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isPrimitive = (v) => v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
const toInt = (v) => { const n = Math.floor(Number(v)); return Number.isSafeInteger(n) ? n : 0 }
const bad = (message, code = 'invalid_query') => new CrudifyError(400, message, { code })
const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')

// Parses a JSON query param exactly once; a repeated param arrives as an array.
const parseJson = (raw, name) => {
  if (raw === undefined || raw === '') return {}
  if (typeof raw !== 'string') throw bad(`Invalid ${name}`)
  let value
  try { value = JSON.parse(raw) } catch { throw bad(`Invalid ${name} JSON`) }
  if (!isPlainObject(value)) throw bad(`Invalid ${name}`)
  return value
}

const assertNoOperators = (value, path) => {
  if (Array.isArray(value)) return value.forEach(item => assertNoOperators(item, path))
  if (!isPlainObject(value)) return
  for (const key in value) {
    if (key[0] === '$' || UNSAFE_KEYS.has(key)) throw bad(`Operator not allowed inside "${path}"`, 'invalid_body')
    assertNoOperators(value[key], path)
  }
}

const compile = (cfg = {}) => {
  const c = {}
  for (const key in DEFAULTS) c[key] = cfg[key] ?? DEFAULTS[key]
  for (const op of c.operators) {
    if (FORBIDDEN_OPS.has(op) || !SUPPORTED_OPS.has(op)) throw new TypeError(`Crudify sanitizer: operator not supported: ${op}`)
  }
  const ops = new Set(c.operators)
  const hidden = new Set(c.hidden)
  const filterable = c.filterable && new Set(c.filterable)
  const writable = c.writable && new Set(c.writable)
  const populable = new Set(c.populate)
  const denied = new Set([...ALWAYS_DENIED, ...c.readonly])
  const toSearch = c.search === 'prefix' ? (s) => new RegExp('^' + escapeRegex(s))
    : c.search === 'contains' ? (s) => new RegExp(escapeRegex(s), 'i') : null
  let budget = 0 // filter() is synchronous, so one counter per sanitizer is safe

  const rootOf = (field) => {
    const parts = field.split('.')
    if (field.includes('$') || parts.some(p => !p || UNSAFE_KEYS.has(p))) throw bad(`Invalid field: ${field}`)
    return parts[0]
  }
  const checkField = (field) => {
    const root = rootOf(field)
    if (hidden.has(root) || (filterable && !filterable.has(root))) throw bad(`Field not allowed: ${field}`)
  }
  const isList = (v) => Array.isArray(v) && v.length <= c.maxArray && v.every(isPrimitive)

  // '/text/' is the search convention: a LITERAL match, never a client regex.
  const convert = (v) => {
    if (toSearch && typeof v === 'string' && v.length >= 2 && v[0] === '/' && v[v.length - 1] === '/') {
      if (v.length - 2 > c.maxSearchLength) throw bad('Search text too long')
      return toSearch(v.slice(1, -1))
    }
    return v
  }

  const walkValue = (field, value) => {
    if (isPrimitive(value)) return convert(value)
    if (Array.isArray(value)) {
      if (!isList(value)) throw bad(`Invalid value for "${field}"`)
      return value
    }
    if (!isPlainObject(value)) throw bad(`Invalid value for "${field}"`)
    const out = {}
    for (const op in value) {
      const v = value[op]
      if (!ops.has(op) || LOGICAL_OPS.has(op)) throw bad(`Operator not allowed: ${op}`)
      if (SCALAR_OPS.has(op) ? !isPrimitive(v)
        : LIST_OPS.has(op) ? !isList(v)
          : op === '$exists' ? typeof v !== 'boolean'
            : !Number.isInteger(v) || v < 0) throw bad(`Invalid value for ${op}`)
      out[op] = v
    }
    return out
  }

  const walk = (node, depth) => {
    if (depth > c.maxDepth) throw bad('Filter too deeply nested')
    if (!isPlainObject(node)) throw bad('Filter must be an object')
    const out = {}
    for (const key in node) {
      if (++budget > c.maxKeys) throw bad('Filter too large')
      const value = node[key]
      if (key[0] === '$') {
        if (!LOGICAL_OPS.has(key) || !ops.has(key)) throw bad(`Operator not allowed: ${key}`)
        if (!Array.isArray(value) || !value.length || value.length > c.maxBranches) throw bad(`${key} expects a non-empty array`)
        out[key] = value.map(child => walk(child, depth + 1))
      } else {
        checkField(key) // before assigning: rejects `__proto__`
        out[key] = walkValue(key, value)
      }
    }
    return out
  }

  const direction = (d) => {
    if (d === 1 || d === 'asc' || d === 'ascending') return 1
    if (d === -1 || d === 'desc' || d === 'descending') return -1
    throw bad('Invalid sort direction')
  }

  const parseSort = (raw) => {
    const out = {}
    let count = 0
    const add = (field, dir) => {
      if (!SORT_FIELD_RE.test(field)) throw bad('Invalid sort')
      checkField(field)
      if (++count > c.maxSort) throw bad('Too many sort fields')
      out[field] = dir
    }
    if (typeof raw === 'string') {
      for (const part of raw.split(/\s+/)) if (part) add(part.replace(/^[-+]/, ''), part[0] === '-' ? -1 : 1)
    } else if (isPlainObject(raw)) {
      for (const field in raw) add(field, direction(raw[field]))
    } else throw bad('Invalid sort')
    return out
  }

  // Only page / limit / sort (+ allowlisted populate) survive. `select`,
  // `projection`, `lean`, `collation` and `pagination:false` are ignored.
  const options = (raw) => {
    const src = isPlainObject(raw) ? raw : {}
    const asked = toInt(src.limit)
    const out = {
      page: Math.max(1, toInt(src.page)),
      limit: Math.min(c.maxLimit, asked > 0 ? asked : c.defaultLimit),
      pagination: true
    }
    if (src.sort !== undefined && src.sort !== null && src.sort !== '') out.sort = parseSort(src.sort)
    if (populable.size && src.populate) {
      const wanted = typeof src.populate === 'string' ? src.populate.split(/\s+/) : Array.isArray(src.populate) ? src.populate : []
      const allowed = wanted.filter(p => populable.has(p))
      if (allowed.length) out.populate = allowed
    }
    return out
  }

  // Protected roots are dropped silently (forms send the whole document back).
  const accepts = (field, deny) => {
    const root = rootOf(field)
    return !deny.has(root) && (!writable || writable.has(root))
  }
  const denySet = (extraDeny) => extraDeny?.length ? new Set([...denied, ...extraDeny]) : denied

  // Returns a FLAT update (plain keys, dotted paths allowed, optional $unset):
  // Mongoose wraps it in $set, and model hooks reading `update.x` keep working.
  const update = (body, extraDeny) => {
    if (!isPlainObject(body)) throw bad('Invalid request body', 'invalid_body')
    const deny = denySet(extraDeny)
    const out = {}
    const unset = {}
    const put = (field, value) => { if (accepts(field, deny)) { assertNoOperators(value, field); out[field] = value } }
    for (const key in body) {
      const value = body[key]
      if (key === '$set') {
        if (!isPlainObject(value)) throw bad('Invalid $set', 'invalid_body')
        for (const field in value) put(field, value[field])
      } else if (key === '$unset') {
        if (!isPlainObject(value)) throw bad('Invalid $unset', 'invalid_body')
        for (const field in value) if (accepts(field, deny)) unset[field] = ''
      } else if (key[0] === '$') {
        throw bad(`Operator not allowed: ${key}`, 'invalid_body')
      } else put(key, value)
    }
    if (Object.keys(unset).length) out.$unset = unset
    if (!Object.keys(out).length) throw bad('No valid fields to update', 'invalid_body')
    return out
  }

  const create = (item, extraDeny) => {
    if (!isPlainObject(item)) throw bad('Invalid request body', 'invalid_body')
    const deny = denySet(extraDeny)
    const out = {}
    for (const key in item) {
      if (!accepts(key, deny)) continue
      assertNoOperators(item[key], key)
      out[key] = item[key]
    }
    return out
  }

  return { filter: (raw) => { budget = 0; return walk(raw ?? {}, 1) }, options, update, create }
}

const createSanitizer = (config) => Object.freeze(compile(config))

// Standalone helpers: compiled once per config object (or the defaults).
const compiled = new WeakMap()
const defaults = createSanitizer()
const forConfig = (config) => {
  if (!config) return defaults
  if (!compiled.has(config)) compiled.set(config, createSanitizer(config))
  return compiled.get(config)
}
const sanitizeFilter = (raw, config) => forConfig(config).filter(raw)
const sanitizeOptions = (raw, config) => forConfig(config).options(raw)
const sanitizeUpdate = (body, config, extraDeny) => forConfig(config).update(body, extraDeny)
const sanitizeCreate = (item, config, extraDeny) => forConfig(config).create(item, extraDeny)

export {
  CrudifyError,
  DEFAULT_OPERATORS,
  createSanitizer,
  escapeRegex,
  isPlainObject,
  parseJson,
  sanitizeCreate,
  sanitizeFilter,
  sanitizeOptions,
  sanitizeUpdate
}
