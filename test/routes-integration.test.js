const assert = require('node:assert/strict');
const test = require('node:test');
const { mock } = require('node:test');
const express = require('express');
const proxyquire = require('proxyquire');
const request = require('supertest');
const { createLogger, createResponse } = require('../support/http');
const { httpStatus } = require('../src/utils/helpers/variables.helper');

function createAuthRouter() {
    const calls = [];
    const controllers = {};
    for (const name of [
        'customLogin', 'customSignUp', 'googleLoginCallback',
        'sendResetlinkToEmail', 'customResetPassword'
    ]) {
        controllers[name] = (req, res) => {
            calls.push([name, req.body, req.user]);
            return res.status(200).json({ handler: name });
        };
    }

    const authRouter = proxyquire('../src/routes/auth.route', {
        '../controllers/auth.controller': controllers,
        '../middlewares/verification.middleware': {
            verifyUserWithEmail(req, res, next) { req.user = { email: req.body.email }; next(); },
            verifyGoogleAuthCode(req, res, next) {
                req.body = { email: 'google@example.com', name: 'Google User' };
                next();
            }
        },
        '../middlewares/rateLimit.middleware': {
            authSlowDown(req, res, next) { next(); },
            authLimiter(req, res, next) { next(); },
            forgotPasswordLimiter(req, res, next) { next(); }
        }
    });

    return { authRouter, calls };
}

function createApp() {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.log = createLogger().logger;
        next();
    });
    return app;
}

test('auth routes compose validation, flags, verification, and the correct controller', async () => {
    const { authRouter, calls } = createAuthRouter();
    const app = createApp();
    app.use('/api/auth', authRouter);

    const login = await request(app).post('/api/auth/login')
        .send({ email: 'ada@example.com', password: 'Password!1' });
    assert.equal(login.status, 200);
    assert.equal(login.body.handler, 'customLogin');
    assert.deepEqual(calls.at(-1)[1], { email: 'ada@example.com', password: 'Password!1' });

    const registration = await request(app).post('/api/auth/register')
        .send({ email: 'new@example.com', password: 'Password!1', name: 'New User' });
    assert.equal(registration.status, 200);
    assert.equal(registration.body.handler, 'customSignUp');

    const invalid = await request(app).post('/api/auth/login')
        .send({ email: 'not-an-email', password: 'short' });
    assert.equal(invalid.status, httpStatus.BAD_REQUEST.code);

    const google = await request(app).post('/api/auth/google/callback')
        .send({ googleAuthcode: '0123456789' });
    assert.equal(google.status, 200);
    assert.equal(google.body.handler, 'googleLoginCallback');

    const forgot = await request(app).post('/api/auth/forgot-password')
        .send({ email: 'ada@example.com' });
    assert.equal(forgot.status, 200);
    assert.equal(calls.at(-1)[0], 'sendResetlinkToEmail');
    assert.deepEqual(calls.at(-1)[2], { email: 'ada@example.com' });

    const reset = await request(app).post('/api/auth/reset/0123456789abcdef')
        .send({ password: 'Password!1', confirmPassword: 'Password!1' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.handler, 'customResetPassword');
});

test('auth routes honor disabled feature flags', async () => {
    const { authRouter } = createAuthRouter();
    const app = createApp();
    app.use('/api/auth', authRouter);
    const oldValue = process.env.FEATURE_CUSTOM_SIGNUP;
    process.env.FEATURE_CUSTOM_SIGNUP = 'false';

    try {
        const response = await request(app).post('/api/auth/register')
            .send({ email: 'new@example.com', password: 'Password!1', name: 'New User' });
        assert.equal(response.status, httpStatus.SERVICE_UNAVAILABLE.code);
    } finally {
        if (oldValue === undefined) delete process.env.FEATURE_CUSTOM_SIGNUP;
        else process.env.FEATURE_CUSTOM_SIGNUP = oldValue;
    }
});

test('user route checks the feature flag and returns sanitized user data', async () => {
    const app = createApp();
    const user = {
        id: 'u1', email: 'ada@example.com', name: 'Ada',
        password: 'secret', resetPasswordToken: 'token', resetPasswordExpire: new Date()
    };
    const { authenticateUser } = proxyquire('../src/middlewares/access.middleware', {
        '../utils/helpers/middlewares.helper.js': {
            getToken: () => 'valid',
            verifyToken: async () => ({ value: { id: 'u1' } }),
            verifyUser: async () => user
        },
        '../utils/helpers/common.helper.js': { handleError() {} }
    });
    app.use(authenticateUser);
    app.use('/api/users', require('../src/routes/user.route'));

    const enabledBefore = process.env.FEATURE_GET_USER;
    process.env.FEATURE_GET_USER = 'true';
    const response = await request(app).get('/api/users');
    assert.equal(response.status, 200);
    assert.equal(response.body.user.email, 'ada@example.com');
    assert.equal(response.body.user.password, undefined);
    assert.equal(response.body.user.resetPasswordToken, undefined);
    assert.equal(response.body.user.resetPasswordExpire, undefined);

    process.env.FEATURE_GET_USER = 'false';
    const disabled = await request(app).get('/api/users');
    assert.equal(disabled.status, httpStatus.SERVICE_UNAVAILABLE.code);
    if (enabledBefore === undefined) delete process.env.FEATURE_GET_USER;
    else process.env.FEATURE_GET_USER = enabledBefore;
});

test('API returns its configured JSON 404 response for unknown endpoints', async () => {
    const app = createApp();
    app.use((req, res) => res.status(404).json({ status: 'failed', message: 'Method Not Allowed' }));

    const response = await request(app).get('/not-found');
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { status: 'failed', message: 'Method Not Allowed' });
});

