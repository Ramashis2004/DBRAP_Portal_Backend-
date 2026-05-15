// controllers/applicantPaymentController.js
const pool = require("../db/db");
const path = require("path");
const fs = require("fs");
const { saveApplicationHistory } = require("./historyController");
const { APPLICATION_STATUS } = require("../constraints/application_status_enum");
const { handleSlaOnStatusChange } = require("./slaTrackingController");
// ── helpers ──────────────────────────────────────────────────────────────────

const getApplicantApplication = async (applicantUserId) => {
  const result = await pool.query(
    `SELECT
       application_id,
       organisation_name,
       type_of_connection,
       block,
       block_code,
       district,
       village,
       gram_panchayat,
       habitation,
       name,
       mobile_number,
       water_requirement,
       application_status,
       amount,
       date_of_payment,
       money_receipt,
       money_receipt_upload_on
     FROM organisation
     WHERE applicant_user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [String(applicantUserId)]
  );
  return result.rows[0] || null;
};

// ── GET /api/applicant-payment/details ───────────────────────────────────────
// Returns the application + payment info for the logged-in applicant
const getApplicantPaymentDetails = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();

    if (!userId) {
      return res.status(400).json({ error: "userId is required." });
    }

    const app = await getApplicantApplication(userId);

    if (!app) {
      return res.status(404).json({ error: "No application found for this applicant." });
    }

    return res.json({ data: app });
  } catch (err) {
    console.error("getApplicantPaymentDetails error:", err);
    return res.status(500).json({ error: "Failed to fetch payment details.", detail: err.message });
  }
};

// ── POST /api/applicant-payment/upload ───────────────────────────────────────
// Saves amount, date_of_payment, money_receipt (file path),
// sets application_status = 'PAYMENT_RECEIPT_UPLOADED',
// sets money_receipt_upload_on = NOW()
const uploadApplicantPaymentReceipt = async (req, res) => {
  try {
    const userId      = String(req.body.userId      || "").trim();
    const applicationId = String(req.body.applicationId || "").trim();
    const amount      = Number(req.body.amount);
    const dateOfPayment = String(req.body.dateOfPayment || "").trim();

    // ── Validation ────────────────────────────────────────────────────────────
    if (!userId || !applicationId || !dateOfPayment || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: "userId, applicationId, amount and dateOfPayment are required.",
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Money receipt file is required." });
    }

    // ── Verify the application belongs to this applicant ─────────────────────
    const checkResult = await pool.query(
      `SELECT application_id, application_status::TEXT
       FROM organisation
       WHERE application_id     = $1
         AND applicant_user_id  = $2
       LIMIT 1`,
      [applicationId, userId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: "Application not found for this applicant." });
    }

    // Store relative path so it can be served later
    const receiptPath = req.file.path;

    // ── Update organisation table ─────────────────────────────────────────────
    await pool.query(
      `UPDATE organisation
       SET
         amount                  = $1,
         date_of_payment         = $2,
         money_receipt           = $3,
         application_status      = 'PAYMENT_RECEIPT_UPLOADED',
         update_on = NOW()
       WHERE application_id    = $4
         AND applicant_user_id = $5`,
      [amount, dateOfPayment, receiptPath, applicationId, userId]
    );

// inside uploadApplicantPaymentReceipt, after the UPDATE query:
await saveApplicationHistory(
  applicationId,
  userId,                                        // applicant uploading receipt
  null,
  APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED,
  checkResult.rows[0].application_status,        // old status
  APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED,
  null
);

    await handleSlaOnStatusChange({
      applicationId,
      newStatus: APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED,
      actorUserId: userId,
      assignedTo: null,
    });
    return res.json({
      message: "Payment receipt uploaded successfully.",
      applicationId,
      receiptPath,
    });
  } catch (err) {
    console.error("uploadApplicantPaymentReceipt error:", err);
    return res.status(500).json({ error: "Failed to upload payment receipt.", detail: err.message });
  }
};

// ── GET /api/applicant-payment/receipt/:applicationId ───────────────────────
// Serves the uploaded receipt file
const getMoneyReceiptFile = async (req, res) => {
  try {
    const { applicationId } = req.params;

    const result = await pool.query(
      `SELECT money_receipt FROM organisation WHERE application_id = $1 LIMIT 1`,
      [applicationId]
    );

    if (!result.rows[0]?.money_receipt) {
      return res.status(404).json({ error: "Receipt not found." });
    }

    const filePath = path.resolve(result.rows[0].money_receipt);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: "Receipt file not found on server." });
    }

    return res.sendFile(filePath);
  } catch (err) {
    console.error("getMoneyReceiptFile error:", err);
    return res.status(500).json({ error: "Failed to fetch receipt." });
  }
};

module.exports = {
  getApplicantPaymentDetails,
  uploadApplicantPaymentReceipt,
  getMoneyReceiptFile,
};
