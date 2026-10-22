import { describe, it, expect } from '@jest/globals'
import {
  CrudifyError, DEFAULT_OPERATORS, createSanitizer, escapeRegex, parseJson,
  sanitizeCreate, sanitizeFilter, sanitizeOptions, sanitizeUpdate
} from '../../sanitizer.js'

// C1 (raw operators), C2 (client regex), C3 (options), C5 (mass assignment), C20 (hidden fields)

const deepFreeze = (o) => { Object.values(o).forEach(v => v && typeof v === 'object' && deepFreeze(v)); return Object.freeze(o) }
const rejects = (fn, status = 400) => {
  try { fn() } catch (err) {
    expect(err).toBeInstanceOf(CrudifyError)
    expect(err.statusCode).toBe(status)
    return err
  }
  throw new Error('expected a CrudifyError')
}

describe('sanitizeFilter', () => {
  it('keeps plain fields, comparison operators and $or / $and', () => {
    const filter = { status: 'open', n: { $gte: 1, $lt: 9 }, tag: { $in: ['a', 'b'] }, $or: [{ a: 1 }, { $and: [{ b: 2 }] }] }
    expect(sanitizeFilter(filter)).toEqual(filter)
  })

  it('turns "/text/" into an escaped, case-insensitive literal (never a client regex)', () => {
    const { name } = sanitizeFilter({ name: '/a.b(c)+/' })
    expect(name).toBeInstanceOf(RegExp)
    expect(name.flags).toBe('i')
    expect(name.source).toBe(escapeRegex('a.b(c)+'))
    expect(name.test('xA.B(C)+x')).toBe(true)
    expect(name.test('axb(c)+')).toBe(false)
  })

  it('cannot be ReDoSed: a catastrophic pattern is just a literal', () => {
    const { name } = sanitizeFilter({ name: '/(a+)+$/' })
    const started = performance.now()
    name.test('a'.repeat(40) + '!')
    expect(performance.now() - started).toBeLessThan(50)
  })

  it('supports search "prefix" (index friendly) and search false (left untouched)', () => {
    const prefix = sanitizeFilter({ name: '/ab/' }, { search: 'prefix' }).name
    expect(prefix.source).toBe('^ab')
    expect(prefix.flags).toBe('')
    expect(sanitizeFilter({ name: '/ab/' }, { search: false })).toEqual({ name: '/ab/' })
  })

  it('limits the search length', () => {
    rejects(() => sanitizeFilter({ name: `/${'a'.repeat(65)}/` }))
    expect(() => sanitizeFilter({ name: `/${'a'.repeat(64)}/` })).not.toThrow()
  })

  it.each([
    [{ $where: '1' }],
    [{ $expr: { $eq: [1, 1] } }],
    [{ a: { $regex: '^x' } }],
    [{ a: { $function: {} } }],
    [{ a: { $text: 'x' } }],
    [{ a: { $elemMatch: { b: 1 } } }],
    [{ a: { $foo: 1 } }],
    [{ a: { b: 1 } }], // sub-object without operators
    [{ a: { $in: 'x' } }],
    [{ a: { $in: [{ $ne: 1 }] } }],
    [{ a: { $exists: 'yes' } }],
    [{ a: { $gt: { $ne: 1 } } }],
    [{ $or: [] }],
    [{ $or: 'x' }],
    [[]],
    ['a']
  ])('rejects %j', (filter) => { rejects(() => sanitizeFilter(filter)) })

  it('rejects unsafe or malformed field names', () => {
    for (const key of ['__proto__', 'constructor', 'a.__proto__', 'a..b', '', 'a$b']) {
      rejects(() => sanitizeFilter(JSON.parse(`{${JSON.stringify(key)}: 1}`)))
    }
  })

  it('bounds depth, keys, branches and arrays', () => {
    rejects(() => sanitizeFilter({ $or: [{ $or: [{ $or: [{ $or: [{ a: 1 }] }] }] }] }))
    const many = Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, 1]))
    rejects(() => sanitizeFilter(many))
    rejects(() => sanitizeFilter({ $or: Array.from({ length: 21 }, () => ({ a: 1 })) }))
    rejects(() => sanitizeFilter({ a: { $in: Array.from({ length: 1001 }, (_, i) => i) } }))
    expect(() => sanitizeFilter({ $or: Array.from({ length: 21 }, () => ({ a: 1 })) }, { maxBranches: 30 })).not.toThrow()
  })

  it('only allows the configured operators; extra ones are opt-in', () => {
    rejects(() => sanitizeFilter({ a: { $size: 2 } }))
    expect(sanitizeFilter({ a: { $size: 2 }, b: { $all: [1] }, $nor: [{ c: 1 }] }, { operators: [...DEFAULT_OPERATORS, '$size', '$all', '$nor'] }))
      .toEqual({ a: { $size: 2 }, b: { $all: [1] }, $nor: [{ c: 1 }] })
    rejects(() => sanitizeFilter({ a: { $ne: 1 } }, { operators: ['$eq'] }))
  })

  it('refuses to be configured with a dangerous or unknown operator', () => {
    for (const op of ['$where', '$regex', '$expr', '$text', '$nope']) {
      expect(() => createSanitizer({ operators: [op] })).toThrow(TypeError)
    }
  })

  it('hides fields (C20) and honours a "filterable" allowlist, also on dotted paths', () => {
    const cfg = { hidden: ['secret'] }
    rejects(() => sanitizeFilter({ secret: { $gt: 'a' } }, cfg))
    rejects(() => sanitizeFilter({ 'secret.x': 1 }, cfg))
    rejects(() => sanitizeFilter({ $or: [{ secret: 1 }] }, cfg))
    expect(sanitizeFilter({ name: 'x' }, cfg)).toEqual({ name: 'x' })
    rejects(() => sanitizeFilter({ other: 1 }, { filterable: ['name'] }))
    expect(sanitizeFilter({ name: 1 }, { filterable: ['name'] })).toEqual({ name: 1 })
  })

  it('never mutates its input', () => {
    const input = deepFreeze({ a: '/x/', $or: [{ b: { $in: [1] } }] })
    expect(() => sanitizeFilter(input)).not.toThrow()
  })

  it('treats null/undefined as an empty filter', () => {
    expect(sanitizeFilter(undefined)).toEqual({})
    expect(sanitizeFilter(null)).toEqual({})
  })
})

