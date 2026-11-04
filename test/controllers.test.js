const assert = require("node:assert/strict");
const test = require("node:test");
const bcrypt = require("bcrypt");
const authController = require("../src/controllers/auth.controller");
const userController = require("../src/controllers/user.controller");
const authService = require("../src/service/auth.service");
const { httpStatus } = require("../src/utils/helpers/variables.helper");
const { createLogger, createResponse, setEnv } = require("./helpers");

function request(body = {}, extra = {}) {
  return {
    body,
    params: {},
    user: { id: "user-1", email: "user@example.com" },
    log: createLogger().logger,
    ...extra,
  };
}

test("custom login returns a token after authentication and a readable failure otherwise", async (t) => {
  const user = { id: "user-1", email: "user@example.com" };
  let shouldFail = false;
  t.mock.method(authService, "authenticateUser", async () => {
    if (shouldFail) throw new Error("Invalid password");
    return user;
  });
  t.mock.method(authService, "loginUser", async () => undefined);
  t.mock.method(authService, "generateAndSetUserTokens", async () => "signed-token");

  const success = createResponse();
  await authController.customLogin(request({ email: user.email }), success);
  assert.equal(success.statusCode, httpStatus.OK.code);
  assert.deepEqual(success.body, { success: true, accessToken: "signed-token" });

  shouldFail = true;
  const failure = createResponse();
  await authController.customLogin(request({ email: user.email }), failure);
  assert.equal(failure.statusCode, httpStatus.NOT_ALLOWED.code);
  assert.equal(failure.body.message, "Invalid password");
});

test("signup creates users, conflicts with duplicates, and sets passwords for Google users", async (t) => {
  let existingUser = null;
  t.mock.method(authService, "findUser", async () => existingUser);
  t.mock.method(authService, "createUser", async (details) => ({
    id: "new-user",
    _id: "new-user",
    ...details,
  }));
  const updateUser = t.mock.method(authService, "updateUser", async (id, updates) => ({
    id: id.id || id,
    ...updates,
  }));
  t.mock.method(authService, "generateAndSetUserTokens", async () => "signed-token");

  const body = { email: "new@example.com", password: "Strong.pass123!", name: "Ada" };
  const created = createResponse();
  await authController.customSignUp(request(body), created);
  assert.equal(created.statusCode, httpStatus.CREATED.code);
  assert.deepEqual(created.body, { success: true, accessToken: "signed-token" });

  existingUser = { id: "existing", email: body.email, googleId: "google-id", password: null };
  const linked = createResponse();
  await authController.customSignUp(request(body), linked);
  assert.equal(linked.statusCode, httpStatus.OK.code);
  assert.equal(updateUser.mock.calls[0].arguments[0], existingUser);
  assert.equal(await bcrypt.compare(body.password, updateUser.mock.calls[0].arguments[1].password), true);

  existingUser = { id: "existing", email: body.email, password: "hash" };
  const conflict = createResponse();
  await authController.customSignUp(request(body), conflict);
  assert.equal(conflict.statusCode, httpStatus.CONFLICT.code);
  assert.equal(conflict.body.message, "User already exists");
});

test("signup reports service failures with an internal server status", async (t) => {
  t.mock.method(authService, "findUser", async () => {
    throw new Error("storage failed");
  });
  const response = createResponse();

  await authController.customSignUp(
    request({ email: "new@example.com", password: "Strong.pass123!", name: "Ada" }),
    response
  );

  assert.equal(response.statusCode, httpStatus.SERVER_ERROR.code);
  assert.equal(response.ended, true);
});

test("Google callback creates a user or updates an existing user", async (t) => {
  let storedUser = null;
  t.mock.method(authService, "findUser", async () => storedUser);
  t.mock.method(authService, "createUser", async (details) => ({
    id: "google-user",
    _id: "google-user",
    ...details,
  }));
  t.mock.method(authService, "updateUser", async (id, updates) => ({
    id,
    email: "user@example.com",
    ...updates,
  }));
  t.mock.method(authService, "generateAndSetUserTokens", async () => "google-token");

  const payload = {
    email: "user@example.com",
    sub: "google-id",
    firstName: "Ada",
    emailVerified: true,
    picture: "https://example.test/avatar.png",
  };
  const created = createResponse();
  await authController.googleLoginCallback(request(payload), created);
  assert.equal(created.statusCode, httpStatus.CREATED.code);
  assert.equal(created.body.accessToken, "google-token");

  storedUser = { id: "existing", _id: "existing", email: payload.email };
  const updated = createResponse();
  await authController.googleLoginCallback(request(payload), updated);
  assert.equal(updated.statusCode, httpStatus.OK.code);
  assert.equal(updated.body.accessToken, "google-token");
});

