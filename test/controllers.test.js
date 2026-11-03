const assert = require('node:assert/strict');
const test = require('node:test');
const proxyquire = require('proxyquire');
const { createLogger, createResponse } = require('../support/http');
const { httpStatus } = require('../src/utils/helpers/variables.helper');

function createController(serviceOverrides = {}, options = {}) {
    const calls = [];
    const service = {
        authenticateUser: async () => ({ id: 'u1', email: 'ada@example.com' }),
        loginUser: async () => {},
        generateAndSetUserTokens: async payload => {
            calls.push(['token', payload]);
            return 'access-token';
        },
        findUser: async () => null,
        updateUser: async (...args) => { calls.push(['updateUser', ...args]); return args[0]; },
        createUser: async details => {
            calls.push(['createUser', details]);
            return { _id: 'u2', id: 'u2', ...details };
        },
        sendMailToUser: async mail => { calls.push(['sendMailToUser', mail]); }
    };
    Object.assign(service, serviceOverrides);

    const sendLogs = (...args) => calls.push(['log', ...args]);
    const handleError = entry => calls.push(['handleError', entry]);
    const controller = proxyquire('../src/controllers/auth.controller', {
        '../service/auth.service.js': service,
        '../utils/helpers/logs.helper.js': { sendLogs },
        '../utils/helpers/common.helper.js': { handleError },
        bcrypt: options.bcrypt || { hash: async value => `hash:${value}` }
    });

    return { controller, service, calls };
}

function request(body = {}, extra = {}) {
    const { logger } = createLogger();
    return { body, log: logger, ...extra };
}

test('customLogin returns an access token after successful authentication', async () => {
    const { controller, calls } = createController();
    const req = request({ email: 'ada@example.com', password: 'secret' });
    const res = createResponse();

    await controller.customLogin(req, res);

    assert.equal(res.statusCode, httpStatus.OK.code);
    assert.deepEqual(res.body, { success: true, accessToken: 'access-token' });
    assert.deepEqual(calls.find(([kind]) => kind === 'token')[1], {
        id: 'u1',
        email: 'ada@example.com'
    });
});

test('customLogin returns a readable authentication failure', async () => {
    const { controller } = createController({
        authenticateUser: async () => { throw new Error('Invalid Password'); }
    });
    const res = createResponse();

    await controller.customLogin(request({ email: 'ada@example.com' }), res);

    assert.equal(res.statusCode, httpStatus.NOT_ALLOWED.code);
    assert.deepEqual(res.body, { success: false, message: 'Invalid Password' });
});

test('customSignUp creates a user with hashed password and avatar defaults', async () => {
    const { controller, calls } = createController();
    const res = createResponse();

    await controller.customSignUp(request({
        email: 'ada@example.com', password: 'Password!1', name: 'Ada'
    }), res);

    assert.equal(res.statusCode, httpStatus.CREATED.code);
    assert.deepEqual(res.body, { success: true, accessToken: 'access-token' });
    const created = calls.find(([kind]) => kind === 'createUser')[1];
    assert.equal(created.email, 'ada@example.com');
    assert.equal(created.password, 'hash:Password!1');
    assert.equal(created.name, 'Ada');
    assert.equal(created.subStatus, 'Free');
    assert.equal(created.avatar.profileLetter, 'A');
});

test('customSignUp returns conflict when an ordinary user already exists', async () => {
    const existing = { id: 'u1', email: 'ada@example.com', password: 'hash' };
    const { controller, calls } = createController({ findUser: async () => existing });
    const res = createResponse();

    await controller.customSignUp(request({ email: existing.email, password: 'Password!1', name: 'Ada' }), res);

    assert.equal(res.statusCode, httpStatus.CONFLICT.code);
    assert.deepEqual(res.body, { message: 'User already exists' });
    assert.equal(calls.some(([kind]) => kind === 'createUser'), false);
});

test('customSignUp lets an existing Google user set a local password', async () => {
    const existing = { _id: 'u1', email: 'ada@example.com', googleId: 'google-1' };
    const { controller, calls } = createController({
        findUser: async () => existing,
        updateUser: async (...args) => { calls.push(['updateUser', ...args]); return existing; }
    });
    const res = createResponse();

    await controller.customSignUp(request({ email: existing.email, password: 'Password!1', name: 'Ada' }), res);

    assert.equal(res.statusCode, httpStatus.OK.code);
    assert.equal(calls.find(([kind]) => kind === 'updateUser')[1], existing);
    assert.deepEqual(calls.find(([kind]) => kind === 'updateUser')[2], { password: 'hash:Password!1' });
    assert.deepEqual(calls.find(([kind]) => kind === 'token')[1], { id: 'u1', email: existing.email });
});

test('customSignUp handles service failures with a server error', async () => {
    const { controller, calls } = createController({
        findUser: async () => { throw new Error('database failed'); }
    });
    const res = createResponse();

    await controller.customSignUp(request({ email: 'ada@example.com', password: 'Password!1', name: 'Ada' }), res);

    assert.equal(res.statusCode, httpStatus.SERVER_ERROR.code);
    assert.equal(res.ended, true);
    assert.equal(calls.at(-1)[0], 'handleError');
});

