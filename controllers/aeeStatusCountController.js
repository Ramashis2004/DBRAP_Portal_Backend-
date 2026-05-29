
const pool = require("../db/db");

const getAEEOfficer = async (userId) => {
  const result = await pool.query(
    `SELECT id, login_id, user_type_id, division_code
     FROM user_master
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );
  const officer = result.rows[0] || null;
  if (!officer)                return null;
  if (Number(officer.user_type_id) !== 7) return { unauthorized: true };
  if (!officer.division_code)  return { missingDivision: true };
  return officer;
};

// Same labels/colors as SE — shows all lifecycle statuses
const STATUS_META = [
  {
    status: "APPLICATION_SUBMITTED",
    label: "No. of Applications Pending for Forward to JE",
    colorKey: "blue",
  },
  {
    status: "APPLICATION_FORWARDED_TO_JE",
    label: "No. of Applications Pending for Site Inspection and Report Upload",
    colorKey: "amber",
  },
  {
    status: "JE_VERIFIED_REPORT_UPLOADED",
    label: "No. of Applications Pending for Approval",
    colorKey: "purple",
  },
  {
    status: "APPLICATION_APPROVED",
    label: "No. of Applications Pending for Money Receipt Upload",
    colorKey: "green",
  },
  
  {
    status: "PAYMENT_RECEIPT_UPLOADED",
    label: "No. of Applications Pending for Payment Verification",
    colorKey: "orange",
  },
  {
    status: "PAYMENT_RECEIPT_VERIFIED",
    label: "No. of Applications Pending for Connection Details Updated",
    colorKey: "teal",
  },
  
];

/**
 * GET /api/aee-dashboard-applications/status-counts?userId=<id>
 *
 * Response:
 * {
 *   divisionCode: "DIV001",
 *   totalApplications: 38,
 *   statusCounts: [{ status, label, colorKey, count }, ...]
 * }
 */
const getAEEStatusCounts = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId)
      return res.status(400).json({ error: "userId query parameter is required." });

    const officer = await getAEEOfficer(userId);
    if (!officer)                return res.status(404).json({ error: "User not found." });
    if (officer.unauthorized)    return res.status(403).json({ error: "Unauthorized: user is not an AEE officer." });
    if (officer.missingDivision) return res.status(400).json({ error: "AEE officer has no division assigned." });

    // Count per status, scoped to the officer's division
    const result = await pool.query(
      `SELECT o.application_status, COUNT(DISTINCT o.application_id)::int AS cnt
       FROM organisation o
       INNER JOIN dbrap_lgd_block lb
         ON lb.block_code::text = o.block_code::text
       WHERE COALESCE(lb.division_code::text, '') = COALESCE($1::text, '')
       GROUP BY o.application_status`,
      [officer.division_code]
    );

    const countMap = {};
    let totalApplications = 0;
    for (const row of result.rows) {
      const key = String(row.application_status || "").trim().toUpperCase();
      const cnt = Number(row.cnt || 0);
      countMap[key] = cnt;
      totalApplications += cnt;
    }

    const statusCounts = STATUS_META.map((meta) => ({
      status:   meta.status,
      label:    meta.label,
      colorKey: meta.colorKey,
      count:    countMap[meta.status] || 0,
    }));

    return res.status(200).json({
      divisionCode: officer.division_code,
      totalApplications,
      statusCounts,
    });
  } catch (error) {
    console.error("getAEEStatusCounts error:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

module.exports = { getAEEStatusCounts };