const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const authMiddleware = require("../src/middlewares/authMiddleware");
const accessMiddleware = require("../src/middlewares/access.middleware").authenticateUser;
const flags = require("../src/middlewares/flags.middleware");
const validation = require("../src/middlewares/validate.middleware");
const verification = require("../src/middlewares/verification.middleware");
const rateLimiters = require("../src/middlewares/rateLimit.middleware");
const UserRepo = require("../src/repositories/User.repository");
const { OAuth2Client } = require("google-auth-library");
const { httpStatus } = require("../src/utils/helpers/variables.helper");
const { createLogger, createResponse, setEnv } = require("./helpers");

const validPassword = "Valid.pass123!";

test("rate limit and slowdown middleware are configured as Express handlers", () => {
  assert.deepEqual(Object.keys(rateLimiters).sort(), [
    "authLimiter",
    "authSlowDown",
    "forgotPasswordLimiter",
    "globalLimiter",
  ]);
  for (const middleware of Object.values(rateLimiters)) {
    assert.equal(typeof middleware, "function");
  }
});

function request(body = {}) {
  const { logger } = createLogger();
  return { body, params: {}, headers: {}, log: logger };
}

test("feature flags pass unless their setting is explicitly false", (t) => {
  const flagNames = {
    signUpFlag: "FEATURE_CUSTOM_SIGNUP",
    loginFlag: "FEATURE_CUSTOM_LOGIN",
    googleAuthFlag: "FEATURE_GOOGLE_AUTH",
    getUserFlag: "FEATURE_GET_USER",
    forgotPasswordFlag: "FEATURE_FORGOT_PASSWORD",
    resetPasswordFlag: "FEATURE_RESET_PASSWORD",
  };

  for (const [functionName, envName] of Object.entries(flagNames)) {
    const middleware = flags[functionName];
    setEnv(t, { [envName]: "false" });
    const blocked = createResponse();
    let nextCalls = 0;
    middleware({}, blocked, () => nextCalls++);
    assert.equal(blocked.statusCode, httpStatus.SERVICE_UNAVAILABLE.code, functionName);
    assert.equal(nextCalls, 0, functionName);

    process.env[envName] = "true";
    middleware({}, createResponse(), () => nextCalls++);
    assert.equal(nextCalls, 1, functionName);
  }
});

test("login validation accepts valid input and rejects invalid input", () => {
  const req = request({ email: "user@example.com", password: validPassword });
  let nextCalled = false;
  validation.validateLoginData(req, createResponse(), () => (nextCalled = true));

  assert.equal(nextCalled, true);
  assert.equal(req.body.email, "user@example.com");

  const response = createResponse();
  validation.validateLoginData(request({ email: "bad", password: "x" }), response, () => assert.fail());
  assert.equal(response.statusCode, httpStatus.BAD_REQUEST.code);
});

test("signup validation accepts valid data and rejects missing fields", () => {
  const req = request({ email: "user@example.com", password: validPassword, name: "Ada" });
  let nextCalled = false;
  validation.validateSignUpData(req, createResponse(), () => (nextCalled = true));
  assert.equal(nextCalled, true);
  assert.equal(req.body.name, "Ada");

  const response = createResponse();
  validation.validateSignUpData(request({ email: "bad" }), response, () => assert.fail());
  assert.equal(response.statusCode, httpStatus.BAD_REQUEST.code);
});

test("Google callback validation retains only the validated authorization code", () => {
  const req = request({ googleAuthcode: "valid-google-code", ignored: true });
  let nextCalled = false;
  validation.validateGoogleLoginCallbackData(req, createResponse(), () => (nextCalled = true));
  assert.deepEqual(req.body, { googleAuthcode: "valid-google-code" });
  assert.equal(nextCalled, true);

  const response = createResponse();
  validation.validateGoogleLoginCallbackData(request({}), response, () => assert.fail());
  assert.equal(response.statusCode, httpStatus.BAD_REQUEST.code);
});

