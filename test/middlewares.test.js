const assert = require('node:assert/strict');
const test = require('node:test');
const { mock } = require('node:test');
const proxyquire = require('proxyquire');
const { createLogger, createResponse } = require('../support/http');
const { httpStatus } = require('../src/utils/helpers/variables.helper');

function request(body = {}, extras = {}) {
    const { logger } = createLogger();
    return { body, headers: {}, params: {}, log: logger, ...extras };
}

test('feature flags allow enabled features and return 503 when disabled', () => {
    const flags = require('../src/middlewares/flags.middleware');
    const cases = [
        ['signUpFlag', 'FEATURE_CUSTOM_SIGNUP'],
        ['loginFlag', 'FEATURE_CUSTOM_LOGIN'],
        ['googleAuthFlag', 'FEATURE_GOOGLE_AUTH'],
        ['getUserFlag', 'FEATURE_GET_USER'],
        ['forgotPasswordFlag', 'FEATURE_FORGOT_PASSWORD'],
        ['resetPasswordFlag', 'FEATURE_RESET_PASSWORD']
    ];

    for (const [name, variable] of cases) {
        const middleware = flags[name];
        const previous = process.env[variable];
        const next = mock.fn();
        const res = createResponse();

        process.env[variable] = 'true';
        middleware({}, res, next);
        assert.equal(next.mock.callCount(), 1, `${name} should pass when enabled`);

        process.env[variable] = 'false';
        const blockedResponse = createResponse();
        middleware({}, blockedResponse, mock.fn());
        assert.equal(blockedResponse.statusCode, httpStatus.SERVICE_UNAVAILABLE.code);
        assert.equal(blockedResponse.ended, true);

        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
    }
});

test('validation middleware sanitizes valid inputs and rejects invalid inputs', () => {
    const validators = require('../src/middlewares/validate.middleware');
    const cases = [
        ['validateLoginData', { email: 'ada@example.com', password: 'Password!1' }, { email: 'ada@example.com', password: 'Password!1', ignored: true }],
        ['validateSignUpData', { email: 'ada@example.com', password: 'Password!1', name: 'Ada' }, { email: 'ada@example.com', password: 'Password!1', name: 'Ada', ignored: true }],
        ['validateGoogleLoginCallbackData', { googleAuthcode: '0123456789' }, { googleAuthcode: '0123456789' }],
        ['validateEmailSyntax', { email: 'ada@example.com' }, { email: 'ada@example.com', ignored: true }],
        ['validatePasswordSyntax', { password: 'Password!1' }, { password: 'Password!1', ignored: true }]
    ];

    for (const [name, body, expected] of cases) {
        const req = request({ ...body, ignored: true });
        const res = createResponse();
        const next = mock.fn();
        validators[name](req, res, next);

        assert.equal(next.mock.callCount(), 1, `${name} should pass valid input`);
        assert.deepEqual(req.body, expected);
    }

    const invalidCases = [
        ['validateLoginData', { email: 'bad', password: 'short' }],
        ['validateSignUpData', { email: 'bad', password: 'short', name: '' }],
        ['validateGoogleLoginCallbackData', { googleAuthcode: 'short' }],
        ['validateEmailSyntax', { email: 'bad' }],
        ['validatePasswordSyntax', { password: 'weakpass' }]
    ];
    for (const [name, body] of invalidCases) {
        const res = createResponse();
        const next = mock.fn();
        validators[name](request(body), res, next);
        assert.equal(res.statusCode, httpStatus.BAD_REQUEST.code, `${name} should reject invalid input`);
        assert.equal(res.ended, true);
        assert.equal(next.mock.callCount(), 0);
    }
});

test('password-match and token validators accept and reject values', () => {
    const validators = require('../src/middlewares/validate.middleware');

    const matching = request({ password: 'secret', confirmPassword: 'secret' });
    const next = mock.fn();
    validators.validateIfPasswordMatches(matching, createResponse(), next);
    assert.equal(next.mock.callCount(), 1);

    const mismatchResponse = createResponse();
    validators.validateIfPasswordMatches(
        request({ password: 'secret', confirmPassword: 'different' }),
        mismatchResponse,
        mock.fn()
    );
    assert.equal(mismatchResponse.statusCode, httpStatus.BAD_REQUEST.code);

    const tokenRequest = request({}, { params: { token: '0123456789abcdef' } });
    const tokenNext = mock.fn();
    validators.validateTokenSyntax(tokenRequest, createResponse(), tokenNext);
    assert.equal(tokenNext.mock.callCount(), 1);
    assert.equal(tokenRequest.params.token, '0123456789abcdef');

    const invalidResponse = createResponse();
    validators.validateTokenSyntax(request({}, { params: { token: 'tiny' } }), invalidResponse, mock.fn());
    assert.equal(invalidResponse.statusCode, httpStatus.BAD_REQUEST.code);
});

