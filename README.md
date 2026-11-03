

# CORE-API

A fast starter kit for authentication and user management, built with Node.js, Express, and MongoDB. This API is designed for developers who want to quickly set up a secure backend without writing everything from scratch. Just clone, install, and add your own features!

## Features
- Fast setup for authentication and user management
- User registration and authentication (JWT, Passport)
- Rate limiting and security middleware (Helmet, HPP, CORS)
- Centralized logging with Pino
- MongoDB integration (Mongoose)
- AWS integration for file storage
- Email notifications
- Modular structure for controllers, services, repositories, and middlewares

## Project Structure
```
CORE-API/
├── package.json
├── server.js
├── src/
│   ├── config/
│   │   ├── aws.config.js
│   │   ├── logger.config.js
│   │   ├── mongo.config.js
│   │   └── passport.config.js
│   ├── controllers/
│   │   ├── auth.controller.js
│   │   └── user.controller.js
│   ├── middlewares/
│   │   ├── access.middleware.js
│   │   ├── authMiddleware.js
│   │   ├── flags.middleware.js
│   │   ├── rateLimit.middleware.js
│   │   ├── validate.middleware.js
│   │   └── verification.middleware.js
│   ├── models/
│   │   └── User.js
│   ├── repositories/
│   │   ├── User.repository.js
│   │   └── index.js
│   ├── routes/
│   │   ├── auth.route.js
│   │   ├── health.route.js
│   │   └── user.route.js
│   ├── service/
│   │   └── auth.service.js
│   └── utils/
│       ├── handlers.js
│       └── helpers/
│           ├── common.helper.js
│           ├── generateAvatar.js
│           ├── logs.helper.js
│           ├── mail.helper.js
│           ├── middlewares.helper.js
│           ├── validators.helper.js
│           └── variables.helper.js
```



## How to Use

1. **Clone the repo**
2. **Install dependencies**
3. **Add your .env file**
4. **Run the server**
5. **Start building your features!**

This API is ready to go for most authentication and user management needs. You can easily add new routes, models, or connect to your frontend.

---

## Getting Started

### Prerequisites
- Node.js (v16 or higher recommended)
- npm or yarn


### Installation
1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd <name>
   ```
2. Install dependencies:
   ```bash
   npm install
   # or
   yarn install
   ```
3. Create a `.env` file in the root directory and add the required environment variables (see below).


### Environment Variables
Create a `.env` file in the root directory with the following variables:
```
PORT=5001
MONGO_URI=mongodb+srv://username:password@cluster0.mongodb.net/database_name
ACCESS_TOKEN_PRIVATE_KEY=your_secret_key
ACCESS_TOKEN_EXPIRATION=7d
ACCESS_TOKEN_ALGORITHM=HS256
FEATURE_CUSTOM_LOGIN=true
FEATURE_CUSTOM_SIGNUP=true
FEATURE_GOOGLE_AUTH=true
FEATURE_GET_USER=true
FEATURE_FORGOT_PASSWORD=true
FEATURE_RESET_PASSWORD=true
DOMAIN=http://localhost:5001
FRONTEND_DOMAIN=http://localhost:3000
AWS_ACCESS_KEY_ID=EXAMPLE_AWS_ACCESS_KEY
AWS_SECRET_ACCESS_KEY=EXAMPLE_AWS_SECRET_KEY
AWS_REGION=us-east-1
SES_SENDER=example@yourdomain.com
GOOGLE_CLIENT_ID=your-google-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-google-client-secret
```

**Note:** Never commit your `.env` file to version control.


### Running the Server
```bash
npm start
```
The server will start on the port specified in your `.env` file (default: 5001).

## Running Tests
```bash
npm test
```

The test suite uses Node.js's built-in test runner and exercises the API without requiring a live MongoDB instance or external authentication/email services.



## API Endpoints (Main Examples)

### Auth
- `POST /api/auth/register` — Register a new user
- `POST /api/auth/login` — Login and receive a JWT
- `POST /api/auth/google/callback` — Google OAuth login callback
- `POST /api/auth/forgot-password` — Request password reset link
- `POST /api/auth/reset/:token` — Reset password using token

### Users
- `GET /api/user` — Get user profile (authenticated)

### Health
- `GET /api/auth/health` — Health check endpoint


## Contributing
Pull requests are welcome! For major changes, please open an issue first to discuss what you would like to change.

## License
[MIT](LICENSE)


