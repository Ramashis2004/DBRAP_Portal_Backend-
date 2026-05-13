// routes/applicantPaymentRoutes.js
// Mount in server.js:  app.use("/api/applicant-payment", applicantPaymentRoutes);

const express  = require("express");
const multer   = require("multer");
const path     = require("path");
const fs       = require("fs");
const router   = express.Router();

const {
  getApplicantPaymentDetails,
  uploadApplicantPaymentReceipt,
  getMoneyReceiptFile,
} = require("../controllers/applicantPaymentController");

// ── Multer setup ─────────────────────────────────────────────────────────────
const uploadDir = path.join(process.env.UPLOAD_PATH || "uploads", "Money Receipts");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = `receipt_${Date.now()}${ext}`;
    cb(null, name);
  },
});

const fileFilter = (_req, file, cb) => {
  const allowed = [".pdf", ".jpg", ".jpeg", ".png"];
  const ext     = path.extname(file.originalname).toLowerCase();
  if (allowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Only PDF, JPG, and PNG files are allowed."));
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
});

// ── Routes ───────────────────────────────────────────────────────────────────

// GET  /api/applicant-payment/details?userId=XXX
router.get("/details", getApplicantPaymentDetails);

// POST /api/applicant-payment/upload   (multipart/form-data)
router.post("/upload", upload.single("money_receipt"), uploadApplicantPaymentReceipt);

// GET  /api/applicant-payment/receipt/:applicationId
router.get("/receipt/:applicationId", getMoneyReceiptFile);

module.exports = router;
