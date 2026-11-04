const assert = require("node:assert/strict");
const test = require("node:test");
const Joi = require("joi");
const jwt = require("jsonwebtoken");
const {
  ContextualApiError,
  httpStatus,
  userSchemaParentJoiObject,
} = require("../src/utils/helpers/variables.helper");
const { handleError } = require("../src/utils/helpers/common.helper");
const { generateAvatar } = require("../src/utils/helpers/generateAvatar");
const { sendLogs } = require("../src/utils/helpers/logs.helper");
const { createSchemaChildJoiObject } = require("../src/utils/helpers/validators.helper");
const { getToken, verifyToken, verifyUser } = require("../src/utils/helpers/middlewares.helper");
const { UserRepo } = require("../src/repositories");
const { createLogger, setEnv } = require("./helpers");

test("avatar generator uses the first trimmed character and a six-digit color", (t) => {
  t.mock.method(Math, "random", () => 0.5);

  assert.deepEqual(generateAvatar("  ada"), {
    randomLetter: "A",
    randomColor: "#7fffff",
  });
  assert.equal(generateAvatar("").randomLetter, "?");
});

test("log helper dispatches supported levels and reports invalid levels", () => {
  const { logger, entries } = createLogger();

  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
    sendLogs(logger, level, level);
  }
  sendLogs(logger, "unknown", "ignored");

  assert.deepEqual(entries.map(({ level }) => level), [
    "trace", "debug", "info", "warn", "error", "fatal", "error",
  ]);
  assert.equal(entries.at(-1).message, "Invalid Log Level");
});

test("handleError logs MongoDB and application errors without exposing extra properties", () => {
  const { logger, entries } = createLogger();
  const error = Object.assign(new Error("query failed"), { name: "MongoServerError", code: 11000 });
  const info = { error };

  handleError({ loggerInstance: logger, info });

  assert.equal(entries[0].message.message, "server error");
  assert.equal(entries[0].message.info.error.name, "MongoServerError");
  assert.equal(entries[0].message.info.error.message, "query failed");
  assert.equal("code" in info.error, false);
});

test("child Joi schema keeps required and optional fields", () => {
  const schema = createSchemaChildJoiObject(
    userSchemaParentJoiObject,
    ["email"],
    ["password"]
  );

  assert.equal(schema.validate({ email: "person@example.com" }).error, undefined);
  assert.equal(schema.validate({ email: "person@example.com", password: "Valid.pass123!" }).error, undefined);
  assert.ok(schema.validate({ email: "bad" }).error);
  assert.ok(schema.validate({}).error);
});

test("child Joi schema rejects invalid inputs and unknown fields", () => {
  assert.throws(() => createSchemaChildJoiObject(null, ["email"]), /Invalid or missing parent/);
  assert.throws(
    () => createSchemaChildJoiObject(Joi.object(), []),
    /Invalid or missing required or optional field/
  );
  assert.throws(
    () => createSchemaChildJoiObject(userSchemaParentJoiObject, ["unknown"]),
    /not a subset/
  );
});

test("token extractor accepts bearer headers and rejects malformed headers", () => {
  assert.equal(getToken({ headers: { authorization: "Bearer token-value" } }), "token-value");
  assert.equal(getToken({ headers: { authorization: "bearer token-value" } }), "token-value");
  assert.equal(getToken({ headers: { authorization: "Basic token-value" } }), null);
  assert.equal(getToken({ headers: {} }), null);
  assert.equal(getToken({}), null);
});

test("verifyToken returns a decoded token or a verification error", async (t) => {
  const secret = "test-only-signing-key";
  setEnv(t, { ACCESS_TOKEN_PRIVATE_KEY: secret, ACCESS_TOKEN_ALGORITHM: "HS256" });

  const token = jwt.sign({ id: "user-1" }, secret, { algorithm: "HS256" });
  const verified = await verifyToken(token);
  assert.equal(verified.value.id, "user-1");
  assert.equal(typeof verified.value.iat, "number");
  assert.ok((await verifyToken("invalid")).error);
});

test("verifyUser delegates its criteria to the MongoDB user repository", async (t) => {
  const expected = { id: "user-1" };
  const find = t.mock.method(UserRepo, "find", async () => expected);

  assert.equal(await verifyUser({ id: "user-1" }), expected);
  assert.deepEqual(find.mock.calls[0].arguments[0], { id: "user-1" });
});

test("HTTP status catalog and contextual errors retain configured metadata", () => {
  const cause = new Error("database down");
  const error = new ContextualApiError({
    statusCode: 503,
    logLevel: "warn",
    customMessage: "Service unavailable",
    codePath: "database",
    extras: { retry: true },
  }, cause);

  assert.equal(httpStatus.OK.code, 200);
  assert.equal(error.message, "Service unavailable");
  assert.equal(error.statusCode, 503);
  assert.equal(error.logLevel, "warn");
  assert.equal(error.data, cause);
  assert.equal(error.codePath, "database");
  assert.deepEqual(error.extras, { retry: true });

  assert.equal(new ContextualApiError({}, cause).message, "database down");
  assert.equal(new ContextualApiError({}).message, "ContextualApiError");
});