describe('sanitizeOptions', () => {
  it('defaults to page 1, limit 50 and pagination on', () => {
    expect(sanitizeOptions(undefined)).toEqual({ page: 1, limit: 50, pagination: true })
  })

  it('caps the limit and repairs nonsense (C3)', () => {
    expect(sanitizeOptions({ limit: 5000 }).limit).toBe(100)
    expect(sanitizeOptions({ limit: -3 }).limit).toBe(50)
    expect(sanitizeOptions({ limit: 'abc' }).limit).toBe(50)
    expect(sanitizeOptions({ limit: 7.9 }).limit).toBe(7)
    expect(sanitizeOptions({ page: 'x' }).page).toBe(1)
    expect(sanitizeOptions({ page: Infinity }).page).toBe(1)
    expect(sanitizeOptions({ page: 3 }).page).toBe(3)
    expect(sanitizeOptions({ limit: 500 }, { maxLimit: 1000 }).limit).toBe(500)
    expect(sanitizeOptions({}, { defaultLimit: 10, maxLimit: 20 }).limit).toBe(10)
  })

  it('ignores everything that is not page / limit / sort', () => {
    const out = sanitizeOptions({
      page: 2, limit: 5, select: '+secret', projection: { secret: 1 }, lean: true, collation: { locale: 'en' },
      pagination: false, offset: 99, populate: 'owner', customLabels: {}, allowDiskUse: true
    })
    expect(out).toEqual({ page: 2, limit: 5, pagination: true })
  })

  it('parses sort as a string or an object and bounds it', () => {
    expect(sanitizeOptions({ sort: '-createdAt name' }).sort).toEqual({ createdAt: -1, name: 1 })
    expect(sanitizeOptions({ sort: { a: 'asc', b: -1, c: 'desc', d: 1 } }).sort).toEqual({ a: 1, b: -1, c: -1, d: 1 })
    rejects(() => sanitizeOptions({ sort: 'a;b' }))
    rejects(() => sanitizeOptions({ sort: { a: 'sideways' } }))
    rejects(() => sanitizeOptions({ sort: 42 }))
    rejects(() => sanitizeOptions({ sort: 'a b c d e f' }))
    rejects(() => sanitizeOptions({ sort: JSON.parse('{"__proto__": 1}') }))
    expect(sanitizeOptions({ sort: 'a b c d e f' }, { maxSort: 6 }).sort).toBeDefined()
  })

  it('does not let hidden or non-filterable fields be used to sort (C20)', () => {
    rejects(() => sanitizeOptions({ sort: 'secret' }, { hidden: ['secret'] }))
    rejects(() => sanitizeOptions({ sort: '-secret.x' }, { hidden: ['secret'] }))
    rejects(() => sanitizeOptions({ sort: 'other' }, { filterable: ['name'] }))
  })

  it('populates only allowlisted paths', () => {
    expect(sanitizeOptions({ populate: 'owner' })).not.toHaveProperty('populate')
    const cfg = { populate: ['owner', 'tags'] }
    expect(sanitizeOptions({ populate: 'owner secret' }, cfg).populate).toEqual(['owner'])
    expect(sanitizeOptions({ populate: ['tags', 'x'] }, cfg).populate).toEqual(['tags'])
    expect(sanitizeOptions({ populate: 'nope' }, cfg)).not.toHaveProperty('populate')
  })
})

