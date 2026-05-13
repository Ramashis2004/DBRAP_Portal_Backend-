const pool = require("../db/db");

const MORE_THAN_ONE_TAP = "More than one tap";

const normalizeRoleName = (value) => String(value || "").trim().toUpperCase();

const getSEOfficer = async (userId) => {
  const result = await pool.query(
    `
      SELECT u.id, u.login_id, u.division_code, ut.type_name
      FROM user_master u
      INNER JOIN user_type_master ut ON ut.id = u.user_type_id
      WHERE u.id = $1
      LIMIT 1
    `,
    [String(userId)]
  );

  const officer = result.rows[0] || null;
  if (!officer) return null;

  if (normalizeRoleName(officer.type_name) !== "SE") {
    const error = new Error("Unauthorized: SE user type required");
    error.statusCode = 403;
    throw error;
  }

  if (!officer.division_code) {
    const error = new Error("SE user has no division assigned");
    error.statusCode = 403;
    throw error;
  }

  return officer;
};

const getSEBlocks = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    const officer = await getSEOfficer(userId);
    if (!officer) return res.status(404).json({ error: "User not found" });

    const result = await pool.query(
      `
        SELECT block_code, block_name, district_code, division_code
        FROM dbrap_lgd_block
        WHERE division_code::text = $1::text
          AND COALESCE(active_status, true) = true
        ORDER BY block_name ASC
      `,
      [officer.division_code]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getSEBlocks error:", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Server Error" });
  }
};

const getSEApplications = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const blockCode = String(req.query.block_code || "").trim();
    if (!userId) return res.status(400).json({ error: "User ID is required" });
    if (!blockCode) return res.status(400).json({ error: "Block is required" });

    const officer = await getSEOfficer(userId);
    if (!officer) return res.status(404).json({ error: "User not found" });

    const result = await pool.query(
      `
        SELECT o.application_id, o.type_of_connection, o.organisation_name, o.block, o.block_code
        FROM organisation o
        INNER JOIN dbrap_lgd_block b ON b.block_code::text = o.block_code::text
        WHERE b.division_code::text = $1::text
          AND o.block_code::text = $2::text
          AND LOWER(TRIM(o.type_of_connection)) = LOWER($3)
        ORDER BY o.application_id ASC
      `,
      [officer.division_code, blockCode, MORE_THAN_ONE_TAP]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getSEApplications error:", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Server Error" });
  }
};

const getSEPaymentDetails = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const blockCode = String(req.query.block_code || "").trim();
    const applicationId = String(req.query.application_id || "").trim();
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    const officer = await getSEOfficer(userId);
    if (!officer) return res.status(404).json({ error: "User not found" });

    // const params = [officer.division_code];
    // const filters = ["b.division_code::text = $1::text"];
const params = [officer.division_code, MORE_THAN_ONE_TAP];
const filters = [
  "b.division_code::text = $1::text",
  "LOWER(TRIM(p.connection_type)) = LOWER($2)", // ← added
];
    if (blockCode) {
      params.push(blockCode);
      filters.push(`p.block_code::text = $${params.length}::text`);
    }

    if (applicationId) {
      params.push(applicationId);
      filters.push(`p.application_id::text = $${params.length}::text`);
    }

    const result = await pool.query(
      `
        SELECT
          p.id,
          p.user_id,
          p.block_code,
          COALESCE(b.block_name, p.block_code) AS block_name,
          p.application_id,
          p.connection_type,
          p.amount,
          p.date_of_payment,
          p.payment_status,
          p.created_at
        FROM dbrap_payment_details p
        INNER JOIN dbrap_lgd_block b ON b.block_code::text = p.block_code::text
        WHERE ${filters.join(" AND ")}
        ORDER BY p.created_at DESC, p.id DESC
      `,
      params
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getSEPaymentDetails error:", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Server Error" });
  }
};

const createSEPaymentDetail = async (req, res) => {
  try {
    const userId = String(req.body.userId || "").trim();
    const blockCode = String(req.body.block_code || "").trim();
    const applicationId = String(req.body.application_id || "").trim();
    const amount = Number(req.body.amount);
    const dateOfPayment = String(req.body.date_of_payment || "").trim();

    if (!userId || !blockCode || !applicationId || !dateOfPayment || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Block, application ID, amount, and date of payment are required" });
    }

    const officer = await getSEOfficer(userId);
    if (!officer) return res.status(404).json({ error: "User not found" });

    const appResult = await pool.query(
      `
        SELECT o.application_id, o.type_of_connection, o.block_code
        FROM organisation o
        INNER JOIN dbrap_lgd_block b ON b.block_code::text = o.block_code::text
        WHERE b.division_code::text = $1::text
          AND o.block_code::text = $2::text
          AND o.application_id::text = $3::text
          AND LOWER(TRIM(o.type_of_connection)) = LOWER($4)
        LIMIT 1
      `,
      [officer.division_code, blockCode, applicationId, MORE_THAN_ONE_TAP]
    );

    if (appResult.rows.length === 0) {
      return res.status(400).json({ error: "Invalid application for selected block or connection type" });
    }

    const insertResult = await pool.query(
      `
        INSERT INTO dbrap_payment_details (
          user_id, block_code, application_id, connection_type, amount, date_of_payment, payment_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'PAID')
        RETURNING *
      `,
      [officer.login_id, blockCode, applicationId, appResult.rows[0].type_of_connection, amount, dateOfPayment]
    );

    return res.status(201).json({ message: "Payment details saved successfully", data: insertResult.rows[0] });
  } catch (error) {
    console.error("createSEPaymentDetail error:", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Server Error" });
  }
};

module.exports = {
  getSEBlocks,
  getSEApplications,
  getSEPaymentDetails,
  createSEPaymentDetail,
};
