"use strict"

const crypto = require('crypto')
const uuid = require('uuid4')
const co = require('co')
const passport = require('koa-passport')
const UserFactory = require('../models/user')
const UnauthorizedError = require('five-bells-shared/errors/unauthorized-error')

const LocalStrategy = require('passport-local')
const BasicStrategy = require('passport-http').BasicStrategy
const GitHubStrategy = require('passport-github').Strategy

const Config = require('./config')
const Ledger = require('./ledger')

module.exports = class Auth {
  static constitute () { return [ UserFactory, Config, Ledger ] }
  constructor (User, config, ledger) {
    const self = this
    self.config = config
    self.ledger = ledger
    self.User = User

    self.commonSetup(BasicStrategy)
    self.commonSetup(LocalStrategy)

    // TODO add an environment variable to disable github login, it should be optional
    if (config.data.getIn(['github', 'client_id'])) {
      passport.use(new GitHubStrategy(
        {
          clientID: config.data.getIn(['github', 'client_id']),
          clientSecret: config.data.getIn(['github', 'client_secret']),
          callbackURL: config.data.getIn(['server', 'base_uri']) + '/auth/github/callback'
        },
        // TODO this whole function is a dup from local register flow
        co.wrap(function * (accessToken, refreshToken, profile, done) {
          const email = profile.emails[0] && profile.emails[0].value

          // Find a user by github id or email address
          let dbUser = yield User.findOne({
            where: {
              $or: [
                { github_id: profile.id },
                { email: email }
              ]
            }
          })

          // User exists
          if (dbUser) {
            dbUser.password = self.generateGithubPassword(profile.id)
            // TODO Update the user with changed profile data
            return done(null, dbUser)
          }

          // User doesn't exist
          // TODO custom username
          // TODO what if the username already exists
          let userObj = {
            username: profile.username,
            password: self.generateGithubPassword(profile.id),
            email: email,
            github_id: profile.id,
            profile_picture: profile.photos[0].value
          }

          // Create the ledger account
          try {
            yield ledger.createAccount(userObj)
          } catch (e) {
            // TODO handle
          }

          // Create the db user
          try {
            dbUser = yield User.createExternal(userObj)
          } catch (e) {
            // TODO handle
          }

          // Append ledger account
          const user = yield dbUser.appendLedgerAccount()
          user.password = password

          done(null, user)
        })
      ))
    }

    passport.serializeUser(function(user, done) {
      done(null, user)
    })

    passport.deserializeUser(function(userObj, done) {
      User.findOne({where: {username: userObj.username}})
        .then(co.wrap(function * (dbUser){
          if (!dbUser) {
            done(new UnauthorizedError('Unknown or invalid account / password'))
          }

          const user = yield dbUser.appendLedgerAccount()
          user.password = userObj.password

          done(null, user)
        }))
    })
  }

  attach (app) {
    // Authentication
    app.use(passport.initialize())
    app.use(passport.session())
  }

  * checkAuth (next) {
    // Local Strategy
    if (this.isAuthenticated()) {
      return yield next
    }

    // Basic and OAuth strategies
    yield passport.authenticate(['basic', 'github'], { session: false }).call(this, next)
  }

  commonSetup(Strategy) {
    const self = this

    passport.use(new Strategy(co.wrap(
      function * (username, password, done) {
        // If no Authorization is provided we can still
        // continue without throwing an error
        if (!username) {
          return done(null, false)
        }

        // Check if the db user exists
        const dbUser = yield self.User.findOne({where:{
          username: username
        }})

        if (!dbUser) {
          return done(new UnauthorizedError('Unknown or invalid account / password'))
        }

        // Check if the ledger user exists
        // TODO do we need this check?
        const ledgerUser = yield self.ledger.getAccount({
          username: username,
          password: password
        })

        if (!ledgerUser) {
          return done(new UnauthorizedError('Unknown or invalid account / password'))
        }

        // Append ledger account
        const user = yield dbUser.appendLedgerAccount()
        user.password = password

        return done(null, user)
      }
    )))
  }

  generateGithubPassword (userId) {
    return crypto.createHmac('sha256', this.config.data.getIn(['github', 'secret'])).update(userId).digest('base64')
  }
}