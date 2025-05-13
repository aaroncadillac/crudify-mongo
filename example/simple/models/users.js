import mongoose from 'mongoose';
import paginate from 'mongoose-paginate-v2';

const Schema = mongoose.Schema;

const userSchema = new Schema({
  name: {
    type: String,
    required: true
  },
  lastName: {
    type: String,
    required: true
  },
  email: {
    type: String,
    required: true
  },
  username: {
    type: String,
    required: true
  },
  phone: {
    type: String,
    required: true
  }
}, {
  timestamps: true
});

userSchema.plugin(paginate);

const UserModel = mongoose.model('Users', userSchema);

export {
  UserModel
}