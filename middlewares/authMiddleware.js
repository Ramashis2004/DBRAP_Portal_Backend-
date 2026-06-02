const jwt = require("jsonwebtoken");
const pool = require("../db/db");

const PUBLIC_ROUTES = [
  { path: /^\/api\/auth\/login$/, methods: ["POST"] },
  { path: /^\/api\/auth\/applicant\/check-mobile$/, methods: ["GET", "POST"] },
  { path: /^\/api\/auth\/applicant\/register$/, methods: ["POST"] },
  { path: /^\/api\/applicant-auth\/check-mobile$/, methods: ["GET", "POST"] },
  { path: /^\/api\/applicant-auth\/login$/, methods: ["POST"] },
  { path: /^\/api\/applicant-auth\/login-password$/, methods: ["POST"] },
    { path: /^\/api\/applicant-auth\/send-otp$/, methods: ["POST"] }, // ← ADD THIS
  { path: /^\/api\/location\/.*$/, methods: ["GET"] },
  { path: /^\/api\/public-dashboard\/.*$/, methods: ["GET"] },
  { path: /^\/api\/officer\/forgot-password\/.*$/, methods: ["POST"] },
  { path: /^\/api\/officer\/test$/, methods: ["GET"] },
];

const authMiddleware = async (req, res, next) => {
  const { originalUrl, method } = req;

  // Bypass authentication for all non-API routes (static assets, client-side routing, etc.)
  if (!originalUrl.startsWith("/api")) {
    return next();
  }

  // Always allow OPTIONS requests for CORS preflight
  if (method === "OPTIONS") {
    return next();
  }

  // Clean URL to handle query parameters (e.g. /api/location/blocks/21?foo=bar -> /api/location/blocks/21)
  const cleanPath = originalUrl.split("?")[0];

  // Check if current path matches any pattern in the public whitelist
  const isPublic = PUBLIC_ROUTES.some(route => {
    return route.path.test(cleanPath) && route.methods.includes(method);
  });

  if (isPublic) {
    return next();
  }

  // Validate JWT
  let token = null;
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else if (req.query && req.query.token) {
    token = req.query.token;
  }

  if (!token) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded; // Attach user info to request

    // Verify if this specific session is still active in the database
    if (decoded && decoded.sessionId) {
      const sessionCheck = await pool.query(
        `SELECT id, is_active, last_activity FROM login_history WHERE session_id = $1 LIMIT 1`,
        [decoded.sessionId]
      );

      if (sessionCheck.rows.length === 0) {
        return res.status(401).json({ error: "Session not found." });
      }

      const session = sessionCheck.rows[0];
      if (session.is_active !== true) {
        return res.status(401).json({ error: "Session has been terminated from another device or browser." });
      }

      // Attach login history ID to request object for logging
      req.loginHistoryId = session.id;

      // Check for inactivity timeout
      if (session.last_activity) {
        const lastActivity = new Date(session.last_activity);
        const now = new Date();
        const inactivityMinutes = (now - lastActivity) / (1000 * 60);
        const timeoutMinutes = Number(process.env.SESSION_TIMEOUT_MINUTES || 60);

        if (inactivityMinutes > timeoutMinutes) {
          // Deactivate the session in the database due to inactivity
          await pool.query(
            `UPDATE login_history SET is_active = false, logout_time = NOW() WHERE session_id = $1`,
            [decoded.sessionId]
          );
          // Also set is_logged = false for the user
          await pool.query(
            `UPDATE user_master SET is_logged = false WHERE id = $1`,
            [decoded.id]
          );
          return res.status(401).json({ error: "Session has expired due to inactivity. Please log in again." });
        }
      }

      // Async update of last activity timestamp in login history for active session
      // (excluding background check-session requests to allow inactivity timeout to function correctly)
      const isSessionCheck = cleanPath.endsWith("/check-session");
      if (!isSessionCheck) {
        pool.query(
          `UPDATE login_history SET last_activity = NOW() WHERE session_id = $1`,
          [decoded.sessionId]
        ).catch(err => console.error("Error updating last_activity time:", err));
      }
    }

    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
};

module.exports = authMiddleware;
