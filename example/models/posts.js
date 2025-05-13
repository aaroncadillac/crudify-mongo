import mongoose from 'mongoose';
import paginate from 'mongoose-paginate-v2';

const Schema = mongoose.Schema;

const postsSchema = new Schema({
  title: {
    type: String,
    required: true
  },
  content: {
    type: String,
    required: true
  },
  author: {
    type: Schema.Types.ObjectId,
    ref: 'Users',
    required: true
  }
}, {
  timestamps: true,
});

postsSchema.plugin(paginate);

const PostsModel = mongoose.model('Users', postsSchema);

export {
  PostsModel
}