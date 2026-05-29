const jwt = require("jsonwebtoken");

const PUBLIC_ROUTES = [
  { path: /^\/api\/auth\/login$/, methods: ["POST"] },
  { path: /^\/api\/auth\/applicant\/check-mobile$/, methods: ["GET", "POST"] },
  { path: /^\/api\/auth\/applicant\/register$/, methods: ["POST"] },
  { path: /^\/api\/applicant-auth\/check-mobile$/, methods: ["GET", "POST"] },
  { path: /^\/api\/applicant-auth\/login$/, methods: ["POST"] },
  { path: /^\/api\/applicant-auth\/login-password$/, methods: ["POST"] },
  { path: /^\/api\/location\/.*$/, methods: ["GET"] },
  { path: /^\/api\/public-dashboard\/.*$/, methods: ["GET"] },
  { path: /^\/api\/officer\/forgot-password\/.*$/, methods: ["POST"] },
  { path: /^\/api\/officer\/test$/, methods: ["GET"] },
];

const authMiddleware = (req, res, next) => {
  const { originalUrl, method } = req;

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
  const authHeader = req.headers.authorization || req.headers.Authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Access denied. No token provided." });
  }

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "dbrap_portal_jwt_secret_key_2026");
    req.user = decoded; // Attach user info to request
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
};

module.exports = authMiddleware;
