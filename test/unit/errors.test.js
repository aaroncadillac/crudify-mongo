import { describe, it, expect } from '@jest/globals'
import { CrudifyError, composeFilter, duplicateKeyFields, isDuplicateKeyError, toErrorResponse } from '../../crudify.js'

// C7 (500 with err.message), C8 (inconsistent validation errors)

const named = (name, props = {}) => Object.assign(new Error('internal detail: db.users'), { name }, props)
const MONGO_E11000 = Object.assign(
  new Error('E11000 duplicate key error collection: shop.users index: email_1 dup key: { email: "ana@example.com" }'),
  { code: 11000, keyPattern: { email: 1 }, keyValue: { email: 'ana@example.com' } }
)

describe('isDuplicateKeyError / duplicateKeyFields', () => {
  it('recognises code, cause and bulk writeErrors', () => {
    expect(isDuplicateKeyError(MONGO_E11000)).toBe(true)
    expect(isDuplicateKeyError(Object.assign(new Error('x'), { cause: { code: 11000 } }))).toBe(true)
    expect(isDuplicateKeyError(Object.assign(new Error('x'), { writeErrors: [{ code: 11000 }] }))).toBe(true)
    expect(isDuplicateKeyError(Object.assign(new Error('x'), { writeErrors: [{ err: { code: 11000 } }] }))).toBe(true)
    expect(isDuplicateKeyError(new Error('x'))).toBe(false)
    expect(isDuplicateKeyError(null)).toBe(false)
  })

  it('reads the colliding fields from keyPattern, keyValue or the message', () => {
    expect(duplicateKeyFields(MONGO_E11000)).toEqual(['email'])
    expect(duplicateKeyFields({ code: 11000, keyValue: { a: 1, b: 2 } })).toEqual(['a', 'b'])
    expect(duplicateKeyFields({ code: 11000, message: 'E11000 ... index: username_1 dup key' })).toEqual(['username'])
    expect(duplicateKeyFields({ cause: { code: 11000, keyPattern: { sku: 1 } } })).toEqual(['sku'])
    expect(duplicateKeyFields(new Error('nothing'))).toEqual([])
  })
})

describe('toErrorResponse', () => {
  it('passes CrudifyError through with the 404 body shape used since 1.x', () => {
    const { status, body } = toErrorResponse(new CrudifyError(404, 'ID: 1 not found'))
    expect(status).toBe(404)
    expect(body).toEqual({ status: 404, error: 'Not Found', message: 'ID: 1 not found' })
  })

  it('keeps code and details of a CrudifyError', () => {
    const { body } = toErrorResponse(new CrudifyError(422, 'nope', { code: 'custom', details: { a: 1 } }))
    expect(body).toEqual({ status: 422, error: 'Unprocessable Entity', message: 'nope', code: 'custom', details: { a: 1 } })
  })

  it('trusts any 4xx error (Fastify validation, parser, http errors)', () => {
    const { status, body } = toErrorResponse(Object.assign(new Error('body must be object'), { statusCode: 400, code: 'FST_ERR_VALIDATION' }))
    expect(status).toBe(400)
    expect(body.message).toBe('body must be object')
    expect(body.code).toBe('FST_ERR_VALIDATION')
  })

  it('maps E11000 to a generic 409 that never leaks collection, index or value', () => {
    const { status, body, level, meta } = toErrorResponse(MONGO_E11000)
    expect(status).toBe(409)
    expect(body).toEqual({ status: 409, error: 'Conflict', message: 'Duplicate key', code: 'duplicate_key' })
    expect(JSON.stringify(body)).not.toMatch(/ana@example|users|email_1|shop/)
    expect(level).toBe('warn')
    expect(meta).toEqual({ fields: ['email'] })
  })

  it('maps a required ValidationError with the 1.x message', () => {
    const err = named('ValidationError', { errors: { name: { kind: 'required' }, age: { kind: 'min' }, email: { kind: 'required' } } })
    const { status, body } = toErrorResponse(err)
    expect(status).toBe(400)
    expect(body.message).toBe('Fields: [name, email] are required and cannot be empty')
    expect(body.code).toBe('validation_error')
  })

  it('maps other ValidationErrors to field names only (custom messages stay private)', () => {
    const err = named('ValidationError', { errors: { age: { kind: 'min', message: 'secret rule text' } } })
    const { status, body } = toErrorResponse(err)
    expect(status).toBe(400)
    expect(body.message).toBe('Invalid fields: [age]')
    expect(body.details).toEqual({ fields: ['age'] })
    expect(JSON.stringify(body)).not.toContain('secret rule text')
  })

  it('maps CastError / StrictModeError to 400, DocumentNotFoundError to 404, VersionError to 409', () => {
    expect(toErrorResponse(named('CastError', { path: '_id' })).body.message).toBe('Invalid value for "_id"')
    expect(toErrorResponse(named('StrictModeError', { path: 'x' })).status).toBe(400)
    expect(toErrorResponse(named('DocumentNotFoundError')).status).toBe(404)
    const v = toErrorResponse(named('VersionError'))
    expect(v.status).toBe(409)
    expect(v.body.code).toBe('version_conflict')
  })

  it('hides every other error behind a generic 500 and asks to log it', () => {
    const { status, body, level } = toErrorResponse(new Error('connect ECONNREFUSED 10.0.0.5:27017 password=hunter2'))
    expect(status).toBe(500)
    expect(body).toEqual({ status: 500, error: 'Internal Server Error', message: 'Internal error' })
    expect(JSON.stringify(body)).not.toContain('hunter2')
    expect(level).toBe('error')
    expect(toErrorResponse(undefined).status).toBe(500)
    expect(toErrorResponse('boom').status).toBe(500)
  })
})

describe('composeFilter', () => {
  it('returns the base untouched for an empty scope', () => {
    const base = { a: 1 }
    expect(composeFilter(base, {})).toBe(base)
  })
  it('merges disjoint keys into the (fresh) base and never mutates the scope', () => {
    const scope = Object.freeze({ accountId: 'A' })
    expect(composeFilter({ _id: '1' }, scope)).toEqual({ _id: '1', accountId: 'A' })
  })
  it('wraps both in $and when a key collides, so the client cannot override the scope', () => {
    expect(composeFilter({ accountId: 'B' }, { accountId: 'A' })).toEqual({ $and: [{ accountId: 'B' }, { accountId: 'A' }] })
    expect(composeFilter({ $or: [{ x: 1 }] }, { $or: [{ y: 1 }] })).toEqual({ $and: [{ $or: [{ x: 1 }] }, { $or: [{ y: 1 }] }] })
    expect(composeFilter({ _id: '1' }, { _id: '2' })).toEqual({ $and: [{ _id: '1' }, { _id: '2' }] })
  })
})
