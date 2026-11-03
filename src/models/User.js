const mongoose = require("mongoose");

const userSchema = new mongoose.Schema({
    name: String,
    username: String,
    email: { type: String, unique: true },
    password: String,
    googleId: {
        type: String,
        default: undefined
    },
    profilePicture: String,
    emailVerified: { type: Boolean, default: false },
    avatar: {
        profilePicBg: String,
        profileLetter: String
    },
    resetPasswordToken: String,
    resetPasswordExpire: Date,
    subStatus: String
}, { timestamps: true });

module.exports = mongoose.model("User", userSchema);