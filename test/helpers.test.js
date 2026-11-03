const assert = require('node:assert/strict');
const test = require('node:test');
const { mock } = require('node:test');
const proxyquire = require('proxyquire');
const { createLogger, createResponse } = require('../support/http');

test('sendLogs forwards each supported level and handles unknown levels', () => {
    const { sendLogs } = require('../src/utils/helpers/logs.helper');
    const { logger, calls } = createLogger();
    const payload = { message: 'test' };

    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
        sendLogs(logger, level, payload);
    }
    sendLogs(logger, 'unknown', payload);

    assert.deepEqual(calls.map(({ level }) => level), [
        'trace', 'debug', 'info', 'warn', 'error', 'fatal', 'error'
    ]);
    assert.deepEqual(calls.at(-1).args, ['Invalid Log Level']);
    assert.deepEqual(calls[0].args, [payload]);
});

test('handleError rolls back transactions and logs normalized general errors', () => {
    const { handleError } = require('../src/utils/helpers/common.helper');
    const { logger, calls } = createLogger();
    const rollback = mock.fn();
    const error = new TypeError('broken');
    const entry = { loggerInstance: logger, info: { fnc: 'test', error } };

    handleError(entry, { rollback });

    assert.equal(rollback.mock.callCount(), 1);
    assert.deepEqual(entry.info.error, {
        name: 'TypeError',
        message: 'broken',
        stack: error.stack
    });
    assert.equal(calls[0].level, 'error');
    assert.equal(calls[0].args[0].message, 'server error');
    assert.equal(calls[0].args[0].info, entry.info);
});

test('handleError identifies database errors', () => {
    const { handleError } = require('../src/utils/helpers/common.helper');
    const { logger, calls } = createLogger();

    handleError({
        loggerInstance: logger,
        info: { error: Object.assign(new Error('query failed'), { name: 'SequelizeDatabaseError' }) }
    });

    assert.equal(calls[0].args[0].message, 'postgres database error');
});

test('createSchemaChildJoiObject selects required and optional fields', () => {
    const { createSchemaChildJoiObject } = require('../src/utils/helpers/validators.helper');
    const Joi = require('joi');
    const parent = Joi.object({ name: Joi.string(), count: Joi.number() });
    const child = createSchemaChildJoiObject(parent, ['name'], ['count']);

    assert.equal(child.validate({ name: 'Ada', count: 2 }).error, undefined);
    assert.ok(child.validate({ count: 2 }).error);
    assert.equal(child.validate({ name: 'Ada' }).error, undefined);
    assert.throws(() => createSchemaChildJoiObject(null, ['name']), /Invalid or missing parent/);
    assert.throws(() => createSchemaChildJoiObject(parent), /Invalid or missing required or optional field/);
    assert.throws(() => createSchemaChildJoiObject(parent, ['missing']), /Fields are not a subset/);
});

test('generateAvatar returns an uppercase initial and a six-digit hex color', () => {
    const { generateAvatar } = require('../src/utils/helpers/generateAvatar');
    const originalRandom = Math.random;
    Math.random = () => 0;

    try {
        assert.deepEqual(generateAvatar('  alice@example.com  '), {
            randomLetter: 'A',
            randomColor: '#000000'
        });
        assert.deepEqual(generateAvatar('7'), {
            randomLetter: '7',
            randomColor: '#000000'
        });
    } finally {
        Math.random = originalRandom;
    }
});

test('functionWrapper returns values and wraps failures in ContextualApiError', async () => {
    const { functionWrapper } = require('../src/utils/handlers');
    const { ContextualApiError } = require('../src/utils/helpers/variables.helper');

    assert.equal(await functionWrapper(async (a, b) => a + b, [2, 3]), 5);
    await assert.rejects(
        functionWrapper(async () => { throw new Error('original'); }, [], {
            customMessage: 'safe message',
            codePath: 'unit.test',
            extras: { id: 1 }
        }),
        error => error instanceof ContextualApiError &&
            error.message === 'safe message' &&
            error.codePath === 'unit.test' &&
            error.extras.id === 1 &&
            error.data.message === 'original'
    );
});

test('returnErrorFunctionWrapper returns object and array results for success and failure', async () => {
    const { returnErrorFunctionWrapper } = require('../src/utils/handlers');
    const { logger, calls } = createLogger();

    assert.deepEqual(await returnErrorFunctionWrapper(async () => 42), { response: 42, error: null });
    assert.deepEqual(await returnErrorFunctionWrapper(async () => 42, [], { returnType: 'array' }), [42, null]);
    const failure = new Error('nope');
    assert.deepEqual(await returnErrorFunctionWrapper(async () => { throw failure; }), {
        response: null,
        error: failure
    });
    assert.deepEqual(await returnErrorFunctionWrapper(async () => { throw failure; }, [], {
        returnType: 'array'
    }), [null, failure]);

    await returnErrorFunctionWrapper(async () => 'ok', [], {
        loggerInstance: logger,
        success: { message: 'completed' }
    });
    await returnErrorFunctionWrapper(async () => { throw failure; }, [], {
        loggerInstance: logger,
        error: { message: 'failed' }
    });
    assert.deepEqual(calls.map(({ level }) => level), ['info', 'error']);
});

