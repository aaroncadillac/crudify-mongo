import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import mongoose from 'mongoose'
import { buildApp } from '../../example/app.js'

// C17 / C22: the example runs as written, with @fastify/auth, two tenants and an action.
describe('example app', () => {
  let app, base
  const ana = { authorization: 'Bearer token-ana' }
  const ben = { authorization: 'Bearer token-ben' }
  const call = async (method, url, headers, payload) => {
    const res = await fetch(base + url, {
      method,
      headers: payload ? { ...headers, 'content-type': 'application/json' } : headers,
      body: payload && JSON.stringify(payload)
    })
    return { status: res.status, body: await res.json() }
  }

  beforeAll(async () => {
    await mongoose.connect(global.__MONGO_URI__, { dbName: global.__MONGO_DB_NAME__ })
    app = await buildApp()
    await app.listen({ port: 0, host: '127.0.0.1' })
    base = `http://127.0.0.1:${app.server.address().port}`
  })
  afterAll(async () => { await app.close(); await mongoose.disconnect() })

  it('rejects unauthenticated requests', async () => {
    const res = await fetch(base + '/posts')
    expect(res.status).toBe(401)
  })

  it('isolates accounts, enforces roles and exposes the publish action', async () => {
    const created = await call('POST', '/posts', ana, { title: 'Hello', content: 'World', status: 'published' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ accountId: 'A', status: 'draft' }) // client-sent status ignored (read-only)
    const id = created.body._id

    expect((await call('GET', `/posts/${id}`, ben)).status).toBe(404) // other account
    expect((await call('GET', '/posts', ben)).body.docs).toHaveLength(0)
    const denied = await call('POST', '/posts', ben, { title: 'x', content: 'y' })
    expect(denied.status).toBe(403)
    expect(denied.body.code).toBe('admin_required')

    expect((await call('POST', `/posts/${id}/publish`, ben)).status).toBe(403)
    const published = await call('POST', `/posts/${id}/publish`, ana)
    expect(published.body.status).toBe('published')
  })

  it('never exposes select:false fields', async () => {
    const user = await call('POST', '/users', ana, { name: 'Ana', email: 'ana@example.com', passwordHash: 'x' })
    expect(user.status).toBe(201)
    expect((await call('GET', `/users?filters=${encodeURIComponent(JSON.stringify({ passwordHash: { $gt: '' } }))}`, ana)).status).toBe(400)
  })
})
