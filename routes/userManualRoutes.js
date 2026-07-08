// routes/userManual.js
const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const jwt     = require("jsonwebtoken");
const path    = require("path");

// ── Base path from env ────────────────────────────────────────────────────────
const BASE_PATH = process.env.USER_MANUAL_PATH;
if (!BASE_PATH) throw new Error("Missing env variable: USER_MANUAL_PATH");

const findManualByRole = (role) => {
  
  if (!fs.existsSync(BASE_PATH)) return null;
  
  const files = fs.readdirSync(BASE_PATH);
  
  const match = files.find(
    (f) => f.toLowerCase().endsWith(".pdf") && f.toLowerCase().includes(role)
  );
  return match ? path.join(BASE_PATH, match) : null;
};

// ── Auth middleware ───────────────────────────────────────────────────────────
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

// ── Role authorization middleware ─────────────────────────────────────────────
const authorizeRole = (req, res, next) => {
  if (!req.user?.roleId) {
    return res.status(403).json({ error: "Access denied. No role assigned." });
  }
  req.manualType = "officer";
  next();
};

// ── Reusable PDF sender ───────────────────────────────────────────────────────
const sendPdf = (res, filePath, disposition) => {
  if (!filePath) {
    return res.status(404).json({ error: "User manual not found." });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${disposition}; filename="${path.basename(filePath)}"`);
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(filePath).pipe(res);
};

// ── Officer routes (authenticated + role check) ───────────────────────────────
router.get("/view",     authenticate, authorizeRole, (req, res) =>
  sendPdf(res, findManualByRole(req.manualType), "inline"));

router.get("/download", authenticate, authorizeRole, (req, res) =>
  sendPdf(res, findManualByRole(req.manualType), "attachment"));
// ── Applicant routes (public — no auth required) ──────────────────────────────
router.get("/public/view",     (req, res) => sendPdf(res, findManualByRole("applicant"), "inline"));
router.get("/public/download", (req, res) => sendPdf(res, findManualByRole("applicant"), "attachment"));

module.exports = router;