test('routesWrapper runs handlers and passes contextual or ordinary failures to next', async () => {
    const { routesWrapper } = require('../src/utils/handlers');
    const { ContextualApiError } = require('../src/utils/helpers/variables.helper');
    const req = {};
    const res = createResponse();
    const next = mock.fn();
    const before = mock.fn(async () => {});
    const fail = async function failHandler() { throw new Error('unexpected'); };

    await routesWrapper([before, fail])[1](req, res, next);
    assert.equal(next.mock.callCount(), 1);
    assert.equal(next.mock.calls[0].arguments[0].statusCode, 500);
    assert.equal(next.mock.calls[0].arguments[0].message, 'unexpected');
    assert.deepEqual(next.mock.calls[0].arguments[0].info.fncPipeline, ['', 'failHandler']);

    const contextualNext = mock.fn();
    const contextualFailure = async function contextualFailure() {
        throw new ContextualApiError({
            statusCode: 422, logLevel: 'warn', codePath: 'child', extras: { item: 1 }
        }, new Error('invalid'));
    };
    await routesWrapper([contextualFailure])[0](req, res, contextualNext);
    const details = contextualNext.mock.calls[0].arguments[0];
    assert.equal(details.statusCode, 422);
    assert.equal(details.logLevel, 'warn');
    assert.match(details.info.codePath, /child/);
    assert.equal(details.info.error.message, 'invalid');

    const successNext = mock.fn();
    const successfulHandler = mock.fn(async () => {});
    await routesWrapper([successfulHandler])[0](req, res, successNext);
    assert.equal(successfulHandler.mock.callCount(), 1);
    assert.equal(successNext.mock.callCount(), 0);
});

test('response logs and emits a standardized response for success and failure statuses', () => {
    const { response } = require('../src/utils/handlers');
    const { logger, calls } = createLogger();
    const req = { originalUrl: '/api/test', log: logger, user: { id: 'u1', email: 'a@b.test' } };
    const res = createResponse();

    response(req, res, {
        statusCode: 201, message: 'created', data: { id: 1 }, meta: { page: 1 },
        errors: null, fnc: 'create', extras: { source: 'test' }
    });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.body, {
        success: true,
        message: 'Success',
        data: { id: 1 },
        meta: { page: 1 },
        requestUrl: '/api/test',
        timestamp: res.body.timestamp
    });
    assert.ok(Number.isFinite(Date.parse(res.body.timestamp)));
    assert.equal(calls[0].args[0].info.user.id, 'u1');

    response(req, res, { statusCode: 400, message: 'invalid', fnc: 'fail' });
    assert.equal(res.body.success, false);
    assert.equal(res.body.message, 'Error');
    assert.equal(res.body.data, null);
});

test('central error handler logs and ends with the provided status', () => {
    const { error } = require('../src/utils/handlers');
    const { logger, calls } = createLogger();
    const res = createResponse();

    error({ logLevel: 'warn', statusCode: 422, message: 'invalid', info: { codePath: 'test' } },
        { log: logger, user: { id: 1, email: 'a@b.test' } }, res);

    assert.equal(res.statusCode, 422);
    assert.equal(res.ended, true);
    assert.equal(calls[0].level, 'warn');
    assert.equal(calls[0].args[0].info.user.id, 1);
});

test('getToken, verifyToken and verifyUser handle token formats and repository lookups', async () => {
    const jwt = require('jsonwebtoken');
    const repositoryCalls = [];
    const helpers = proxyquire('../src/utils/helpers/middlewares.helper', {
        '../../repositories': {
            UserRepo: { find: async options => { repositoryCalls.push(options); return { id: 'u1' }; } }
        }
    });
    const { getToken } = helpers;

    assert.equal(getToken({ headers: {} }), null);
    assert.equal(getToken({ headers: { authorization: 'Basic token' } }), null);
    assert.equal(getToken({ headers: { authorization: 'Bearer abc.def' } }), 'abc.def');
    assert.equal(getToken({ headers: { authorization: 'bearer token extra' } }), 'token');

    process.env.ACCESS_TOKEN_PRIVATE_KEY = 'test-secret';
    process.env.ACCESS_TOKEN_ALGORITHM = 'HS256';
    const token = jwt.sign({ id: 'u1' }, process.env.ACCESS_TOKEN_PRIVATE_KEY, { algorithm: 'HS256' });
    assert.deepEqual((await helpers.verifyToken(token)).value.id, 'u1');
    assert.ok((await helpers.verifyToken('invalid')).error);
    assert.deepEqual(await helpers.verifyUser({ id: 'u1' }), { id: 'u1' });
    assert.deepEqual(repositoryCalls, [{ id: 'u1' }]);
});

test('health endpoint responds when the database connection succeeds and fails', async () => {
    let shouldFail = false;
    const connect = async () => {
        if (shouldFail) throw new Error('database unavailable');
    };
    const router = proxyquire('../src/routes/health.route', { '../config/mongo.config': connect });
    const express = require('express');
    const app = express();
    app.use('/health', router);
    const request = require('supertest');

    const originalLog = console.log;
    const originalError = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
        const healthy = await request(app).get('/health');
        assert.equal(healthy.status, 200);
        assert.equal(healthy.body.status, 'live');

        shouldFail = true;
        const unhealthy = await request(app).get('/health');
        assert.equal(unhealthy.status, 500);
        assert.equal(unhealthy.body.message, 'Health check failed');
        assert.deepEqual(unhealthy.body.error, {});
    } finally {
        console.log = originalLog;
        console.error = originalError;
    }
});
