const assert = require('node:assert/strict');
const test = require('node:test');
const proxyquire = require('proxyquire');

test('user repository delegates CRUD operations to the User model', async () => {
    const calls = [];
    const results = {
        findOne: { id: 'found' },
        findByIdAndUpdate: { id: 'updated' },
        create: { id: 'created' }
    };
    const User = {
        findOne: async options => { calls.push(['findOne', options]); return results.findOne; },
        findByIdAndUpdate: async (...args) => { calls.push(['update', ...args]); return results.findByIdAndUpdate; },
        create: async options => { calls.push(['create', options]); return results.create; }
    };
    const repository = proxyquire('../src/repositories/User.repository', {
        '../models/User': User
    });

    assert.equal(await repository.findOne({ email: 'a@b.test' }), results.findOne);
    assert.equal(await repository.find({ email: 'a@b.test' }), results.findOne);
    assert.equal(await repository.updateById('u1', { name: 'Ada' }), results.findByIdAndUpdate);
    assert.equal(await repository.create({ name: 'Ada' }), results.create);
    assert.deepEqual(calls, [
        ['findOne', { email: 'a@b.test' }],
        ['findOne', { email: 'a@b.test' }],
        ['update', 'u1', { $set: { name: 'Ada' } }, { new: true }],
        ['create', { name: 'Ada' }]
    ]);
});

test('authentication service delegates authentication, login, repository and mail operations', async () => {
    const calls = [];
    const user = { id: 'u1' };
    const passport = {
        authenticate(type, options, callback) {
            calls.push(['authenticate', type, options]);
            return (req, res, next) => callback(null, user, { message: 'ok' });
        }
    };
    const service = proxyquire('../src/service/auth.service', {
        passport,
        jsonwebtoken: { sign: (payload, key, options) => `${payload.id}:${key}:${options.expiresIn}` },
        '../repositories': {
            UserRepo: {
                findOne: async options => { calls.push(['find', options]); return user; },
                updateById: async (...args) => { calls.push(['update', ...args]); return user; },
                create: async userDetails => { calls.push(['create', userDetails]); return userDetails; }
            }
        },
        uuid: { v4: () => 'fixed-uuid' },
        '../utils/helpers/mail.helper': {
            sendMail: async options => { calls.push(['mail', options]); return 'sent'; }
        }
    });

    assert.equal(await service.authenticateUser({}, 'login'), user);
    const loggedIn = [];
    await service.loginUser({ login: (...args) => { loggedIn.push(args); args.at(-1)(null); } }, user);
    assert.equal(loggedIn[0][0], user);
    assert.deepEqual(loggedIn[0][1], { session: false });

    assert.equal(await service.findUser({ email: 'a@b.test' }), user);
    assert.equal(await service.updateUser('u1', { name: 'Ada' }), user);
    assert.deepEqual(await service.createUser({ email: 'a@b.test' }), {
        id: 'fixed-uuid',
        email: 'a@b.test'
    });

    process.env.ACCESS_TOKEN_PRIVATE_KEY = 'secret';
    process.env.ACCESS_TOKEN_EXPIRATION = '1h';
    assert.equal(await service.generateAndSetUserTokens({ id: 'u1' }), 'u1:secret:1h');
    assert.equal(await service.sendMailToUser({ to: 'a@b.test' }), 'sent');
    assert.deepEqual(calls.map(call => call[0]), [
        'authenticate', 'find', 'update', 'create', 'mail'
    ]);
});

test('authentication service rejects passport authentication and login failures', async () => {
    const service = proxyquire('../src/service/auth.service', {
        passport: {
            authenticate(type, options, callback) {
                return (req, res, next) => callback(null, false, { message: 'bad credentials' });
            }
        },
        '../repositories': { UserRepo: {} },
        '../utils/helpers/mail.helper': { sendMail: async () => {} }
    });

    await assert.rejects(service.authenticateUser({}, 'login'), { message: 'bad credentials' });
    await assert.rejects(service.loginUser({
        login(user, options, callback) { callback(new Error('login failed')); }
    }, {}), { message: 'login failed' });

    const passportErrorService = proxyquire('../src/service/auth.service', {
        passport: {
            authenticate(type, options, callback) {
                return (req, res, next) => callback(new Error('passport failed'));
            }
        },
        '../repositories': { UserRepo: {} },
        '../utils/helpers/mail.helper': { sendMail: async () => {} }
    });
    await assert.rejects(passportErrorService.authenticateUser({}, 'login'), { message: 'passport failed' });
});

