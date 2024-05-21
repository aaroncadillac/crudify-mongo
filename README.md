# Crudify Mongo

[![License: MPL-2.0](https://img.shields.io/badge/License-MPL--2.0-blue.svg)](https://opensource.org/licenses/MPL-2.0)

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

| Route | Description | Additional built-in benefits |
|-------|-------------|----|
| `GET /` | Get all documents | `Pagination` `Filtering` `Sorting` |
| `GET /:id` | Get a document by id | `Not-Found validation`|
| `POST /` | Create a document | `Schema validation`|
| `PUT /:id` | Update a document by id | `Not-Found validation` `Schema validation`|
| `DELETE /:id` | Delete a document by id | `Not-Found validation` |

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

## Getting started

### Installation

```bash
yarn install crudify-mongo
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