test('googleLoginCallback creates an account for a new Google identity', async () => {
    const { controller, calls } = createController();
    const payload = {
        email: 'ada@example.com', firstName: 'Ada', sub: 'google-1',
        emailVerified: true, picture: 'https://example.test/avatar.png'
    };
    const res = createResponse();

    await controller.googleLoginCallback(request(payload), res);

    assert.equal(res.statusCode, httpStatus.CREATED.code);
    const created = calls.find(([kind]) => kind === 'createUser')[1];
    assert.equal(created.name, 'Ada');
    assert.equal(created.googleId, 'google-1');
    assert.equal(created.emailVerified, true);
    assert.equal(created.subStatus, 'Free');
});

test('googleLoginCallback updates an existing user and issues a token', async () => {
    const existing = { _id: 'u1', id: 'u1', email: 'ada@example.com' };
    const updated = { id: 'u1', email: 'ada@example.com' };
    const { controller, calls } = createController({
        findUser: async () => existing,
        updateUser: async (...args) => { calls.push(['updateUser', ...args]); return updated; }
    });
    const res = createResponse();

    await controller.googleLoginCallback(request({
        email: 'ada@example.com', firstName: 'Ada', sub: 'google-1',
        emailVerified: true, picture: 'picture'
    }), res);

    assert.equal(res.statusCode, httpStatus.OK.code);
    assert.deepEqual(calls.find(([kind]) => kind === 'updateUser').slice(1), [
        'u1', { name: 'Ada', googleId: 'google-1', emailVerified: true, profilePicture: 'picture' }
    ]);
    assert.deepEqual(calls.find(([kind]) => kind === 'token')[1], { email: 'ada@example.com', id: 'u1' });
});

test('googleLoginCallback reports service failures', async () => {
    const { controller, calls } = createController({
        findUser: async () => { throw new Error('lookup failed'); }
    });
    const res = createResponse();

    await controller.googleLoginCallback(request({ email: 'ada@example.com' }), res);

    assert.equal(res.statusCode, httpStatus.SERVER_ERROR.code);
    assert.equal(res.ended, true);
    assert.equal(calls.at(-1)[0], 'handleError');
});

test('sendResetlinkToEmail persists a hashed token and emails the raw reset URL', async () => {
    const previousDomain = process.env.FRONTEND_DOMAIN;
    process.env.FRONTEND_DOMAIN = 'https://frontend.example.test';
    const user = {
        email: 'ada@example.com',
        save: async () => { user.saved = true; }
    };
    const { controller, calls } = createController();
    const res = createResponse();

    const originalLog = console.log;
    console.log = () => {};
    try {
        await controller.sendResetlinkToEmail(request({}, { user }), res);
    } finally {
        console.log = originalLog;
        if (previousDomain === undefined) delete process.env.FRONTEND_DOMAIN;
        else process.env.FRONTEND_DOMAIN = previousDomain;
    }

    assert.equal(res.statusCode, httpStatus.OK.code);
    assert.deepEqual(res.body, { success: true });
    assert.equal(user.saved, true);
    assert.match(user.resetPasswordToken, /^[a-f0-9]{64}$/);
    assert.ok(user.resetPasswordExpire > Date.now());
    const email = calls.find(([kind]) => kind === 'sendMailToUser')[1];
    assert.equal(email.recipientEmail, user.email);
    assert.match(email.templateData.resetUrl, /^https:\/\/frontend\.example\.test\/reset\/[a-f0-9]{64}$/);
});

test('sendResetlinkToEmail reports persistence and mail errors', async () => {
    const { controller, calls } = createController({
        sendMailToUser: async () => { throw new Error('mail failed'); }
    });
    const user = { email: 'ada@example.com', save: async () => {} };
    const res = createResponse();
    const originalLog = console.log;
    console.log = () => {};

    try {
        await controller.sendResetlinkToEmail(request({}, { user }), res);
    } finally {
        console.log = originalLog;
    }

    assert.equal(res.statusCode, httpStatus.SERVER_ERROR.code);
    assert.equal(res.ended, true);
    assert.equal(calls.at(-1)[0], 'handleError');
});

test('customResetPassword rejects invalid tokens without changing the user', async () => {
    const { controller } = createController({ findUser: async () => null });
    const res = createResponse();

    await controller.customResetPassword(request({ password: 'Password!1' }, { params: { token: 'bad-token' } }), res);

    assert.equal(res.statusCode, httpStatus.BAD_REQUEST.code);
    assert.deepEqual(res.body, { success: false, message: 'Invalid or expired token' });
});

test('customResetPassword hashes a new password and clears reset credentials', async () => {
    const user = { save: async () => { user.saved = true; } };
    const queries = [];
    const { controller } = createController({
        findUser: async query => { queries.push(query); return user; }
    });
    const res = createResponse();

    await controller.customResetPassword(request({ password: 'Password!1' }, {
        params: { token: 'reset-token-value' },
        user: { id: 'request-user' }
    }), res);

    assert.equal(res.statusCode, httpStatus.OK.code);
    assert.deepEqual(res.body, { success: true });
    assert.match(user.password, /^hash:/);
    assert.equal(user.resetPasswordToken, undefined);
    assert.equal(user.resetPasswordExpire, undefined);
    assert.equal(user.saved, true);
    assert.equal(queries.length, 1);
    assert.ok(queries[0].resetPasswordToken);
    assert.ok(queries[0].resetPasswordExpire.$gt > 0);
});
