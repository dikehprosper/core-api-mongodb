const express = require("express");
const cors = require("cors");
const passport = require('./src/config/passport.config.js');
const logger = require("./src/config/logger.config.js");
const pinoHttp = require('pino-http');
const authRoutes = require("./src/routes/auth.route.js");
const userRoutes = require("./src/routes/user.route.js");
const healthRoutes = require("./src/routes/health.route.js");
const handlers = require('./src/utils/handlers.js');
const connectMongo = require('./src/config/mongo.config.js');
const { authenticateUser } = require("./src/middlewares/access.middleware.js");
const { globalLimiter } = require("./src/middlewares/rateLimit.middleware");
const helmet = require("helmet");
const hpp = require("hpp");

const app = express();
app.set("trust proxy", 1);
app.use(globalLimiter);
app.use(pinoHttp({ logger }));

// Middleware
app.use(cors({ origin: "*" }));
app.use(helmet());
app.use(hpp());
app.use(express.json());

// Health Check
app.use('/api/auth/health', healthRoutes);

// Auth Routes
app.use(passport.initialize());
app.use("/api/auth", authRoutes);

// Protected Routes (ENTER OTHER ROUTES HERE)
app.use("/api/users", authenticateUser, userRoutes);

// Error Handler
app.use(handlers.error);

// 404 handler
app.use((req, res) => {
    res.status(404).json({ status: "failed", message: "Method Not Allowed" });
});

const PORT = process.env.PORT || 5001;
const startServer = async () => {
    try {
        await connectMongo();

        app.listen(PORT, () => {
            console.log(`This app API is currently running on port ${PORT}`);
        });

    } catch (err) {
        console.error("Failed to start server:", err);
        process.exit(1);
    }
};
if (require.main === module) {
    startServer();
}

module.exports = app;