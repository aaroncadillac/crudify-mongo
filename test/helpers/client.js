// Tests talk to a real server on an ephemeral port with fetch(): Fastify 5's
// inject() pulls in an ESM-only dependency that Jest's CJS runtime can't load.
export const enc = (value) => encodeURIComponent(JSON.stringify(value))

export const boot = async (Fastify, register, fastifyOptions = {}) => {
  const app = Fastify({ logger: false, ...fastifyOptions })
  await register(app)
  await app.listen({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${app.server.address().port}`

  const req = async ({ method = 'GET', url, payload, headers = {} }) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(payload !== undefined && { 'content-type': 'application/json' }), ...headers },
      body: payload === undefined ? undefined : JSON.stringify(payload)
    })
    const body = await res.text()
    return { statusCode: res.status, body, headers: Object.fromEntries(res.headers), json: () => JSON.parse(body) }
  }
  return { app, req, close: () => app.close() }
}