describe('sanitizeUpdate', () => {
  it('drops protected fields silently (forms send the whole document back)', () => {
    const out = sanitizeUpdate({ name: 'n', _id: 'x', createdAt: 1, updatedAt: 2, __v: 3, owner: 'z' }, { readonly: ['owner'] })
    expect(out).toEqual({ name: 'n' })
  })

  it('drops extra denied roots such as scope keys', () => {
    expect(sanitizeUpdate({ name: 'n', accountId: 'B' }, undefined, ['accountId'])).toEqual({ name: 'n' })
  })

  it('accepts dotted paths, flat $set and $unset; the output is flat', () => {
    expect(sanitizeUpdate({ 'products.2.status': 'done', $set: { a: 1 }, $unset: { b: '' } }))
      .toEqual({ 'products.2.status': 'done', a: 1, $unset: { b: '' } })
  })

  it('rejects other operators, also nested inside values', () => {
    rejects(() => sanitizeUpdate({ $rename: { a: 'b' } }))
    rejects(() => sanitizeUpdate({ $inc: { a: 1 } }))
    rejects(() => sanitizeUpdate({ a: { $gt: 1 } }))
    rejects(() => sanitizeUpdate({ $set: { a: [{ $ne: 1 }] } }))
    rejects(() => sanitizeUpdate({ $set: 'x' }))
    rejects(() => sanitizeUpdate('x'))
    rejects(() => sanitizeUpdate(JSON.parse('{"__proto__": {"a": 1}}')))
    rejects(() => sanitizeUpdate({ 'a.$.b': 1 }))
  })

  it('applies a "writable" allowlist by root field', () => {
    expect(sanitizeUpdate({ name: 'n', age: 3, 'name.first': 'x' }, { writable: ['name'] })).toEqual({ name: 'n', 'name.first': 'x' })
  })

  it('fails when nothing valid is left', () => { rejects(() => sanitizeUpdate({ _id: 'x', createdAt: 1 })) })

  it('never mutates its input', () => {
    expect(() => sanitizeUpdate(deepFreeze({ a: 1, $set: { b: 2 }, $unset: { c: '' } }))).not.toThrow()
  })
})

describe('sanitizeCreate', () => {
  it('returns a new object without protected / non-writable roots', () => {
    const input = { name: 'n', _id: 'x', owner: 'z', __v: 1 }
    const out = sanitizeCreate(input, { readonly: ['owner'] })
    expect(out).toEqual({ name: 'n' })
    expect(out).not.toBe(input)
    expect(sanitizeCreate({ a: 1, b: 2 }, { writable: ['a'] })).toEqual({ a: 1 })
  })

  it('judges dotted keys by their root', () => {
    expect(sanitizeCreate({ 'owner.id': 'x', 'meta.k': 1 }, { readonly: ['owner'] })).toEqual({ 'meta.k': 1 })
    expect(sanitizeCreate({ 'accountId.x': 1, n: 1 }, undefined, ['accountId'])).toEqual({ n: 1 })
  })

  it('rejects $ keys, nested operators and non-objects', () => {
    rejects(() => sanitizeCreate({ $set: { a: 1 } }))
    rejects(() => sanitizeCreate({ a: { $gt: 1 } }))
    rejects(() => sanitizeCreate(JSON.parse('{"__proto__": 1}')))
    rejects(() => sanitizeCreate([]))
    rejects(() => sanitizeCreate('x'))
  })

  it('never mutates its input', () => { expect(() => sanitizeCreate(deepFreeze({ a: { b: [1] } }))).not.toThrow() })
})

describe('parseJson', () => {
  it('returns a fresh {} for missing or empty params', () => {
    expect(parseJson(undefined, 'filters')).toEqual({})
    expect(parseJson('', 'filters')).toEqual({})
    expect(parseJson(undefined, 'x')).not.toBe(parseJson(undefined, 'x'))
  })
  it('parses objects once and rejects everything else with a 400', () => {
    expect(parseJson('{"a":1}', 'filters')).toEqual({ a: 1 })
    rejects(() => parseJson('{oops', 'filters'))
    rejects(() => parseJson('[1]', 'filters'))
    rejects(() => parseJson('"x"', 'filters'))
    rejects(() => parseJson('null', 'filters'))
    rejects(() => parseJson(['{}', '{}'], 'filters')) // repeated query param
  })
})

describe('createSanitizer', () => {
  it('is frozen and independent between configs', () => {
    const a = createSanitizer({ maxLimit: 10 })
    const b = createSanitizer({ maxLimit: 20 })
    expect(Object.isFrozen(a)).toBe(true)
    expect(a.options({ limit: 99 }).limit).toBe(10)
    expect(b.options({ limit: 99 }).limit).toBe(20)
  })
  it('falls back to defaults for undefined config values', () => {
    expect(createSanitizer({ maxLimit: undefined, operators: undefined }).options({ limit: 999 }).limit).toBe(100)
  })
})
