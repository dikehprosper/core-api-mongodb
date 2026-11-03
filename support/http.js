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
        }
    };
}

function createLogger() {
    const calls = [];
    const logger = {};

    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
        logger[level] = (...args) => calls.push({ level, args });
    }

    return { logger, calls };
}

module.exports = { createResponse, createLogger };