test("email, password, match and token validators handle valid and invalid values", () => {
  const goodEmail = request({ email: "person@example.com" });
  validation.validateEmailSyntax(goodEmail, createResponse(), () => {});
  assert.equal(goodEmail.body.email, "person@example.com");

  const badEmail = createResponse();
  validation.validateEmailSyntax(request({ email: "bad" }), badEmail, () => assert.fail());
  assert.equal(badEmail.statusCode, httpStatus.BAD_REQUEST.code);

  const goodPassword = request({ password: validPassword });
  validation.validatePasswordSyntax(goodPassword, createResponse(), () => {});
  assert.equal(goodPassword.body.password, validPassword);

  const badPassword = createResponse();
  validation.validatePasswordSyntax(request({ password: "weak" }), badPassword, () => assert.fail());
  assert.equal(badPassword.statusCode, httpStatus.BAD_REQUEST.code);

  let matched = false;
  validation.validateIfPasswordMatches(
    request({ password: "same", confirmPassword: "same" }),
    createResponse(),
    () => (matched = true)
  );
  assert.equal(matched, true);

  const mismatch = createResponse();
  validation.validateIfPasswordMatches(
    request({ password: "one", confirmPassword: "two" }),
    mismatch,
    () => assert.fail()
  );
  assert.equal(mismatch.statusCode, httpStatus.BAD_REQUEST.code);

  const goodToken = { params: { token: "1234567890" }, log: createLogger().logger };
  validation.validateTokenSyntax(goodToken, createResponse(), () => {});
  assert.equal(goodToken.params.token, "1234567890");

  const badToken = createResponse();
  validation.validateTokenSyntax(
    { params: { token: "short" }, log: createLogger().logger },
    badToken,
    () => assert.fail()
  );
  assert.equal(badToken.statusCode, httpStatus.BAD_REQUEST.code);
});

test("validation middleware converts malformed request objects into server errors", () => {
  const bodyValidators = [
    validation.validateLoginData,
    validation.validateSignUpData,
    validation.validateGoogleLoginCallbackData,
    validation.validateEmailSyntax,
    validation.validatePasswordSyntax,
    validation.validateIfPasswordMatches,
  ];

  for (const middleware of bodyValidators) {
    const response = createResponse();
    middleware({ body: null, log: createLogger().logger }, response, () => assert.fail());
    assert.equal(response.statusCode, httpStatus.SERVER_ERROR.code, middleware.name);
  }

  const response = createResponse();
  validation.validateTokenSyntax(
    { params: null, log: createLogger().logger },
    response,
    () => assert.fail()
  );
  assert.equal(response.statusCode, httpStatus.SERVER_ERROR.code);
});

test("JWT middleware rejects missing and invalid tokens and accepts valid tokens", (t) => {
  setEnv(t, { JWT_SECRET: "middleware-test-secret" });

  const missing = createResponse();
  authMiddleware({ headers: {} }, missing, () => assert.fail());
  assert.equal(missing.statusCode, httpStatus.UNAUTHORIZED.code);
  assert.equal(missing.body.message, "No token, not authorized");

  const invalid = createResponse();
  authMiddleware({ headers: { authorization: "Bearer invalid" } }, invalid, () => assert.fail());
  assert.equal(invalid.statusCode, httpStatus.UNAUTHORIZED.code);

  const token = jwt.sign({ id: "user-1" }, process.env.JWT_SECRET);
  const req = { headers: { authorization: `Bearer ${token}` } };
  let nextCalled = false;
  authMiddleware(req, createResponse(), () => (nextCalled = true));
  assert.equal(req.user.id, "user-1");
  assert.equal(nextCalled, true);
});

test("access middleware rejects missing and invalid bearer tokens", async (t) => {
  setEnv(t, {
    ACCESS_TOKEN_PRIVATE_KEY: "access-test-secret",
    ACCESS_TOKEN_ALGORITHM: "HS256",
  });
  t.mock.method(console, "log", () => {});

  const missing = createResponse();
  await accessMiddleware({ headers: {}, log: createLogger().logger }, missing, () => assert.fail());
  assert.equal(missing.statusCode, httpStatus.UNAUTHORIZED.code);

  const invalid = createResponse();
  await accessMiddleware(
    { headers: { authorization: "Bearer invalid" }, log: createLogger().logger },
    invalid,
    () => assert.fail()
  );
  assert.equal(invalid.statusCode, httpStatus.UNAUTHORIZED.code);
});

test("access middleware loads the token user and calls next", async (t) => {
  const secret = "access-test-secret";
  setEnv(t, { ACCESS_TOKEN_PRIVATE_KEY: secret, ACCESS_TOKEN_ALGORITHM: "HS256" });
  t.mock.method(console, "log", () => {});
  const user = { id: "user-1", email: "user@example.com" };
  const find = t.mock.method(UserRepo, "find", async () => user);
  const token = jwt.sign({ id: user.id }, secret, { algorithm: "HS256" });
  const req = { headers: { authorization: `Bearer ${token}` }, log: createLogger().logger };
  let nextCalled = false;

  await accessMiddleware(req, createResponse(), () => (nextCalled = true));

  assert.equal(req.user, user);
  assert.equal(find.mock.calls[0].arguments[0]._id, user.id);
  assert.equal(nextCalled, true);
});

