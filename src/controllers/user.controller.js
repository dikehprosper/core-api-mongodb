/**
 * @file getUserData Controller
 * @description Handles fetching the authenticated user's profile data
 * while ensuring sensitive information is not exposed in the response.
 */

const { sendLogs } = require("../utils/helpers/logs.helper");
const { httpStatus } = require("../utils/helpers/variables.helper");

module.exports = {
    getUserData,
};

/**
 * @function getUserData
 * @description Returns the currently authenticated user's data (excluding sensitive fields)
 *
 * @param {Object} req - Express request object
 * @param {Object} req.user - Authenticated user object (attached by auth middleware)
 * @param {Object} req.log - Logging context or metadata
 * @param {Object} res - Express response object
 *
 * @returns {Object} JSON response containing:
 *  - success {boolean} - Request status
 *  - user {Object} - Sanitized user data (no sensitive fields)
 *
 * @throws Will catch and handle any unexpected errors during execution
 */
async function getUserData(req, res) {
    let log;
    let user;
    try {
        log = req.log;
        user = req.user;

        /**
         * Remove sensitive fields from the user object
         * to prevent exposure in API response
         */
        const { password, resetPasswordToken, resetPasswordExpire, ...safeUser } =
            req.user;

        // Send successful response with safe user data
        return res.status(200).json({
            success: true,
            user: safeUser,
        });
    } catch (err) {
        // Extract error message or use default fallback
        const message = err?.message || "Failed to fetch user profile";

        /**
         * Log the error for monitoring/debugging
         * Includes function name and user context
         */
        sendLogs(log, "info", {
            message,
            fnc: "getUserData",
            info: { user },
        });

        // Return error response with appropriate status code
        return res.status(httpStatus.NOT_ALLOWED.code).json({
            success: false,
            message,
        });
    }
}