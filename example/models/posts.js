import mongoose from 'mongoose'
import paginate from 'mongoose-paginate-v2'

const postsSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  accountId: { type: String, required: true, index: true },
  status: { type: String, enum: ['draft', 'published'], default: 'draft' }
}, { timestamps: true })

postsSchema.plugin(paginate)

const PostsModel = mongoose.models.Posts ?? mongoose.model('Posts', postsSchema)

export { PostsModel }
