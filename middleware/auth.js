// middleware/auth.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    console.log(`[Auth] ${req.method} ${req.path} - Authorization: ${authHeader ? "present" : "missing"}`);

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "No token provided" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findOne({ _id: decoded.userId, isActive: true });
    if (!user) {
      return res.status(401).json({ success: false, message: "User not found or inactive" });
    }

    req.user = user;
    console.log(`[Auth] Authenticated: ${user.email}`);
    next();
  } catch (err) {
    console.error(`[Auth] Error: ${err.message}`);
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ success: false, message: "Invalid token" });
    }
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ success: false, message: "Token expired" });
    }
    return res.status(500).json({ success: false, message: "Auth error" });
  }
}

module.exports = authMiddleware;
