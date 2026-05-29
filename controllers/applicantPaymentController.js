// controllers/applicantPaymentController.js
const pool = require("../db/db");
const path = require("path");
const fs   = require("fs");
const { saveApplicationHistory }   = require("./historyController");
const { APPLICATION_STATUS }       = require("../constraints/application_status_enum");
const { handleSlaOnStatusChange }  = require("./slaTrackingController");

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
       money_receipt_upload_on,
       payment_rejection_count,
       remarks
     FROM organisation
     WHERE applicant_user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [String(applicantUserId)]
  );
  return result.rows[0] || null;
};

// ── GET /api/applicant-payment/details ───────────────────────────────────────
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
const uploadApplicantPaymentReceipt = async (req, res) => {
  try {
    const userId        = String(req.body.userId        || "").trim();
    const applicationId = String(req.body.applicationId || "").trim();
    const amount        = Number(req.body.amount);
    const dateOfPayment = String(req.body.dateOfPayment || "").trim();

    if (!userId || !applicationId || !dateOfPayment || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        error: "userId, applicationId, amount and dateOfPayment are required.",
      });
    }

    if (!req.file) {
      return res.status(400).json({ error: "Money receipt file is required." });
    }

    // ── Verify ownership and check allowed statuses ────────────────────────
    const checkResult = await pool.query(
      `SELECT application_id, application_status::TEXT, payment_rejection_count
       FROM organisation
       WHERE application_id    = $1
         AND applicant_user_id = $2
       LIMIT 1`,
      [applicationId, userId]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: "Application not found for this applicant." });
    }

    const currentStatus   = checkResult.rows[0].application_status;
    const rejectionCount  = Number(checkResult.rows[0].payment_rejection_count) || 0;

    // Only allow upload when:
    //   • First time → APPLICATION_APPROVED
    //   • Re-upload  → PAYMENT_RECEIPT_REJECTED (first rejection only, count === 1)
    const allowedUploadStatuses = [
      APPLICATION_STATUS.APPLICATION_APPROVED,
      APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED,
    ];

    if (!allowedUploadStatuses.includes(currentStatus)) {
      return res.status(400).json({
        error: `Upload not allowed for current application status: ${currentStatus}`,
      });
    }

    // Guard: if rejected twice the status is APPLICATION_REJECTED, blocked above.
    // Extra safety check in case of data inconsistency.
    if (
      currentStatus === APPLICATION_STATUS.PAYMENT_RECEIPT_REJECTED &&
      rejectionCount >= 2
    ) {
      return res.status(400).json({
        error: "Application has been permanently rejected. Re-upload is not allowed.",
      });
    }

    const receiptPath = req.file.path;

    // ── Update organisation ────────────────────────────────────────────────
    await pool.query(
      `UPDATE organisation
       SET
         amount                  = $1,
         date_of_payment         = $2,
         money_receipt           = $3,
         application_status      = $6,
         money_receipt_upload_on = NOW(),
         money_receipt_verify_on = NULL,
         update_on               = NOW()
       WHERE application_id    = $4
         AND applicant_user_id = $5`,
      [
        amount,
        dateOfPayment,
        receiptPath,
        applicationId,
        userId,
        APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED,
      ]
    );

    // ── History ───────────────────────────────────────────────────────────
    await saveApplicationHistory(
      applicationId,
      userId,
      null,
      APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED,
      currentStatus,
      APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED,
      rejectionCount >= 1 ? "Re-uploaded after JE rejection" : null
    );

    await handleSlaOnStatusChange({
      applicationId,
      newStatus:   APPLICATION_STATUS.PAYMENT_RECEIPT_UPLOADED,
      actorUserId: userId,
      assignedTo:  null,
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

// ── GET /api/applicant-payment/receipt/:applicationId ────────────────────────
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