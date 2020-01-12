const { GraphQLScalarType } = require("graphql")
const { authorizeWithGithub } = require('./lib')
const fetch = require('node-fetch')
const { ObjectID } = require('mongodb')
const { uploadStream } = require('./lib')
const path = require('path')

const resolvers = {
  Query: {
    me: (parent, args, { currentUser }) => currentUser,

    totalPhotos: (parent, args, { db }) => db.collection('photos').estimatedDocumentCount(),
    allPhotos: (parent, args, { db }) => db.collection('photos').find().toArray(),
    photo: (parent, args, { db }) => db.collection('photos').findOne({ _id: ObjectID(args.id) }),

    totalUsers: (parent, args, { db }) => db.collection('users').estimatedDocumentCount(),
    allUsers: (parent, args, { db }) => db.collection('users').find().toArray(),
    user: (parent, args, { db }) => db.collection('users').findOne({ githubLogin: args.login })
  },

  Mutation: {
    postPhoto: async (parent, args, { db, currentUser, pubsub }) => {
      if (!currentUser) {
        throw new Error("only an authorized user can post a photo")
      }

      const newPhoto = {
        ...args.input,
        userID: currentUser.githubLogin,
        created: new Date()
      }

      const { insertedId } = await db.collection('photos').insertOne(newPhoto)
      newPhoto.id = insertedId

      let toPath = path.join(__dirname, 'assets', 'photos', `${newPhoto.id}.jpg`)

      const { createReadStream } = await args.input.file
      const stream = createReadStream()
      await uploadStream(stream, toPath)

      pubsub.publish('photo-added', { newPhoto })

      return newPhoto
    },

    tagPhoto: async (parent, args, { db }) => {
      await db.collection('tags')
        .replaceOne(args, args, { upsert: true })
      
      return db.collection('photos')
        .findOne({ _id: ObjectID(args.photoID) })
    },

    githubAuth: async (parent, { code }, { db, pubsub }) => {
      let { message, access_token, avatar_url, login, name } = await authorizeWithGithub({
        client_id: process.env.CLIENT_ID,
        client_secret: process.env.CLIENT_SECRET,
        code
      })
    
      if (message) {
        throw new Error(message)
      }
    
      let latestUserInfo = { name, githubLogin: login, githubToken: access_token, avatar: avatar_url }
      const { ops: [user], result } = await db.collection('users')
        .replaceOne({ githubLogin: login }, latestUserInfo, { upsert: true })
      
      result.upserted && pubsub.publish('user-added', { newUser: user })
      
      return { user, token: access_token }
    },

    addFakeUsers: async (parent, { count }, { db, pubsub }) => {
      var randomUserAPI = `https://randomuser.me/api/?results=${count}`
      var { results } = await fetch(randomUserAPI)
        .then(res => res.json())

      var users = results.map(r => ({
        githubLogin: r.login.username,
        name: `${r.name.first} ${r.name.last}`,
        avatar: r.picture.thumbnail,
        githubToken: r.login.sha1
      }))

      await db.collection('users').insert(users)

      var newUsers = await db.collection('users')
        .find()
        .sort({ _id: -1 })
        .limit(count)
        .toArray()
      
      newUsers.forEach(newUser => pubsub.publish('user-added', { newUser }))

      return users
    },

    fakeUserAuth: async (parent, { githubLogin }, { db }) => {
      var user = await db.collection('users').findOne({ githubLogin })

      if (!user) {
        throw new Error(`Cannot find user with githubLogin "${githubLogin}"`)
      }

      return { token: user.githubToken, user }
    }
  },

  Subscription: {
    newPhoto: {
      subscribe: (parent, args, { pubsub }) => pubsub.asyncIterator('photo-added')
    },

    newUser: {
      subscribe: (parent, args, { pubsub }) => pubsub.asyncIterator('user-added')
    }
  },

  Photo: {
    id: parent => parent.id || parent._id,
    url: parent => `/img/photos/${parent._id}.jpg`,
    postedBy: (parent, args, { db }) => db.collection('users').findOne({ githubLogin: parent.userID }),

    taggedUsers: async (parent, args, { db }) => {
      const tags = await db.collection('tags').find().toArray()

      const login = tags
        .filter(t => t.photoID === parent._id.toString())
        .map(t => t.githubLogin)

      return db.collection('users').find({ githubLogin: { $in: logins } }).toArray()
    }
  },

  User: {
    postedPhotos: (parent, args, { db }) => db.collection("photos").find({ userID: parent.githubLogin }).toArray(),

    inPhotos: async (parent, args, { db }) => {
      const tags = await db.collection('tags').find().toArray()

      const photoIDs = tags
        .filter(t => t.githubLogin === parent.githubLogin)
        .map(t => ObjectID(t.photoID))
      
      return db.collection('photos').find({ _id: { $in: photoIDs } }).toArray()
    }
  },

  DateTime: new GraphQLScalarType({
    name: "DateTime",
    description: 'A valid date time value.',
    parseValue: value => new Date(value),
    serialize: value => new Date(value).toISOString(),
    parseLiteral: ast => ast.value
  })
}

module.exports = resolvers