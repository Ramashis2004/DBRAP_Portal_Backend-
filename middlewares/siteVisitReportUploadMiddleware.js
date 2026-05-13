const multer = require("multer");
const path = require("path");
const fs = require("fs");

const basePath = process.env.SITE_VISIT_REPORT_PATH || "D:\\DBRAP Document\\Site Visit Report";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath, { recursive: true });
    }

    cb(null, basePath);
  },
  filename: (req, file, cb) => {
    const safeOriginalName = String(file.originalname || "site-visit-report")
      .replace(/[<>:"/\\|?*]+/g, "_")
      .replace(/\s+/g, "_");

    cb(null, `${Date.now()}-${safeOriginalName}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedExtensions = [".pdf", ".doc", ".docx"];
  const ext = path.extname(file.originalname).toLowerCase();

  if (allowedExtensions.includes(ext)) {
    cb(null, true);
    return;
  }

  cb(new Error("Only .pdf, .doc, and .docx files are allowed!"), false);
};

const uploadSiteVisitReport = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 },
});

module.exports = uploadSiteVisitReport;
