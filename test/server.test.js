const assert = require("node:assert/strict");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const UserRepo = require("../src/repositories/User.repository");
const { setEnv, withHttpServer } = require("./helpers");

test("server starts after MongoDB connects and routes unknown requests to 404", async (t) => {
  const secret = "server-test-secret";
  setEnv(t, {
    PORT: "0",
    ACCESS_TOKEN_PRIVATE_KEY: secret,
    ACCESS_TOKEN_ALGORITHM: "HS256",
    PINO_LOG_LEVEL: "silent",
  });
  const connect = t.mock.method(mongoose, "connect", async () => mongoose);
  const app = require("../server");
  const listen = t.mock.method(app, "listen", (port, callback) => {
    callback();
    return undefined;
  });
  t.mock.method(UserRepo, "find", async () => ({ id: "server-user" }));
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", () => {});
  t.mock.method(process, "exit", () => {});

  await app.startServer();
  assert.equal(connect.mock.callCount(), 1);
  assert.equal(listen.mock.callCount(), 1);
  assert.equal(listen.mock.calls[0].arguments[0], "0");

  const token = jwt.sign({ id: "server-user" }, secret, { algorithm: "HS256" });
  await withHttpServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/unhandled`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).status, "failed");
  });

  connect.mock.mockImplementation(async () => {
    throw new Error("database offline");
  });
  await app.startServer();
  assert.equal(process.exit.mock.callCount(), 1);
});
