const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const passport = require("../src/config/passport.config");
const { OAuth2Client } = require("google-auth-library");
const authRoutes = require("../src/routes/auth.route");
const userRoutes = require("../src/routes/user.route");
const { authenticateUser } = require("../src/middlewares/access.middleware");
const { error } = require("../src/utils/handlers");
const authService = require("../src/service/auth.service");
const UserRepo = require("../src/repositories/User.repository");
const { createLogger, setEnv, withHttpServer } = require("./helpers");

test("HTTP auth lifecycle covers signup, login, Google auth, profile and password reset", async (t) => {
  const secret = "api-integration-test-secret";
  setEnv(t, {
    ACCESS_TOKEN_PRIVATE_KEY: secret,
    ACCESS_TOKEN_EXPIRATION: "1h",
    ACCESS_TOKEN_ALGORITHM: "HS256",
    GOOGLE_CLIENT_ID: "google-client-id",
    GOOGLE_CLIENT_SECRET: "google-secret",
    FEATURE_CUSTOM_LOGIN: "true",
    FEATURE_CUSTOM_SIGNUP: "true",
    FEATURE_GOOGLE_AUTH: "true",
    FEATURE_GET_USER: "true",
    FEATURE_FORGOT_PASSWORD: "true",
    FEATURE_RESET_PASSWORD: "true",
    FRONTEND_DOMAIN: "https://frontend.example.test",
  });
  t.mock.method(console, "log", () => {});

  const users = [];
  let resetMail;
  const matches = (user, query) => Object.entries(query).every(([key, expected]) => {
    const actualKey = key === "_id" ? "_id" : key;
    if (expected && typeof expected === "object" && "$gt" in expected) {
      return user[actualKey] > expected.$gt;
    }
    return user[actualKey] === expected;
  });
  const findUser = async (query = {}) => users.find((user) => matches(user, query)) || null;

  t.mock.method(UserRepo, "find", findUser);
  t.mock.method(UserRepo, "findOne", findUser);
  t.mock.method(UserRepo, "create", async (details) => {
    const id = details.id || `user-${users.length + 1}`;
    const user = {
      _id: id,
      ...details,
      async save() {
        return this;
      },
    };
    users.push(user);
    return user;
  });
  t.mock.method(UserRepo, "updateById", async (id, updates) => {
    const user = users.find(({ _id }) => _id === (id?._id || id));
    if (!user) return null;
    Object.assign(user, updates);
    return user;
  });
  t.mock.method(authService, "sendMailToUser", async (mail) => {
    resetMail = mail;
  });
  t.mock.method(OAuth2Client.prototype, "getToken", async () => ({
    tokens: { id_token: "google-id-token" },
  }));
  t.mock.method(OAuth2Client.prototype, "verifyIdToken", async () => ({
    getPayload: () => ({
      email: "google@example.com",
      sub: "google-user-id",
      firstName: "Google User",
      emailVerified: true,
      picture: "https://example.test/google.png",
    }),
  }));

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.log = createLogger().logger;
    next();
  });
  app.use(passport.initialize());
  app.use("/api/auth", authRoutes);
  app.use("/api/users", authenticateUser, userRoutes);
  app.use(error);
  app.use((req, res) => res.status(404).json({ status: "failed", message: "Method Not Allowed" }));

  await withHttpServer(app, async (baseUrl) => {
    const signup = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "person@example.com",
        password: "Strong.pass123!",
        name: "Test Person",
      }),
    });
    assert.equal(signup.status, 201);
    assert.equal((await signup.json()).success, true);

    const invalidLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.com", password: "Wrong.pass123!" }),
    });
    assert.equal(invalidLogin.status, 405);

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.com", password: "Strong.pass123!" }),
    });
    assert.equal(login.status, 200);
    const { accessToken } = await login.json();

    const profile = await fetch(`${baseUrl}/api/users`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    assert.equal(profile.status, 200);
    const profileBody = await profile.json();
    assert.equal(profileBody.user.email, "person@example.com");
    assert.equal("password" in profileBody.user, false);

    const forgot = await fetch(`${baseUrl}/api/auth/forgot-password`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.com" }),
    });
    assert.equal(forgot.status, 200);
    assert.ok(resetMail);
    const resetToken = resetMail.templateData.resetUrl.split("/").at(-1);

    const reset = await fetch(`${baseUrl}/api/auth/reset/${resetToken}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        password: "Changed.pass456!",
        confirmPassword: "Changed.pass456!",
      }),
    });
    assert.equal(reset.status, 200);

    const updatedLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "person@example.com", password: "Changed.pass456!" }),
    });
    assert.equal(updatedLogin.status, 200);

    const google = await fetch(`${baseUrl}/api/auth/google/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ googleAuthcode: "valid-google-code" }),
    });
    assert.equal(google.status, 201);
    assert.equal((await google.json()).success, true);

    const missingRoute = await fetch(`${baseUrl}/unhandled`);
    assert.equal(missingRoute.status, 404);
    assert.equal((await missingRoute.json()).status, "failed");
  });
});
