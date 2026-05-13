const pool = require("../db/db");

const JE_CONNECTION_TYPE = "Single tap";

const normalizeRoleName = (value) => String(value || "").trim().toUpperCase();

const getJEOfficer = async (userId) => {
  const result = await pool.query(
    `
      SELECT u.id, u.login_id, u.block_code, ut.type_name
      FROM user_master u
      INNER JOIN user_type_master ut ON ut.id = u.user_type_id
      WHERE u.id = $1
      LIMIT 1
    `,
    [String(userId)]
  );

  const officer = result.rows[0] || null;
  if (!officer) return null;

  if (normalizeRoleName(officer.type_name) !== "JE") {
    const error = new Error("Unauthorized: JE user type required");
    error.statusCode = 403;
    throw error;
  }

  if (!officer.block_code) {
    const error = new Error("JE user has no block assigned");
    error.statusCode = 403;
    throw error;
  }

  return officer;
};

const getJEBlock = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    const officer = await getJEOfficer(userId);
    if (!officer) return res.status(404).json({ error: "User not found" });

    const result = await pool.query(
      `
        SELECT block_code, block_name, district_code, division_code
        FROM dbrap_lgd_block
        WHERE block_code::text = $1::text
        LIMIT 1
      `,
      [officer.block_code]
    );

    return res.status(200).json(result.rows[0] ? [result.rows[0]] : []);
  } catch (error) {
    console.error("getJEBlock error:", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Server Error" });
  }
};

const getJEApplications = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const blockCode = String(req.query.block_code || "").trim();
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    const officer = await getJEOfficer(userId);
    if (!officer) return res.status(404).json({ error: "User not found" });

    const effectiveBlockCode = blockCode || officer.block_code;
    if (String(effectiveBlockCode) !== String(officer.block_code)) {
      return res.status(403).json({ error: "JE can only access assigned block" });
    }

    const result = await pool.query(
      `
        SELECT application_id, type_of_connection, organisation_name, block, block_code
        FROM organisation
        WHERE block_code::text = $1::text
          AND LOWER(TRIM(type_of_connection)) = LOWER($2)
        ORDER BY application_id ASC
      `,
      [officer.block_code, JE_CONNECTION_TYPE]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getJEApplications error:", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Server Error" });
  }
};

const getJEPaymentDetails = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    const applicationId = String(req.query.application_id || "").trim();
    if (!userId) return res.status(400).json({ error: "User ID is required" });

    const officer = await getJEOfficer(userId);
    if (!officer) return res.status(404).json({ error: "User not found" });

    const filters = [
      "p.block_code::text = $1::text",
      "LOWER(TRIM(p.connection_type)) = LOWER($2)",
    ];
    const params = [officer.block_code, JE_CONNECTION_TYPE];
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
        LEFT JOIN dbrap_lgd_block b ON b.block_code::text = p.block_code::text
        WHERE ${filters.join(" AND ")}
        ORDER BY p.created_at DESC, p.id DESC
      `,
      params
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getJEPaymentDetails error:", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Server Error" });
  }
};

const createJEPaymentDetail = async (req, res) => {
  try {
    const userId = String(req.body.userId || "").trim();
    const blockCode = String(req.body.block_code || "").trim();
    const applicationId = String(req.body.application_id || "").trim();
    const amount = Number(req.body.amount);
    const dateOfPayment = String(req.body.date_of_payment || "").trim();

    if (!userId || !applicationId || !dateOfPayment || !Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Application ID, amount, and date of payment are required" });
    }

    const officer = await getJEOfficer(userId);
    if (!officer) return res.status(404).json({ error: "User not found" });

    const effectiveBlockCode = blockCode || officer.block_code;
    if (String(effectiveBlockCode) !== String(officer.block_code)) {
      return res.status(403).json({ error: "JE can only submit payment for assigned block" });
    }

    const appResult = await pool.query(
      `
        SELECT application_id, type_of_connection, block_code
        FROM organisation
        WHERE block_code::text = $1::text
          AND application_id::text = $2::text
          AND LOWER(TRIM(type_of_connection)) = LOWER($3)
        LIMIT 1
      `,
      [officer.block_code, applicationId, JE_CONNECTION_TYPE]
    );

    if (appResult.rows.length === 0) {
      return res.status(400).json({ error: "Invalid application for assigned block or connection type" });
    }

    const insertResult = await pool.query(
      `
        INSERT INTO dbrap_payment_details (
          user_id, block_code, application_id, connection_type, amount, date_of_payment, payment_status
        )
        VALUES ($1, $2, $3, $4, $5, $6, 'PAID')
        RETURNING *
      `,
      [officer.login_id, officer.block_code, applicationId, appResult.rows[0].type_of_connection, amount, dateOfPayment]
    );

    return res.status(201).json({ message: "Payment details saved successfully", data: insertResult.rows[0] });
  } catch (error) {
    console.error("createJEPaymentDetail error:", error);
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : "Server Error" });
  }
};

module.exports = {
  getJEBlock,
  getJEApplications,
  getJEPaymentDetails,
  createJEPaymentDetail,
};
