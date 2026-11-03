const assert = require("node:assert/strict");
const test = require("node:test");
const handlers = require("../src/utils/handlers");
const { ContextualApiError } = require("../src/utils/helpers/variables.helper");
const { createLogger, createResponse } = require("./helpers");

test("functionWrapper returns results and wraps thrown errors", async () => {
  assert.equal(await handlers.functionWrapper(async (a, b) => a + b, [2, 3]), 5);
  await assert.rejects(
    handlers.functionWrapper(async () => {
      throw new Error("failed");
    }, [], {
      customMessage: "service failed",
      codePath: "service.test",
      extras: { id: 1 },
    }),
    (error) => {
      assert.ok(error instanceof ContextualApiError);
      assert.equal(error.message, "service failed");
      assert.equal(error.codePath, "service.test");
      assert.deepEqual(error.extras, { id: 1 });
      return true;
    }
  );
});

test("returnErrorFunctionWrapper returns object and tuple forms for success and failure", async (t) => {
  const { logger, entries } = createLogger();
  const success = await handlers.returnErrorFunctionWrapper(
    async (value) => value * 2,
    [4],
    { loggerInstance: logger, success: { message: "done" } }
  );
  assert.deepEqual(success, { response: 8, error: null });
  assert.equal(entries[0].level, "info");

  const tupleSuccess = await handlers.returnErrorFunctionWrapper(async () => "ok", [], {
    returnType: "array",
  });
  assert.deepEqual(tupleSuccess, ["ok", null]);

  const failure = await handlers.returnErrorFunctionWrapper(async () => {
    throw new Error("nope");
  }, [], { loggerInstance: logger, error: { message: "failed" } });
  assert.equal(failure.response, null);
  assert.equal(failure.error.message, "nope");
  assert.equal(entries[1].level, "error");

  const tupleFailure = await handlers.returnErrorFunctionWrapper(async () => {
    throw new Error("nope");
  }, [], { returnType: "array" });
  assert.equal(tupleFailure[0], null);
  assert.equal(tupleFailure[1].message, "nope");
});

test("routesWrapper passes through middleware results and forwards contextual errors", async () => {
  let calledNext = false;
  const wrapped = handlers.routesWrapper([
    async function exampleRoute(req, res, next) {
      next();
    },
  ]);
  await wrapped[0]({}, {}, () => (calledNext = true));
  assert.equal(calledNext, true);

  let forwarded;
  const error = new ContextualApiError({
    statusCode: 409,
    customMessage: "conflict",
    codePath: "repo.create",
  }, new Error("duplicate"));
  const failing = handlers.routesWrapper([
    async function createRoute() {
      throw error;
    },
  ]);
  await failing[0]({}, {}, (value) => (forwarded = value));
  assert.equal(forwarded.message, "conflict");
  assert.equal(forwarded.statusCode, 409);
  assert.equal(forwarded.info.codePath, "routesWrapper =>|| ::createRoute -> repo.create::");
  assert.equal(forwarded.info.error.message, "duplicate");
});

test("routesWrapper forwards ordinary exceptions as internal errors", async () => {
  let forwarded;
  const wrapped = handlers.routesWrapper([
    async function ordinaryRoute() {
      throw new Error("unexpected");
    },
  ]);
  await wrapped[0]({}, {}, (error) => (forwarded = error));

  assert.equal(forwarded.message, "unexpected");
  assert.equal(forwarded.statusCode, 500);
  assert.deepEqual(forwarded.info.fncPipeline, ["ordinaryRoute"]);
});

test("central error handler logs and ends with the provided status", () => {
  const { logger, entries } = createLogger();
  const req = { log: logger, user: { id: "user-1", email: "user@example.com" } };
  const res = createResponse();

  handlers.error({ statusCode: 422, message: "invalid", logLevel: "warn" }, req, res);

  assert.equal(res.statusCode, 422);
  assert.equal(res.ended, true);
  assert.equal(entries[0].level, "warn");
});

test("central error handler falls back to HTTP 500 if logging throws", () => {
  let logCalls = 0;
  const logger = {
    error() {
      logCalls++;
      if (logCalls === 1) throw new Error("logger failure");
    },
  };
  const res = createResponse();

  handlers.error({ statusCode: 400, message: "invalid" }, { log: logger }, res);

  assert.equal(logCalls, 2);
  assert.equal(res.statusCode, 500);
  assert.equal(res.ended, true);
});

test("standard response helper formats success and logs request details", () => {
  const { logger, entries } = createLogger();
  const req = { log: logger, originalUrl: "/api/example", user: { id: "user-1" } };
  const res = createResponse();

  handlers.response(req, res, {
    message: "fetched",
    data: { id: "user-1" },
    statusCode: 200,
    fnc: "getUser",
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, "Success");
  assert.deepEqual(res.body.data, { id: "user-1" });
  assert.equal(res.body.requestUrl, "/api/example");
  assert.ok(Number.isFinite(Date.parse(res.body.timestamp)));
  assert.equal(entries[0].message.message, "fetched");
});
