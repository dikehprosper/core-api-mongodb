const http = require("node:http");

function createResponse() {
  return {
    statusCode: undefined,
    body: undefined,
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function createLogger() {
  const entries = [];
  const logger = {};

  for (const level of ["trace", "debug", "info", "warn", "error", "fatal"]) {
    logger[level] = (message) => entries.push({ level, message });
  }

  return { logger, entries };
}

async function withHttpServer(app, run) {
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

function setEnv(t, values) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]])
  );

  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

module.exports = { createLogger, createResponse, setEnv, withHttpServer };
