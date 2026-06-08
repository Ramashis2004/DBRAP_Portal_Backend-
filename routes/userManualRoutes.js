// routes/userManual.js
const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const jwt     = require("jsonwebtoken");
const path    = require("path");

const envPath = process.env.USER_MANUAL_PATH || "D:\\DBRAP Document\\User Manual";

// Resolve officer user manual path
const MANUAL_PATH = envPath.toLowerCase().endsWith(".pdf")
  ? envPath
  : path.join(envPath, "officer-user-manual.pdf");

// Resolve applicant user manual path
let APPLICANT_MANUAL_PATH;
if (process.env.APPLICANT_USER_MANUAL_PATH) {
  APPLICANT_MANUAL_PATH = process.env.APPLICANT_USER_MANUAL_PATH.toLowerCase().endsWith(".pdf")
    ? process.env.APPLICANT_USER_MANUAL_PATH
    : path.join(process.env.APPLICANT_USER_MANUAL_PATH, "applicant-user-manual.pdf");
} else {
  const baseDir = envPath.toLowerCase().endsWith(".pdf") ? path.dirname(envPath) : envPath;
  APPLICANT_MANUAL_PATH = path.join(baseDir, "applicant-user-manual.pdf");
}

// ── Auth middleware (token from header OR query param for iframe) ──────────────
const authenticate = (req, res, next) => {
  const token =
    req.query.token ||
    (req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.split(" ")[1]
      : null);

  if (!token) return res.status(401).json({ error: "Access denied. No token provided." });

  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token." });
  }
};

// ── Authenticated routes (dashboard officers) ─────────────────────────────────

// GET /api/user-manual/view
router.get("/view", authenticate, (req, res) => {
  if (!fs.existsSync(MANUAL_PATH)) {
    return res.status(404).json({ error: "User manual not found." });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=user-manual.pdf");
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(MANUAL_PATH).pipe(res);
});

// GET /api/user-manual/download
router.get("/download", authenticate, (req, res) => {
  if (!fs.existsSync(MANUAL_PATH)) {
    return res.status(404).json({ error: "User manual not found." });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=DBRAP_Officer_User_Manual.pdf");
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(MANUAL_PATH).pipe(res);
});

// ── Public routes (landing page — no auth required) ───────────────────────────

// GET /api/user-manual/public/view
router.get("/public/view", (req, res) => {
  if (!fs.existsSync(APPLICANT_MANUAL_PATH)) {
    return res.status(404).json({ error: "User manual not found." });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=user-manual.pdf");
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(APPLICANT_MANUAL_PATH).pipe(res);
});

// GET /api/user-manual/public/download
router.get("/public/download", (req, res) => {
  if (!fs.existsSync(APPLICANT_MANUAL_PATH)) {
    return res.status(404).json({ error: "User manual not found." });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "attachment; filename=DBRAP_Applicant_User_Manual.pdf");
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(APPLICANT_MANUAL_PATH).pipe(res);
});

module.exports = router;
