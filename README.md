# Crudify Mongo

[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-blue.svg)](https://opensource.org/licenses/MPL-2.0)
![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/aaroncadillac/crudify-mongo/test.yml)
![NPM Version](https://img.shields.io/npm/v/%40aaroncadillac%2Fcrudify-mongo)


An automatic CRUD generator for [fastify](https://fastify.dev) and MongoDB, using [mongoose](https://mongoosejs.com),a nd adding basic features like pagination, filtering, and sorting.

## Table of contents

- [Features](#features)
    - [Automatic CRUD generation](#automatic-crud-generation)
    - [Custom routes](#custom-routes)
- [Getting started](#getting-started)
  - [Installation](#installation)
  - [Usage](#usage)
- [Aknowledgements](#aknowledgements)
- [License](#license)

## Pre-requisites

- [Fastify](https://fastify.dev) v4 or higher
- [Mongoose](https://mongoosejs.com) v8 or higher
- [mongoose-paginate-v2](https://www.npmjs.com/package/mongoose-paginate-v2) v1.8 or higher
  
## Features

### Automatic CRUD generation

You can automatically enjoy the following CRUD operations:

| Route | Description | Additional built-in benefits |How to use|
|-------|-------------|----|---|
| `GET /` | Get all documents | `Pagination` `Filtering` `Sorting` |query parameters: `filters` and `options` for more details see [mongoose-paginate-v2 documentation](https://github.com/aravindnc/mongoose-paginate-v2#readme) |
| `GET /:id` | Get a document by id | `Not-Found validation`|Activated by default|
| `POST /` | Create a document | `Schema validation`|Activated by default|
| `PUT /:id` | Update a document by id | `Not-Found validation` `Schema validation`|Activated by default|
| `DELETE /:id` | Delete a document by id | `Not-Found validation` |Activated by default|

### Custom routes

You can add custom routes to the CRUD, to increase the functionality of your API, you only need to pass the route configuration to the plugin.

```js
const routes = ( fastify, opts, done ) => {
  fastify.register(Crudify, {
    url: '/users',
    Model: UserModel,
    additionalRoutes: [
      {
        method: 'GET',
        url: '/:id/light-details',
        handler: LightDetailsUserHandler
      },
      ...
    ]
  })
```

### Swagger auto-documentation (WIP)

> If you need to integrate Swagger auto-documentation, is necessary to export and process mongoose model to define schemas into `openapi.json`, this module is under development.

You can add Swagger auto-documentation to your API, using the [`@fastify/swagger`](https://github.com/fastify/fastify-swagger) and [`@fastify/swagger-ui`](https://github.com/fastify/fastify-swagger-ui) plugins.

Once you have those plugins installed, you can use the following code to add Swagger auto-documentation to your API:

```js
// server.js

import 'dotenv/config';
import Fastify from 'fastify'
import { dbConnection } from './db-connection.js';
import { routes } from './routes.js';
import * as Swagger  from '@fastify/swagger'
import * as SwaggerUI from '@fastify/swagger-ui'

const fastify = Fastify({
  logger: true
})

fastify.register(await dbConnection)
process.env.NODE_ENV == 'development' && fastify.register(Swagger) && await fastify.register(SwaggerUI, {
  routePrefix: '/docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: true
  },
  uiHooks: {
    onRequest: function (request, reply, next) { next() },
    preHandler: function (request, reply, next) { next() }
  },
  staticCSP: true,
  transformStaticCSP: (header) => header,
  transformSpecification: (swaggerObject, request, reply) => { return swaggerObject },
  transformSpecificationClone: true
})

fastify.register(routes)

fastify.listen({ port: process.env.PORT || 3000, host: process.env.HOST || 'localhost' }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
```

As you can see in the code above, you only need to import the `@fastify/swagger` and `@fastify/swagger-ui` plugins, and then use the `fastify.register` method to register the plugins., you even can customize your swagger documentation path and enable documentation only in development environment (recommended).

### Body and Response schema auto generation

To help you to use Swagger `crudify-mongo 1.5.0+` supports `body` and `response` schema auto generation, this feature is enable by default and you only need to install [`mongoose-schema-jsonschema`](https://github.com/DScheglov/mongoose-schema-jsonschema) to use it, this dependency helps you to use your mongoose model schema as a json schema compatible with fastify specification based on [AJV schema validation](https://ajv.js.org).

Here an example

```js
// models/user.js

import mongoose from 'mongoose';
import paginate from 'mongoose-paginate-v2'; // Required for pagination
import extendMongoose from 'mongoose-schema-jsonschema'; // Required for body and response schema auto generation

extendMongoose(mongoose);

const Schema = mongoose.Schema;

const userSchema = new Schema({
  name: {
    type: String,
    required: true,
  },
  age: {
    type: Number,
    required: true,
  },
  email: {
    type: String,
    required: true,
  },
}, {
  timestamps: true,
});

userSchema.plugin(paginate);

const UserSchema = userSchema.jsonSchema();
const UserModel = mongoose.model('Users', userSchema);

export {
  UserModel,
  UserSchema
}
```

Then you need to add on the `JSONSchema` property of your fastify routes

```js
// routes.js
import { Crudify } from '@aaroncadillac/crudify-mongo';
import { UserModel, UserSchema } from './models/user.js';

const routes = ( fastify, opts, done ) => {
  fastify.register(Crudify, {
    url: '/users',
    Model: UserModel
    JSONSchema: UserSchema
  })
}
```

## Getting started

### Installation

```bash
yarn add @aaroncadillac/crudify-mongo
```

### Usage

First, you need to create a mongoose model, and use the `mongoose-paginate-v2` plugin to enable pagination.

```js
// models/user.js

import mongoose from 'mongoose';
import paginate from 'mongoose-paginate-v2'; // Required for pagination

const Schema = mongoose.Schema;

const userSchema = new Schema({
  name: {
    type: String,
    required: true,
  },
  age: {
    type: Number,
    required: true,
  },
  email: {
    type: String,
    required: true,
  },
}, {
  timestamps: true,
});

userSchema.plugin(paginate);

const UserModel = mongoose.model('Users', userSchema);

export {
  UserModel
}
```

Then, I suggest to separate DB connection into a module, and connect to the database, this will be an async fastify plugin.

```js
// db-connection.js

import mongoose from 'mongoose';

const dbConnection = async ( fastify ) => {
  try {
    await mongoose.connect(`${process.env.MONGODB_URL}/${process.env.MONGO_DATABASE}${process.env.MONGO_OPTIONS && `?${process.env.MONGO_OPTIONS}`}`);
    fastify.log.info('Connected to database');
  }
  catch (error) {
    fastify.log.error('Error connecting to database');
  }
}

export {
  dbConnection
}
```

Then, you can create the server file, and register the CRUD plugin.

```js
// server.js

import fastify from 'fastify';
import Crudify from 'crudify-mongo';
import { dbConnection } from './db-connection';
import { UserModel } from './models/user';

const fastify = Fastify({
  logger: true
})

const routes = ( fastify, opts, done ) => {
  fastify.register(Crudify, {
    url: '/users',
    Model: UserModel
  })
}

fastify.register(await dbConnection)
fastify.register(routes)


fastify.listen({ port: process.env.PORT || 3000, host: process.env.HOST || 'localhost' }, function (err, address) {
  if (err) {
    fastify.log.error(err)
    process.exit(1)
  }
})
```

Simple as that, you have a CRUD for the `User` model and could be accessed through the `/users` route.

## Aknowledgements

This plugin is inspired by [fastify-mongoose-crud](https://github.com/paranoiasystem/fastify-autocrud)

## License

[Mozilla Public License 2.0](/LICENSE)

