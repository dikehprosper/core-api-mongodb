const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const passport = require("../src/config/passport.config");
const bcrypt = require("bcrypt");
const logger = require("../src/config/logger.config");
const authService = require("../src/service/auth.service");
const repository = require("../src/repositories/User.repository");
const User = require("../src/models/User");
const ses = require("../src/config/aws.config");
const { sendMail } = require("../src/utils/helpers/mail.helper");
const { setEnv } = require("./helpers");

test("user repository delegates MongoDB reads, updates, creates and missing-user cases", async (t) => {
  const instance = { _id: "user-1", email: "user@example.com" };
  const findOne = t.mock.method(User, "findOne", async () => instance);
  const findByIdAndUpdate = t.mock.method(User, "findByIdAndUpdate", async () => instance);
  const create = t.mock.method(User, "create", async (attributes) => attributes);

  assert.equal(await repository.findOne({ email: instance.email }), instance);
  assert.deepEqual(findOne.mock.calls[0].arguments[0], { email: instance.email });
  assert.equal(await repository.find({ email: instance.email }), instance);
  assert.deepEqual(findOne.mock.calls[1].arguments[0], { email: instance.email });

  assert.equal(await repository.updateById("user-1", { name: "Ada" }), instance);
  assert.deepEqual(findByIdAndUpdate.mock.calls[0].arguments, [
    "user-1",
    { $set: { name: "Ada" } },
    { new: true },
  ]);
  findByIdAndUpdate.mock.mockImplementation(async () => null);
  assert.equal(await repository.updateById("missing", { name: "Nobody" }), null);

  assert.deepEqual(await repository.create({ email: instance.email }), { email: instance.email });
  assert.deepEqual(create.mock.calls[0].arguments[0], { email: instance.email });
});

test("User model configures MongoDB fields, defaults, uniqueness and timestamps", () => {
  assert.equal(User.modelName, "User");
  assert.equal(User.schema.options.timestamps, true);
  assert.equal(User.schema.path("email").options.unique, true);
  assert.equal(User.schema.path("emailVerified").defaultValue, false);
  assert.equal(User.schema.path("googleId").defaultValue, undefined);
  assert.equal(User.schema.path("resetPasswordExpire").instance, "Date");
  assert.equal(User.schema.path("avatar.profileLetter").instance, "String");
});

test("MongoDB connection helper connects with MONGO_URI and reports connection failures", async (t) => {
  setEnv(t, { MONGO_URI: "mongodb://localhost/test_database" });
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  const connect = t.mock.method(mongoose, "connect", async () => mongoose);
  const connectMongo = require("../src/config/mongo.config");

  await connectMongo();
  assert.equal(connect.mock.callCount(), 1);
  assert.equal(connect.mock.calls[0].arguments[0], process.env.MONGO_URI);

  connect.mock.mockImplementation(async () => {
    throw new Error("database unavailable");
  });
  await assert.rejects(connectMongo(), /database unavailable/);
  assert.equal(connect.mock.callCount(), 2);
});

test("AWS SES and Pino configuration export their configured clients", () => {
  assert.equal(typeof ses.sendEmail, "function");
  assert.equal(typeof logger.info, "function");
  assert.equal(typeof logger.error, "function");
  assert.equal(typeof logger.level, "string");
});

test("Passport local strategy handles unknown users, Google accounts, bad passwords and errors", async (t) => {
  const strategy = passport._strategy("login");
  let lookupResult = null;
  let lookupError = null;
  let passwordValid = false;
  t.mock.method(repository, "find", async () => {
    if (lookupError) throw lookupError;
    return lookupResult;
  });
  t.mock.method(bcrypt, "compare", async () => passwordValid);

  const verify = (email, password) => new Promise((resolve) => {
    strategy._verify(email, password, (error, user, info) => resolve({ error, user, info }));
  });

  let result = await verify("missing@example.com", "password");
  assert.equal(result.user, false);
  assert.equal(result.info.message, "User not found");

  lookupResult = { email: "google@example.com", googleId: "google-id", password: null };
  result = await verify(lookupResult.email, "password");
  assert.equal(result.user, false);
  assert.match(result.info.message, /signed up using Google/);

  lookupResult = { email: "user@example.com", password: "hash" };
  result = await verify(lookupResult.email, "incorrect");
  assert.equal(result.user, false);
  assert.equal(result.info.message, "Invalid Password");

  passwordValid = true;
  result = await verify(lookupResult.email, "correct");
  assert.equal(result.user, lookupResult);
  assert.equal(result.info.message, "Logged in Successfully");

  lookupError = new Error("database failure");
  result = await verify("user@example.com", "password");
  assert.equal(result.error, lookupError);
});

