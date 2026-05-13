const multer = require("multer");
const path = require("path");
const fs = require("fs");

// Helper to map fieldname to folder name
const getSubfolder = (fieldname) => {
  const mapping = {
    property_proof: "Property Proof",
    registration_proof: "Registration Proof",
    ownership_proof: "Ownership Proof",
    owner_indemnity_bond: "Owner Indemnity Bond",
    identity_proof: "Identity Proof"
  };
  return mapping[fieldname] || "Others";
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const basePath = process.env.UPLOAD_PATH || "uploads";
    const subfolder = getSubfolder(file.fieldname);
    const destPath = path.join(basePath, subfolder);

    // Create folder if it doesn't exist
    if (!fs.existsSync(destPath)) {
      fs.mkdirSync(destPath, { recursive: true });
    }

    cb(null, destPath);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.fieldname}${path.extname(file.originalname)}`);
  },
});

const fileFilter = (req, file, cb) => {
  const allowedExtensions = [".pdf", ".docx"];
  const ext = path.extname(file.originalname).toLowerCase();
  if (allowedExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error("Only .pdf and .docx files are allowed!"), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
});

module.exports = upload;

