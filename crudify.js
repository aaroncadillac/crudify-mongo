function removeKeys(obj, keysToRemove) {
  if (typeof obj !== 'object' || obj === null) return;

  for (const key in obj) {
    if (keysToRemove.includes(key)) {
      delete obj[key];
    } else if (typeof obj[key] === 'object' && obj[key] !== null) {
      removeKeys(obj[key], keysToRemove);
    }
  }
}


function addPostBody(opts) {
  const schema = opts.JSONSchema
  if ( schema ) {
    const properties = {...schema.properties}
    removeKeys(properties, ['x-ref'])
    const newOpts = {
      ...opts,
      schema: {
        ...opts.schema,
        body: {
          type: schema.type,
          properties,
          required: schema.required
        }
      }
    }
    delete newOpts.schema.body.properties._id
    delete newOpts.schema.body.properties.createdAt
    delete newOpts.schema.body.properties.updatedAt
    return newOpts
  } else {
    return opts
  }
}

function addGetResponseUnitary(opts) {
  const schema = opts.JSONSchema
  if ( schema ) {
    const newOpts = {
      ...opts,
      schema: {
        response: {
          200: schema
        }
      }
    }
    return newOpts
  } else {
    return opts
  }
}

function addGetResponseArray(opts) {
  const schema = opts.JSONSchema
  if ( schema ) {
    const newOpts = {
      ...opts,
      schema: {
        response: {
          200: {
            type: 'array',
            items: schema
          }
        }
      }
    }
    return newOpts
  } else {
    return opts
  }
}

function Crudify (fastify, opts, next) {
  const optsGet = addGetResponseUnitary(opts)
  const optsGetAll = addGetResponseArray(opts)
  const optsPost = addPostBody(optsGet)
  
  fastify.get(`${opts.url}`, optsGetAll, async (req, reply) => {
    try {
      optsGetAll = { ...optsGetAll,
        schema: {
          querystring: {
            type: 'object',
            properties: {
              filters: {
                type: 'string'
              },
              pagination: {
                type: 'string'
              }
            }
          }
        }
      }
      const filterObject = JSON.parse(req.query.filters ||= '{}')
      for (const key in filterObject) {
        if (typeof filterObject[key] === 'string') {
          if (filterObject[key].startsWith('/') && filterObject[key].endsWith('/')) {
            filterObject[key] = new RegExp(filterObject[key].slice(1, -1), 'i')
          }
        }
      }
      const paginateOptions = JSON.parse(req.query.pagination ||= '{"pagination": false}')
      reply.type('application/json').code(200).send(await opts.Model.paginate(filterObject, paginateOptions))
    } catch (err) {
      throw new Error(err)
    }
  })

  fastify.get(`${opts.url}/:id`, optsGet, async (req, reply) => {
    try {
      const response = await opts.Model.findById(req.params.id)
      if (!response) {
        reply.type('application/json').code(404).send({
          status: 404,
          error: 'Not Found',
          message: `ID: ${ req.params.id } not found`
        })
      } else {
        reply.type('application/json').code(200).send(response)
      }
    } catch (err) {
      throw new Error(err)
    }
  })

  fastify.post(`${opts.url}`, optsPost, async (req, reply) => {
    try {
      await opts.Model.validate(req.body)
    } catch (err) {
      reply.type('application/json').code(400).send(err)
    }
    try {
      reply.type('application/json').code(201).send(await new opts.Model(req.body).save())
    } catch (err) {
      throw new Error(err)
    }
  })
  
  fastify.put(`${opts.url}/:id`, optsGet, async (req, reply) => {
    try {
      const response = await opts.Model.findOneAndUpdate({ _id: req.params.id }, req.body, { 
        new: true,
        runValidators: true
      })
      if (!response) {
        reply.type('application/json').code(404).send({
          status: 404,
          error: 'Not Found',
          message: `ID: ${ req.params.id } not found`
        })
      } else {
        reply.type('application/json').code(200).send(response)
      }
    } catch (err) {
      const requiredErrors = []
      for (const key in err.errors) {
        if (err.errors[key].kind === 'required') {
          requiredErrors.push(err.errors[key].path)
        }
      }
      if (requiredErrors.length > 0) {
        reply.type('application/json').code(400).send({
          status: 400,
          error: 'Bad Request',
          message: `Fields: [${ requiredErrors.join(', ') }] are required and cannot be empty`
        })
      } else {
        throw new Error(err)
      }
    }
  })

  fastify.delete(`${opts.url}/:id`, opts, async (req, reply) => {
    try {
      const response = await opts.Model.findOneAndDelete({ _id: req.params.id })
      if (!response) {
        reply.type('application/json').code(404).send({
          status: 404,
          error: 'Not Found',
          message: `ID: ${ req.params.id } not found`
        })
      } else {
        reply.type('application/json').code(200).send(response)
      }
    } catch (err) {
      throw new Error(err)
    }
  })

  if (opts.additionalRoutes) {
    opts.additionalRoutes(fastify, opts)
  } 
  
  next()
}

export {
  Crudify
}