test('validation middleware logs and returns 500 for unexpected validation failures', () => {
    const calls = [];
    const validators = proxyquire('../src/middlewares/validate.middleware', {
        '../utils/helpers/validators.helper.js': {
            createSchemaChildJoiObject() { throw new Error('schema failure'); }
        },
        '../utils/helpers/common.helper.js': {
            handleError(entry) { calls.push(entry); }
        },
        '../utils/helpers/logs.helper.js': { sendLogs() {} }
    });
    const res = createResponse();

    validators.validateEmailSyntax(request({ email: 'a@b.test' }), res, mock.fn());

    assert.equal(res.statusCode, httpStatus.SERVER_ERROR.code);
    assert.equal(calls[0].info.fnc, 'validateEmailSyntax');
    assert.equal(calls[0].info.error.message, 'schema failure');
});

test('JWT middleware rejects missing and invalid tokens and accepts valid tokens', () => {
    const jwt = require('jsonwebtoken');
    const middleware = require('../src/middlewares/authMiddleware');
    const oldSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'test-secret';

    try {
        const noToken = createResponse();
        middleware(request(), noToken, mock.fn());
        assert.equal(noToken.statusCode, 401);
        assert.deepEqual(noToken.body, { message: 'No token, not authorized' });

        const invalid = createResponse();
        middleware(request({}, { headers: { authorization: 'Bearer invalid' } }), invalid, mock.fn());
        assert.equal(invalid.statusCode, 401);
        assert.deepEqual(invalid.body, { message: 'Token not valid' });

        const valid = request({}, { headers: { authorization: `Bearer ${jwt.sign({ id: 'u1' }, process.env.JWT_SECRET)}` } });
        const next = mock.fn();
        middleware(valid, createResponse(), next);
        assert.equal(next.mock.callCount(), 1);
        assert.equal(valid.user.id, 'u1');

        const raw = request({}, { headers: { authorization: jwt.sign({ id: 'u2' }, process.env.JWT_SECRET) } });
        middleware(raw, createResponse(), mock.fn());
        assert.equal(raw.user.id, 'u2');
    } finally {
        if (oldSecret === undefined) delete process.env.JWT_SECRET;
        else process.env.JWT_SECRET = oldSecret;
    }
});

test('access middleware handles missing, invalid, missing-user, success, and unexpected errors', async () => {
    let tokenResult = { value: { id: 'u1' } };
    let user = { id: 'u1' };
    let thrown;
    const logCalls = [];
    const { authenticateUser } = proxyquire('../src/middlewares/access.middleware', {
        '../utils/helpers/middlewares.helper.js': {
            getToken: req => req.token || null,
            verifyToken: async () => {
                if (thrown) throw thrown;
                return tokenResult;
            },
            verifyUser: async () => user
        },
        '../utils/helpers/common.helper.js': {
            handleError: entry => logCalls.push(entry)
        },
        '../utils/helpers/logs.helper.js': {
            sendLogs: (...args) => logCalls.push(args)
        }
    });

    const noToken = createResponse();
    await authenticateUser(request(), noToken, mock.fn());
    assert.equal(noToken.statusCode, httpStatus.UNAUTHORIZED.code);

    tokenResult = { error: new Error('bad token') };
    const invalid = createResponse();
    await authenticateUser(request({}, { token: 'invalid' }), invalid, mock.fn());
    assert.equal(invalid.statusCode, httpStatus.UNAUTHORIZED.code);

    tokenResult = { value: { id: 'gone' } };
    user = null;
    const noUser = createResponse();
    await authenticateUser(request({}, { token: 'valid' }), noUser, mock.fn());
    assert.equal(noUser.statusCode, httpStatus.UNAUTHORIZED.code);

    user = { id: 'u1' };
    const successReq = request({}, { token: 'valid' });
    const next = mock.fn();
    const originalLog = console.log;
    console.log = () => {};
    try {
        await authenticateUser(successReq, createResponse(), next);
    } finally {
        console.log = originalLog;
    }
    assert.equal(successReq.user, user);
    assert.equal(next.mock.callCount(), 1);

    thrown = new Error('unexpected');
    const failed = createResponse();
    await authenticateUser(request({}, { token: 'valid' }), failed, mock.fn());
    assert.equal(failed.statusCode, httpStatus.SERVER_ERROR.code);
    assert.equal(logCalls.at(-1).info.error.message, 'unexpected');
});

