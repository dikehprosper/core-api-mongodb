const { sendLogs } = require('./helpers/logs.helper.js')
const { ContextualApiError } = require('./helpers/variables.helper')

/**
 * Exported utility wrappers and handlers
 */
module.exports = {
    error,
    routesWrapper,
    functionWrapper,
    response,
    returnErrorFunctionWrapper
}

/**
 * Wraps an async function and converts thrown errors into ContextualApiError
 * 
 * @param {Function} fn - Function to execute
 * @param {Array} args - Arguments to pass into the function
 * @param {Object} context - Additional metadata for error handling
 * @returns {Promise<*>} - Result of the function execution
 * @throws {ContextualApiError}
 */
async function functionWrapper(fn, args = [], context = {}) {
    try {
        return await fn(...args)
    } catch (error) {
        throw new ContextualApiError({
            logLevel: 'error',
            statusCode: 500,
            customMessage: context.customMessage || null,
            codePath: context.codePath || null,
            extras: context.extras || null
        }, error)
    }
}

/**
 * Wraps a function and returns structured response/error instead of throwing
 * Useful for service-layer calls where you want controlled error handling
 * 
 * @param {Function} fn - Function to execute
 * @param {Array} args - Arguments to pass into the function
 * @param {Object} context - Logging and return configuration
 * @returns {Promise<Object|Array>} - Either { response, error } or [response, error]
 */
async function returnErrorFunctionWrapper(fn, args = [], context = {}) {
    const fnName = fn?.name || 'anonymous function'

    try {
        const response = await fn(...args)

        // Log success if logger and config provided
        if (context.loggerInstance && context.success) {
            sendLogs(context.loggerInstance, 'info', { fnc: fnName, ...context.success })
        }

        // Return based on configured return type
        if (context.returnType === 'array') {
            return [response, null]
        } else {
            return { response, error: null }
        }
    } catch (error) {
        // Log error if logger and config provided
        if (context.loggerInstance && context.error) {
            sendLogs(context.loggerInstance, 'error', { fnc: fnName, error, ...context.error })
        }

        // Return structured error
        if (context.returnType === 'array') {
            return [null, error]
        } else {
            return { response: null, error }
        }
    }
}

/**
 * Wraps an array of Express route handlers into a safe execution pipeline
 * Automatically catches errors and formats them consistently
 * 
 * @param {Array<Function>} fns - Array of middleware/route handler functions
 * @returns {Array<Function>} - Wrapped middleware functions
 */
function routesWrapper(fns) {
    return fns.map((fn, index) => async (req, res, next) => {
        try {
            await fn(req, res, next)
        } catch (err) {
            // Build execution path for debugging
            const prevFncNames = fns.slice(0, index).map(f => f.name).join(' => ')
            const currentFncName = fn.name

            const codePath = `routesWrapper =>|| ${prevFncNames ? prevFncNames + ' => ' : ''}::${currentFncName}${err.codePath ? ' -> ' + err.codePath : ''}::`

            if (err.customType === 'ContextualApiError') {
                const error = err.data
                    ? {
                        name: err.data.name,
                        stack: err.data.stack,
                        message: err.data.message
                    }
                    : null

                // Structured contextual error response
                const errorDetails = {
                    message: err.message,
                    logLevel: err.logLevel || 'error',
                    statusCode: err.statusCode,
                    info: {
                        codePath,
                        extras: err.extras ?? null,
                        error,
                        fncPipeline: fns.map(f => f.name)
                    }
                }

                next(errorDetails)
            } else {
                // Fallback for unhandled errors
                const error = {
                    name: err.name,
                    stack: err.stack,
                    message: err.message
                }

                const errorDetails = {
                    message: err.message,
                    logLevel: 'error',
                    statusCode: 500,
                    info: {
                        codePath,
                        extras: err.extras ?? null,
                        error,
                        fncPipeline: fns.map(f => f.name)
                    }
                }

                next(errorDetails)
            }
        }
    })
}

/**
 * Centralized Express error handler
 * Logs error details and sends appropriate HTTP response
 * 
 * @param {Object} error - Error object passed from middleware
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 */
function error(error, req, res, _next) {
    try {
        // Log error with user context
        sendLogs(req.log, error.logLevel, {
            message: error.message,
            info: { user: { email: req.user?.email, id: req.user?.id }, ...error.info }
        })

        res.status(error.statusCode).end()
    } catch (error) {
        // Fallback error handler failure logging
        sendLogs(req.log, 'error', {
            message: 'An unexpected error occurred within the error handler',
            info: { error, user: { email: req.user?.email, id: req.user?.id }, codePath: 'routesWrapper =>|| error' }
        })

        res.status(500).end()
    }
}

/**
 * Standardized API response handler
 * Sends formatted JSON response and logs request details
 * 
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Object} info - Response configuration
 * @param {String} info.message - Log message
 * @param {*} info.data - Response payload
 * @param {*} info.errors - Errors (if any)
 * @param {*} info.meta - Additional metadata
 * @param {Number} info.statusCode - HTTP status code
 * @param {String} info.fnc - Function name (for logging)
 * @param {*} info.extras - अतिरिक्त contextual data
 */
function response(req, res, info) {
    const { message, data, errors, meta, statusCode, fnc, extras = null } = info

    const response = {
        success: statusCode >= 200 && statusCode < 300,
        message: (statusCode >= 200 && statusCode < 300 ? 'Success' : 'Error'),
        data: data || null,
        meta: meta || null,
        requestUrl: req.originalUrl,
        timestamp: new Date().toISOString()
    }

    // Log response details
    sendLogs(req.log, 'info', {
        message,
        fnc,
        info: { user: { email: req.user?.email, id: req.user?.id }, extras, errors }
    })

    res.status(statusCode).json(response)
}