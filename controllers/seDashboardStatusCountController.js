
const pool = require("../db/db");

const getSEOfficer = async (userId) => {
  const result = await pool.query(
    `SELECT id, login_id, user_type_id, division_code
     FROM user_master
     WHERE id = $1
     LIMIT 1`,
    [userId]
  );

  const officer = result.rows[0] || null;
  if (!officer) return null;
  if (Number(officer.user_type_id) !== 2) return { unauthorized: true };
  if (!officer.division_code) return { missingDivision: true };
  return officer;
};

// ─── Status metadata (labels shown in the frontend cards) ────────────────────
// Order here controls the display order on the dashboard.
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

const getSEStatusCounts = async (req, res) => {
  try {
    const userId = String(req.query.userId || "").trim();
    if (!userId) {
      return res.status(400).json({ error: "userId query parameter is required." });
    }

    // ── Validate officer ──────────────────────────────────────────────────────
    const officer = await getSEOfficer(userId);
    if (!officer)               return res.status(404).json({ error: "User not found." });
    if (officer.unauthorized)   return res.status(403).json({ error: "Unauthorized: user is not an SE officer." });
    if (officer.missingDivision) return res.status(400).json({ error: "SE officer has no division assigned." });

    // ── Single query: count per application_status ────────────────────────────
    // Scope: applications whose block is mapped to the officer's division
    const result = await pool.query(
      `SELECT o.application_status, COUNT(DISTINCT o.application_id)::int AS cnt
       FROM organisation o
       INNER JOIN dbrap_lgd_block lb
         ON lb.block_code::text = o.block_code::text
       WHERE COALESCE(lb.division_code::text, '') = COALESCE($1::text, '')
       GROUP BY o.application_status`,
      [officer.division_code]
    );

    // Build a fast lookup: status → count
    const countMap = {};
    let totalApplications = 0;
    for (const row of result.rows) {
      const key = String(row.application_status || "").trim().toUpperCase();
      const cnt = Number(row.cnt || 0);
      countMap[key] = cnt;
      totalApplications += cnt;
    }

    // Merge with STATUS_META to produce an ordered array
    const statusCounts = STATUS_META.map((meta) => ({
      status:   meta.status,
      label:    meta.label,
      colorKey: meta.colorKey,
      count:    countMap[meta.status] || 0,
    }));

    return res.status(200).json({
      divisionCode:      officer.division_code,
      totalApplications,
      statusCounts,
    });
  } catch (error) {
    console.error("getSEStatusCounts error:", error);
    return res.status(500).json({ error: "Internal server error." });
  }
};

module.exports = { getSEStatusCounts };