test('verifyUserWithEmail attaches matching users and handles missing users and failures', async () => {
    let result = { id: 'u1' };
    let failure;
    const logs = [];
    const { verifyUserWithEmail } = proxyquire('../src/middlewares/verification.middleware', {
        '../repositories/User.repository': {
            find: async options => {
                if (failure) throw failure;
                assert.deepEqual(options, { email: 'ada@example.com' });
                return result;
            }
        },
        '../utils/helpers/common.helper': { handleError: entry => logs.push(entry) },
        '../utils/helpers/logs.helper.js': { sendLogs: (...args) => logs.push(args) },
        'google-auth-library': { OAuth2Client: class {} }
    });

    const req = request({ email: 'ada@example.com' });
    const next = mock.fn();
    await verifyUserWithEmail(req, createResponse(), next);
    assert.equal(req.user, result);
    assert.equal(next.mock.callCount(), 1);

    result = null;
    const notFound = createResponse();
    await verifyUserWithEmail(request({ email: 'ada@example.com' }), notFound, mock.fn());
    assert.equal(notFound.statusCode, httpStatus.NOT_ALLOWED.code);

    failure = new Error('repository failed');
    const failed = createResponse();
    await verifyUserWithEmail(request({ email: 'ada@example.com' }), failed, mock.fn());
    assert.equal(failed.statusCode, httpStatus.SERVER_ERROR.code);
    assert.equal(logs.at(-1).info.error.message, 'repository failed');
});

test('verifyGoogleAuthCode handles valid identity, missing token, invalid payload, and provider errors', async () => {
    let googleResponse;
    let failure;
    const logCalls = [];
    class OAuth2Client {
        constructor(...args) { this.args = args; }
        async getToken(code) {
            assert.equal(code, 'google-auth-code');
            if (failure) throw failure;
            return { tokens: googleResponse.tokens };
        }
        async verifyIdToken(options) {
            assert.equal(options.audience, process.env.GOOGLE_CLIENT_ID);
            return { getPayload: () => googleResponse.payload };
        }
    }
    const { verifyGoogleAuthCode } = proxyquire('../src/middlewares/verification.middleware', {
        '../repositories/User.repository': { find: async () => null },
        '../utils/helpers/common.helper': { handleError: entry => logCalls.push(entry) },
        '../utils/helpers/logs.helper.js': { sendLogs() {} },
        'google-auth-library': { OAuth2Client }
    });
    const baseRequest = () => request({ googleAuthcode: 'google-auth-code' });

    googleResponse = { tokens: { id_token: 'id-token' }, payload: { email: 'ada@example.com' } };
    const success = baseRequest();
    const next = mock.fn();
    await verifyGoogleAuthCode(success, createResponse(), next);
    assert.deepEqual(success.body, { email: 'ada@example.com' });
    assert.equal(next.mock.callCount(), 1);

    googleResponse = { tokens: {} };
    const noToken = createResponse();
    await verifyGoogleAuthCode(baseRequest(), noToken, mock.fn());
    assert.equal(noToken.statusCode, httpStatus.UNAUTHORIZED.code);

    googleResponse = { tokens: { id_token: 'id-token' }, payload: null };
    const noPayload = createResponse();
    await verifyGoogleAuthCode(baseRequest(), noPayload, mock.fn());
    assert.equal(noPayload.statusCode, httpStatus.UNAUTHORIZED.code);

    failure = new Error('google unavailable');
    const failed = createResponse();
    await verifyGoogleAuthCode(baseRequest(), failed, mock.fn());
    assert.equal(failed.statusCode, httpStatus.SERVER_ERROR.code);
    assert.equal(failed.body.message, 'Google authentication failed');
    assert.equal(logCalls.at(-1).info.error.message, 'google unavailable');
});
