const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");

const BASE_PATH = process.env.NOTIFICATION_PATH;
if (!BASE_PATH) throw new Error("Missing env variable: NOTIFICATION_PATH");

const NOTIFICATION_METADATA = {
  "compliance": {
    subject: "Compliance of reform requirements under District Business Reforms Action Plan (DBRAP) 2025-26 – Water Supply Connection service - reg.",
    date: "28/08/2026",
    fileNo: "File No. PR-DWS-MISC-0006-2026 / 24314/PR&DW"
  },
  "charter": {
    subject: "Citizen Charter for Rural Water Supply",
    date: "02/05/2026",
    fileNo: "PR-DWS-POLICY-0001-2025 / 11938/PR&DW"
  }
};

const getFileMetadata = (filename) => {
  const lower = filename.toLowerCase();
  for (const [key, meta] of Object.entries(NOTIFICATION_METADATA)) {
    if (lower.includes(key)) {
      return meta;
    }
  }
  return {
    subject: path.basename(filename, path.extname(filename)).replace(/[_-]/g, " "),
    date: "—",
    fileNo: ""
  };
};

const listNotificationFiles = () => {
  if (!fs.existsSync(BASE_PATH)) return [];
  return fs
    .readdirSync(BASE_PATH)
    .filter((f) => f.toLowerCase().endsWith(".pdf"))
    .sort((a, b) => a.localeCompare(b));
};

const findNotificationFile = (requestedFilename) => {
  const files = listNotificationFiles();
  const match = files.find((f) => f === requestedFilename);
  return match ? path.join(BASE_PATH, match) : null;
};

const sendPdf = (res, filePath, disposition) => {
  if (!filePath) {
    return res.status(404).json({ error: "Notification not found." });
  }
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `${disposition}; filename="${path.basename(filePath)}"`);
  res.setHeader("Cache-Control", "no-cache");
  fs.createReadStream(filePath).pipe(res);
};

router.get("/public/list", (req, res) => {
  const files = listNotificationFiles();
  return res.status(200).json({
    notifications: files.map((filename, index) => {
      const meta = getFileMetadata(filename);
      return {
        slNo: index + 1,
        filename,
        subject: meta.subject,
        date: meta.date,
        fileNo: meta.fileNo
      };
    }),
  });
});

router.get("/public/view/:filename", (req, res) => {
  const filePath = findNotificationFile(req.params.filename);
  return sendPdf(res, filePath, "inline");
});

router.get("/public/download/:filename", (req, res) => {
  const filePath = findNotificationFile(req.params.filename);
  return sendPdf(res, filePath, "attachment");
});

module.exports = router;