test('User model exposes the expected schema defaults, uniqueness and timestamps', () => {
    const User = require('../src/models/User');
    const schema = User.schema;

    assert.equal(schema.options.timestamps, true);
    assert.equal(schema.path('email').options.unique, true);
    assert.equal(schema.path('googleId').defaultValue, undefined);
    assert.equal(schema.path('emailVerified').defaultValue, false);
    assert.equal(schema.path('resetPasswordExpire').instance, 'Date');
    assert.equal(schema.path('avatar.profileLetter').instance, 'String');
});

test('Mongo connector logs success and rethrows connection failures', async () => {
    const calls = [];
    let fails = false;
    const connectMongo = proxyquire('../src/config/mongo.config', {
        mongoose: {
            connect: async uri => {
                calls.push(uri);
                if (fails) throw new Error('connect failed');
            }
        }
    });
    const oldUri = process.env.MONGO_URI;
    const oldLog = console.log;
    const oldError = console.error;
    process.env.MONGO_URI = 'mongodb://test';
    console.log = () => {};
    console.error = () => {};

    try {
        await connectMongo();
        assert.deepEqual(calls, ['mongodb://test']);
        fails = true;
        await assert.rejects(connectMongo, { message: 'connect failed' });
        assert.deepEqual(calls, ['mongodb://test', 'mongodb://test']);
    } finally {
        if (oldUri === undefined) delete process.env.MONGO_URI;
        else process.env.MONGO_URI = oldUri;
        console.log = oldLog;
        console.error = oldError;
    }
});

test('Passport local strategy verifies credentials and returns expected failures', async () => {
    let verify;
    const passport = {
        use(name, strategy) {
            assert.equal(name, 'login');
            verify = strategy._verify;
        }
    };
    const user = { email: 'a@b.test', password: 'hash' };
    let lookup;
    let passwordMatches = true;
    proxyquire('../src/config/passport.config', {
        passport,
        'passport-local': {
            Strategy: class LocalStrategy {
                constructor(options, callback) {
                    this.options = options;
                    this._verify = callback;
                }
            }
        },
        '../repositories/User.repository': {
            find: async options => { lookup = options; return user; }
        },
        bcrypt: { compare: async () => passwordMatches }
    });

    const run = (...args) => new Promise(resolve => verify(...args, (...result) => resolve(result)));
    assert.deepEqual(await run('a@b.test', 'password'), [null, user, { message: 'Logged in Successfully' }]);
    assert.deepEqual(lookup, { email: 'a@b.test' });

    passwordMatches = false;
    assert.deepEqual(await run('a@b.test', 'bad'), [null, false, { message: 'Invalid Password' }]);

    passwordMatches = true;
    user.googleId = 'g1';
    user.password = undefined;
    assert.deepEqual(await run('a@b.test', 'password'), [
        null, false,
        { message: 'You initially signed up using Google. Please log in using Google or sign up to update password.' }
    ]);
    user.googleId = undefined;
    user.password = 'hash';

    const missingPassport = { use(name, strategy) { verify = strategy._verify; } };
    proxyquire('../src/config/passport.config', {
        passport: missingPassport,
        'passport-local': { Strategy: class { constructor(options, callback) { this._verify = callback; } } },
        '../repositories/User.repository': { find: async () => null },
        bcrypt: { compare: async () => true }
    });
    assert.deepEqual(await run('missing@b.test', 'password'), [null, false, { message: 'User not found' }]);
});

test('AWS and logger configurations initialize their adapters', () => {
    let awsConfig;
    let sesOptions;
    class AWS {
        static config = { update(options) { awsConfig = options; } };
        static SES = class {
            constructor(options) { sesOptions = options; }
            sendEmail() {}
        };
    }
    const ses = proxyquire('../src/config/aws.config', { 'aws-sdk': AWS });
    assert.deepEqual(sesOptions, { apiVersion: '2010-12-01' });
    assert.ok(awsConfig);
    assert.equal(typeof ses.sendEmail, 'function');

    let pinoOptions;
    const logger = proxyquire('../src/config/logger.config', {
        pino: options => { pinoOptions = options; return { info() {} }; }
    });
    assert.equal(typeof logger.info, 'function');
    assert.deepEqual(pinoOptions.redact, { paths: ['password', 'name', 'email'], remove: true });
    assert.equal(pinoOptions.formatters.level('info').level, 'INFO');
    assert.match(pinoOptions.timestamp(), /,"time":"/);
});