test('exported application composes its real middleware and routes without starting a listener', async () => {
    const oldLogLevel = process.env.PINO_LOG_LEVEL;
    process.env.PINO_LOG_LEVEL = 'silent';
    const app = require('../server');
    if (oldLogLevel === undefined) delete process.env.PINO_LOG_LEVEL;
    else process.env.PINO_LOG_LEVEL = oldLogLevel;

    const invalidLogin = await request(app).post('/api/auth/login')
        .send({ email: 'invalid', password: 'bad' });
    assert.equal(invalidLogin.status, httpStatus.BAD_REQUEST.code);

    const protectedRoute = await request(app).get('/api/users');
    assert.equal(protectedRoute.status, httpStatus.UNAUTHORIZED.code);

    const missingRoute = await request(app).get('/unknown');
    assert.equal(missingRoute.status, 404);
    assert.deepEqual(missingRoute.body, { status: 'failed', message: 'Method Not Allowed' });
});

test('email helper sends SES password-reset template with configured sender and recipient', async () => {
    let captured;
    const result = { MessageId: 'message-1' };
    const { sendMail } = proxyquire('../src/utils/helpers/mail.helper', {
        '../../config/aws.config': {
            sendEmail(params) {
                captured = params;
                return { promise: async () => result };
            }
        }
    });
    const oldSender = process.env.SES_SENDER;
    process.env.SES_SENDER = 'sender@example.test';

    try {
        assert.equal(await sendMail({
            recipientEmail: 'recipient@example.test',
            templateData: { resetUrl: 'https://frontend.test/reset/token' }
        }), result);
    } finally {
        if (oldSender === undefined) delete process.env.SES_SENDER;
        else process.env.SES_SENDER = oldSender;
    }

    assert.equal(captured.Source, 'sender@example.test');
    assert.deepEqual(captured.Destination, { ToAddresses: ['recipient@example.test'] });
    assert.equal(captured.Message.Subject.Data, 'Password Reset Request');
    assert.match(captured.Message.Body.Html.Data, /https:\/\/frontend\.test\/reset\/token/);
});

test('rate limit middleware exports callable global, auth, slow-down, and reset limiters', () => {
    const limiters = require('../src/middlewares/rateLimit.middleware');
    assert.deepEqual(Object.keys(limiters).sort(), [
        'authLimiter', 'authSlowDown', 'forgotPasswordLimiter', 'globalLimiter'
    ]);
    for (const middleware of Object.values(limiters)) {
        assert.equal(typeof middleware, 'function');
    }
});

test('user controller returns an error response and logs when extracting user data fails', async () => {
    const { getUserData } = require('../src/controllers/user.controller');
    const { logger, calls } = createLogger();
    const req = {
        log: logger,
        get user() { throw new Error('user unavailable'); }
    };
    const res = createResponse();

    await getUserData(req, res);

    assert.equal(res.statusCode, httpStatus.NOT_ALLOWED.code);
    assert.deepEqual(res.body, { success: false, message: 'user unavailable' });
    assert.equal(calls[0].level, 'info');
});
