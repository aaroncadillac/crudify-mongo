import mongoose from 'mongoose'
import paginate from 'mongoose-paginate-v2'

const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true },
  accountId: { type: String, required: true, index: true },
  passwordHash: { type: String, select: false } // select:false: never returned, filtered or sorted by the client
}, { timestamps: true })

userSchema.plugin(paginate)

const UserModel = mongoose.models.Users ?? mongoose.model('Users', userSchema)

export { UserModel }
