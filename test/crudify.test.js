import fastify from 'fastify';
import { Crudify } from '../crudify';
import mongoose, { connect, Schema, model } from 'mongoose';
import paginate from 'mongoose-paginate-v2';
import request from 'supertest';

let app;
let UserModel;
let connection;

beforeAll(async () => {
    app = fastify();
    await connect(global.__MONGO_URI__, {
        useNewUrlParser: true,
        useUnifiedTopology: true,
    });
    connection = mongoose.connection
    const userSchema = new Schema({ name: String, age: Number, email: String });
    userSchema.plugin(paginate);
    UserModel = model('User', userSchema);
    app.register(Crudify, { url: '/users', Model: UserModel });
    await app.ready();
});

afterAll(async () => {
    await connection.dropDatabase();
    await connection.close();
    await app.close();
});

describe('CRUD Operations', () => {
    it('should create a user', async () => {
        const response = await request(app.server)
            .post('/users')
            .send({ name: 'John', age: 30, email: 'john@example.com' });
        expect(response.status).toBe(201);
        expect(response.body).toHaveProperty('_id');
    });

    it('should get all users', async () => {
        const response = await request(app.server).get('/users');
        console.log(response.body)
        expect(response.status).toBe(200);
        expect(response.body.docs).toBeInstanceOf(Array);
    });

    it('should get a user by id', async () => {
        const newUser = await request(app.server)
            .post('/users')
            .send({ name: 'Jane', age: 25, email: 'jane@example.com' });
        const userId = newUser.body._id;
        const response = await request(app.server).get(`/users/${userId}`);
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('_id', userId);
    });

    it('should update a user', async () => {
        const newUser = await request(app.server)
            .post('/users')
            .send({ name: 'Mark', age: 28, email: 'mark@example.com' });
        const userId = newUser.body._id;
        const response = await request(app.server)
            .put(`/users/${userId}`)
            .send({ age: 29 });
        expect(response.status).toBe(200);
        expect(response.body).toHaveProperty('age', 29);
    });

    it('should delete a user', async () => {
        const newUser = await request(app.server)
            .post('/users')
            .send({ name: 'Paul', age: 35, email: 'paul@example.com' });
        const userId = newUser.body._id;
        const response = await request(app.server).delete(`/users/${userId}`);
        expect(response.status).toBe(200);
    });
});