test("auth service delegates authentication, login, repository and mail operations", async (t) => {
  const user = { id: "user-1" };
  let authenticate = (done) => done(null, user);
  t.mock.method(passport, "authenticate", (strategy, options, done) => () => authenticate(done));
  assert.equal(await authService.authenticateUser({}, "login"), user);

  authenticate = (done) => done(new Error("strategy failed"));
  await assert.rejects(authService.authenticateUser({}, "login"), /strategy failed/);

  authenticate = (done) => done(null, false, { message: "denied" });
  await assert.rejects(authService.authenticateUser({}, "login"), { message: "denied" });

  const loginRequest = { login: (actualUser, options, done) => done(null) };
  await authService.loginUser(loginRequest, user);
  await assert.rejects(
    authService.loginUser({
      login: (actualUser, options, done) => done(new Error("login failed")),
    }, user),
    /login failed/
  );

  const findOne = t.mock.method(repository, "findOne", async () => user);
  const updateById = t.mock.method(repository, "updateById", async () => user);
  const create = t.mock.method(repository, "create", async () => user);

  assert.equal(await authService.findUser({ id: user.id }), user);
  assert.deepEqual(findOne.mock.calls[0].arguments[0], { id: user.id });
  assert.equal(await authService.updateUser(user.id, { name: "Ada" }), user);
  assert.deepEqual(updateById.mock.calls[0].arguments, [user.id, { name: "Ada" }]);
  assert.equal(await authService.createUser({ email: "user@example.com" }), user);
  const createdDetails = create.mock.calls[0].arguments[0];
  assert.match(createdDetails.id, /^[0-9a-f-]{36}$/);
  assert.equal(createdDetails.email, "user@example.com");

  const sent = { MessageId: "mail-1" };
  t.mock.method(ses, "sendEmail", () => ({ promise: async () => sent }));
  assert.equal(await authService.sendMailToUser({
    recipientEmail: "user@example.com",
    templateData: { resetUrl: "https://example.test/reset/token" },
  }), sent);
});

test("auth service signs access tokens with configured signing options", async (t) => {
  const secret = "service-token-secret";
  setEnv(t, {
    ACCESS_TOKEN_PRIVATE_KEY: secret,
    ACCESS_TOKEN_EXPIRATION: "1h",
    ACCESS_TOKEN_ALGORITHM: "HS256",
  });
  const token = await authService.generateAndSetUserTokens({ id: "user-1" });

  assert.equal(jwt.verify(token, secret, { algorithms: ["HS256"] }).id, "user-1");
});

test("mail helper builds a reset email and sends it through SES", async (t) => {
  let parameters;
  const result = { MessageId: "message-1" };
  t.mock.method(ses, "sendEmail", (params) => {
    parameters = params;
    return { promise: async () => result };
  });
  setEnv(t, { SES_SENDER: "sender@example.test" });

  assert.equal(await sendMail({
    recipientEmail: "recipient@example.test",
    templateData: { resetUrl: "https://frontend.example.test/reset/token" },
  }), result);
  assert.equal(parameters.Source, "sender@example.test");
  assert.deepEqual(parameters.Destination, { ToAddresses: ["recipient@example.test"] });
  assert.equal(parameters.Message.Subject.Data, "Password Reset Request");
  assert.match(parameters.Message.Body.Html.Data, /https:\/\/frontend\.example\.test\/reset\/token/);
});