test("access middleware rejects a valid token when the MongoDB user is missing", async (t) => {
  const secret = "access-test-secret";
  setEnv(t, { ACCESS_TOKEN_PRIVATE_KEY: secret, ACCESS_TOKEN_ALGORITHM: "HS256" });
  t.mock.method(console, "log", () => {});
  t.mock.method(UserRepo, "find", async () => null);
  const token = jwt.sign({ id: "missing-user" }, secret, { algorithm: "HS256" });
  const response = createResponse();

  await accessMiddleware(
    { headers: { authorization: `Bearer ${token}` }, log: createLogger().logger },
    response,
    () => assert.fail()
  );

  assert.equal(response.statusCode, httpStatus.UNAUTHORIZED.code);
});

test("access middleware returns a server error when MongoDB lookup fails", async (t) => {
  const secret = "access-test-secret";
  setEnv(t, { ACCESS_TOKEN_PRIVATE_KEY: secret, ACCESS_TOKEN_ALGORITHM: "HS256" });
  t.mock.method(console, "log", () => {});
  t.mock.method(UserRepo, "find", async () => {
    throw new Error("database failure");
  });
  const token = jwt.sign({ id: "user-1" }, secret, { algorithm: "HS256" });
  const response = createResponse();

  await accessMiddleware(
    { headers: { authorization: `Bearer ${token}` }, log: createLogger().logger },
    response,
    () => assert.fail()
  );

  assert.equal(response.statusCode, httpStatus.SERVER_ERROR.code);
});

test("email verification attaches the user or returns not found", async (t) => {
  const user = { id: "user-1", email: "user@example.com" };
  let result = user;
  const find = t.mock.method(UserRepo, "find", async () => result);
  const req = request({ email: user.email });
  let nextCalled = false;

  await verification.verifyUserWithEmail(req, createResponse(), () => (nextCalled = true));
  assert.equal(req.user, user);
  assert.deepEqual(find.mock.calls[0].arguments[0], { email: user.email });
  assert.equal(nextCalled, true);

  result = null;
  const response = createResponse();
  await verification.verifyUserWithEmail(request({ email: user.email }), response, () => assert.fail());
  assert.equal(response.statusCode, httpStatus.NOT_ALLOWED.code);
});

test("email verification returns a server error when MongoDB lookup fails", async (t) => {
  t.mock.method(UserRepo, "find", async () => {
    throw new Error("database failure");
  });
  const response = createResponse();

  await verification.verifyUserWithEmail(
    request({ email: "user@example.com" }),
    response,
    () => assert.fail()
  );

  assert.equal(response.statusCode, httpStatus.SERVER_ERROR.code);
});

test("Google verification rejects missing ID tokens and empty payloads", async (t) => {
  setEnv(t, { GOOGLE_CLIENT_ID: "google-client-id", GOOGLE_CLIENT_SECRET: "google-secret" });
  let tokens = {};
  let payload = { email: "user@example.com" };
  t.mock.method(OAuth2Client.prototype, "getToken", async () => ({ tokens }));
  t.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => ({
    getPayload: () => payload,
  }));

  const missingToken = createResponse();
  await verification.verifyGoogleAuthCode(
    request({ googleAuthcode: "valid-google-code" }),
    missingToken,
    () => assert.fail()
  );
  assert.equal(missingToken.statusCode, httpStatus.UNAUTHORIZED.code);

  tokens = { id_token: "google-id-token" };
  payload = null;
  const missingPayload = createResponse();
  await verification.verifyGoogleAuthCode(
    request({ googleAuthcode: "valid-google-code" }),
    missingPayload,
    () => assert.fail()
  );
  assert.equal(missingPayload.statusCode, httpStatus.UNAUTHORIZED.code);
});

test("Google verification replaces the request body and handles client errors", async (t) => {
  setEnv(t, { GOOGLE_CLIENT_ID: "google-client-id", GOOGLE_CLIENT_SECRET: "google-secret" });
  const payload = { email: "user@example.com", name: "Ada" };
  let failure;
  t.mock.method(OAuth2Client.prototype, "getToken", async () => {
    if (failure) throw failure;
    return { tokens: { id_token: "google-id-token" } };
  });
  t.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => ({
    getPayload: () => payload,
  }));

  const req = request({ googleAuthcode: "valid-google-code" });
  let nextCalled = false;
  await verification.verifyGoogleAuthCode(req, createResponse(), () => (nextCalled = true));
  assert.deepEqual(req.body, payload);
  assert.equal(nextCalled, true);

  failure = new Error("Google unavailable");
  t.mock.method(console, "error", () => {});
  const response = createResponse();
  await verification.verifyGoogleAuthCode(
    request({ googleAuthcode: "valid-google-code" }),
    response,
    () => assert.fail()
  );
  assert.equal(response.statusCode, httpStatus.SERVER_ERROR.code);
  assert.equal(response.body.message, "Google authentication failed");
});
