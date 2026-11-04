const assert = require("node:assert/strict");
const test = require("node:test");
const express = require("express");
const mongoose = require("mongoose");
const healthRoutes = require("../src/routes/health.route");
const { withHttpServer } = require("./helpers");

test("health endpoint reports API and MongoDB availability", async (t) => {
  t.mock.method(console, "log", () => {});
  t.mock.method(mongoose, "connect", async () => mongoose);
  const app = express();
  app.use("/", healthRoutes);

  await withHttpServer(app, async (baseUrl) => {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      message: "This app API is currently running on port",
      baseUrl: "YOUR_APP_LIVE_URL",
      status: "live",
    });
  });
});

test("health endpoint reports an error when MongoDB is unavailable", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(mongoose, "connect", async () => {
    throw new Error("database unavailable");
  });
  const app = express();
  app.use("/", healthRoutes);

  await withHttpServer(app, async (baseUrl) => {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.status, "error");
    assert.deepEqual(body.error, {});
  });
});