test("Google callback maps service errors to a server error", async (t) => {
  t.mock.method(authService, "findUser", async () => {
    throw new Error("storage failed");
  });
  const response = createResponse();

  await authController.googleLoginCallback(request({ email: "user@example.com" }), response);

  assert.equal(response.statusCode, httpStatus.SERVER_ERROR.code);
  assert.equal(response.ended, true);
});

test("forgot-password saves a hashed reset token and sends the reset email", async (t) => {
  setEnv(t, { FRONTEND_DOMAIN: "https://frontend.example.test" });
  t.mock.method(console, "log", () => {});
  let saved = false;
  let mail;
  t.mock.method(authService, "sendMailToUser", async (options) => {
    mail = options;
  });

  const user = {
    id: "user-1",
    email: "user@example.com",
    async save() {
      saved = true;
    },
  };
  const response = createResponse();

  await authController.sendResetlinkToEmail(request({}, { user }), response);

  assert.equal(response.statusCode, httpStatus.OK.code);
  assert.equal(response.body.success, true);
  assert.equal(saved, true);
  assert.match(user.resetPasswordToken, /^[a-f0-9]{64}$/);
  assert.ok(user.resetPasswordExpire > Date.now());
  assert.equal(mail.recipientEmail, user.email);
  assert.match(mail.templateData.resetUrl, /^https:\/\/frontend\.example\.test\/reset\/[a-f0-9]{64}$/);
  assert.notEqual(mail.templateData.resetUrl.split("/").at(-1), user.resetPasswordToken);
});

test("forgot-password reports persistence or email failures", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(authService, "sendMailToUser", async () => {
    throw new Error("mail failed");
  });
  const response = createResponse();

  await authController.sendResetlinkToEmail(request({}, {
    user: { email: "user@example.com", async save() {} },
  }), response);

  assert.equal(response.statusCode, httpStatus.SERVER_ERROR.code);
  assert.equal(response.ended, true);
});

test("password reset rejects expired tokens and saves a hash for a valid token", async (t) => {
  let matchingUser = null;
  const queries = [];
  t.mock.method(authService, "findUser", async (query) => {
    queries.push(query);
    return matchingUser;
  });

  const invalid = createResponse();
  await authController.customResetPassword(
    request({ password: "New.pass123!" }, { params: { token: "expired-token-value" } }),
    invalid
  );
  assert.equal(invalid.statusCode, httpStatus.BAD_REQUEST.code);
  assert.equal(invalid.body.message, "Invalid or expired token");

  let saved = false;
  matchingUser = {
    id: "user-1",
    async save() {
      saved = true;
    },
  };
  const success = createResponse();
  await authController.customResetPassword(
    request({ password: "New.pass123!" }, { params: { token: "valid-token-value" } }),
    success
  );

  assert.equal(success.statusCode, httpStatus.OK.code);
  assert.equal(success.body.success, true);
  assert.equal(await bcrypt.compare("New.pass123!", matchingUser.password), true);
  assert.equal(matchingUser.resetPasswordToken, undefined);
  assert.equal(matchingUser.resetPasswordExpire, undefined);
  assert.equal(saved, true);
  assert.ok(queries[1].resetPasswordToken);
  assert.ok(queries[1].resetPasswordExpire.$gt);
});

test("password reset reports storage failures", async (t) => {
  t.mock.method(authService, "findUser", async () => {
    throw new Error("storage failed");
  });
  const response = createResponse();

  await authController.customResetPassword(
    request({ password: "New.pass123!" }, { params: { token: "valid-token-value" } }),
    response
  );

  assert.equal(response.statusCode, httpStatus.SERVER_ERROR.code);
  assert.equal(response.ended, true);
});

test("user profile controller returns public fields and handles missing user data", async () => {
  const response = createResponse();
  await userController.getUserData(request({}, {
    user: {
      id: "user-1",
      email: "user@example.com",
      password: "secret",
      resetPasswordToken: "token",
      resetPasswordExpire: new Date(),
    },
  }), response);

  assert.equal(response.statusCode, httpStatus.OK.code);
  assert.equal(response.body.user.email, "user@example.com");
  assert.equal("password" in response.body.user, false);
  assert.equal("resetPasswordToken" in response.body.user, false);

  const { logger, entries } = createLogger();
  const invalidResponse = createResponse();
  await userController.getUserData({
    get user() { throw new Error("missing user"); },
    log: logger,
  }, invalidResponse);
  assert.equal(invalidResponse.statusCode, httpStatus.NOT_ALLOWED.code);
  assert.equal(invalidResponse.body.message, "missing user");
  assert.equal(entries[0].level, "info");
});
