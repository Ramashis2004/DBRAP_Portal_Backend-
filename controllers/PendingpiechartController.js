const pool = require("../db/db");

// ── Auth helpers (mirrors ceDashboard.controller.js) ─────────────────────────

// Same change as above — add ACE_TYPE_ID acceptance:
const CE_TYPE_ID  = 6;
const ACE_TYPE_ID = 5;

const getCEOfficer = async (userId) => {
  const result = await pool.query(
    `SELECT id, login_id, user_type_id, circle_code
       FROM user_master WHERE id = $1 LIMIT 1`,
    [userId]
  );
  const officer = result.rows[0] || null;
  if (!officer) return null;
  const typeId = Number(officer.user_type_id);
  if (typeId !== CE_TYPE_ID && typeId !== ACE_TYPE_ID) return { unauthorized: true };
  const circleCodes = String(officer.circle_code || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!circleCodes.length) return { missingCircle: true };
  return { ...officer, circleCodes };
};
const ensureCEOfficer = async (req, res) => {
  const userId = String(req.query.userId || "").trim();
  if (!userId) { res.status(400).json({ error: "User ID is required" }); return null; }
  const officer = await getCEOfficer(userId);
  if (!officer)             { res.status(404).json({ error: "User not found" }); return null; }
  if (officer.unauthorized) { res.status(403).json({ error: "Unauthorized: CE user type required" }); return null; }
  if (officer.missingCircle){ res.status(400).json({ error: "CE user has no circle assigned" }); return null; }
  return officer;
};

// EIC: no circle restriction, just verify EIC type ───────────────────────────
const getEICOfficer = async (userId) => {
  const result = await pool.query(
    `SELECT u.id, u.login_id, u.user_type_id, ut.type_name
       FROM user_master u
       INNER JOIN user_type_master ut ON ut.id = u.user_type_id
      WHERE u.id = $1 LIMIT 1`,
    [userId]
  );
  const officer = result.rows[0] || null;
  if (!officer) return null;
  if (String(officer.type_name || "").trim().toUpperCase() !== "EIC") return { unauthorized: true };
  return officer;
};

// ── Pending statuses (not approved/rejected) ──────────────────────────────────

const PENDING_STATUSES = [
  "APPLICATION_SUBMITTED",
  "APPLICATION_FORWARDED_TO_JE",
  "JE_VERIFIED_REPORT_UPLOADED",
  "APPLICATION_APPROVED",
  "PAYMENT_RECEIPT_UPLOADED",
  "PAYMENT_RECEIPT_VERIFIED",
];

// ── Pending-with logic (mirrors CEApplicationReceivedPage.jsx) ────────────────

// Returns a SQL CASE expression for "pending_with" column
// using the same rules as getPendingWith() in the frontend
const PENDING_WITH_SQL = `
  CASE
    WHEN o.application_status = 'APPLICATION_SUBMITTED'
      OR o.application_status = 'JE_VERIFIED_REPORT_UPLOADED'
      THEN COALESCE(dv.division_name || ' : SE', 'SE')

    WHEN o.application_status = 'APPLICATION_FORWARDED_TO_JE'
      OR o.application_status = 'PAYMENT_RECEIPT_UPLOADED'
      OR o.application_status = 'PAYMENT_RECEIPT_VERIFIED'
      THEN COALESCE(o.block || ' : JE', 'JE')

    WHEN o.application_status = 'APPLICATION_APPROVED'
      THEN COALESCE(o.applicant_user_id::text || ' : Applicant', 'Applicant')

    ELSE NULL
  END AS pending_with
`;

// ── Age bucket: days since update_on (or created_at if null) until NOW ────────

const DAYS_PENDING_SQL = `
  EXTRACT(EPOCH FROM (NOW() - COALESCE(o.update_on, o.created_at))) / 86400.0
`;

const BUCKET_WHERE = {
  "0_2":     `${DAYS_PENDING_SQL} >= 0 AND ${DAYS_PENDING_SQL} <  2`,
  "2_5":     `${DAYS_PENDING_SQL} >= 2 AND ${DAYS_PENDING_SQL} <  5`,
  "5_10":    `${DAYS_PENDING_SQL} >= 5 AND ${DAYS_PENDING_SQL} < 10`,
  "10_plus": `${DAYS_PENDING_SQL} >= 10`,
};

// ─────────────────────────────────────────────────────────────────────────────
// CE: Summary  GET /api/ce-pending/summary?userId=…
// ─────────────────────────────────────────────────────────────────────────────
const getCEPendingSummary = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const result = await pool.query(
      `SELECT
          COUNT(DISTINCT CASE WHEN ${DAYS_PENDING_SQL} >= 0  AND ${DAYS_PENDING_SQL} <  2  THEN o.application_id END)::int AS bucket_0_2,
          COUNT(DISTINCT CASE WHEN ${DAYS_PENDING_SQL} >= 2  AND ${DAYS_PENDING_SQL} <  5  THEN o.application_id END)::int AS bucket_2_5,
          COUNT(DISTINCT CASE WHEN ${DAYS_PENDING_SQL} >= 5  AND ${DAYS_PENDING_SQL} < 10  THEN o.application_id END)::int AS bucket_5_10,
          COUNT(DISTINCT CASE WHEN ${DAYS_PENDING_SQL} >= 10                               THEN o.application_id END)::int AS bucket_10_plus
       FROM organisation o
       INNER JOIN dbrap_lgd_block    lb ON lb.block_code::text    = o.block_code::text
       INNER JOIN dbrap_division     dv ON dv.division_code::text = lb.division_code::text
       INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
       WHERE o.application_status = ANY($1::text[])
         AND dd.circle_code::text = ANY($2::text[])`,
      [PENDING_STATUSES, officer.circleCodes]
    );

    const row = result.rows[0] || {};
    return res.status(200).json({
      bucket_0_2:     Number(row.bucket_0_2     || 0),
      bucket_2_5:     Number(row.bucket_2_5     || 0),
      bucket_5_10:    Number(row.bucket_5_10    || 0),
      bucket_10_plus: Number(row.bucket_10_plus || 0),
    });
  } catch (err) {
    console.error("getCEPendingSummary error:", err);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CE: By Division  GET /api/ce-pending/by-division?userId=…&bucket=0_2|…
// ─────────────────────────────────────────────────────────────────────────────
const getCEPendingByDivision = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const bucket = String(req.query.bucket || "").trim();
    const bucketWhere = BUCKET_WHERE[bucket];
    if (!bucketWhere) return res.status(400).json({ error: "Invalid bucket. Use: 0_2 | 2_5 | 5_10 | 10_plus" });

    const result = await pool.query(
      `SELECT
          dv.division_code,
          dv.division_name,
          COUNT(DISTINCT o.application_id)::int              AS application_count,
          ROUND(AVG(${DAYS_PENDING_SQL})::numeric, 1)        AS avg_pending_days
       FROM organisation o
       INNER JOIN dbrap_lgd_block    lb ON lb.block_code::text    = o.block_code::text
       INNER JOIN dbrap_division     dv ON dv.division_code::text = lb.division_code::text
       INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
       WHERE o.application_status = ANY($1::text[])
         AND dd.circle_code::text = ANY($2::text[])
         AND (${bucketWhere})
       GROUP BY dv.division_code, dv.division_name
       ORDER BY application_count DESC, dv.division_name ASC`,
      [PENDING_STATUSES, officer.circleCodes]
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("getCEPendingByDivision error:", err);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CE: Applications by Division
// GET /api/ce-pending/applications-by-division?userId=…&bucket=…&divisionCode=…
// ─────────────────────────────────────────────────────────────────────────────
const getCEPendingApplicationsByDivision = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const bucket = String(req.query.bucket || "").trim();
    const bucketWhere = BUCKET_WHERE[bucket];
    if (!bucketWhere) return res.status(400).json({ error: "Invalid bucket." });

    const divisionCode = String(req.query.divisionCode || "").trim();
    if (!divisionCode) return res.status(400).json({ error: "Division code is required" });

    const result = await pool.query(
      `SELECT
          o.application_id,
          o.organisation_name,
          o.block,
          o.village,
          o.name,
          o.type_of_connection,
          o.application_status,
          o.created_at,
          o.update_on,
          o.applicant_user_id,
          dv.division_name,
          ${PENDING_WITH_SQL},
          ROUND((${DAYS_PENDING_SQL})::numeric, 1) AS pending_days
       FROM organisation o
       INNER JOIN dbrap_lgd_block    lb ON lb.block_code::text    = o.block_code::text
       INNER JOIN dbrap_division     dv ON dv.division_code::text = lb.division_code::text
       INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
       WHERE o.application_status = ANY($1::text[])
         AND dd.circle_code::text = ANY($2::text[])
         AND dv.division_code::text = $3::text
         AND (${bucketWhere})
       ORDER BY o.update_on ASC NULLS LAST, o.created_at ASC`,
      [PENDING_STATUSES, officer.circleCodes, divisionCode]
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("getCEPendingApplicationsByDivision error:", err);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// CE: Application History  GET /api/ce-pending/application-history?userId=…&applicationId=…
// (re-uses the same sla_tracking query as the overdue chart)
// ─────────────────────────────────────────────────────────────────────────────
const getCEPendingApplicationHistory = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const applicationId = String(req.query.applicationId || "").trim();
    if (!applicationId) return res.status(400).json({ error: "Application ID is required" });

    // Ownership check
    const accessResult = await pool.query(
      `SELECT 1
         FROM organisation o
         INNER JOIN dbrap_lgd_block    lb ON lb.block_code::text    = o.block_code::text
         INNER JOIN dbrap_division     dv ON dv.division_code::text = lb.division_code::text
         INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
        WHERE o.application_id = $1
          AND dd.circle_code::text = ANY($2::text[])
        LIMIT 1`,
      [applicationId, officer.circleCodes]
    );
    if (accessResult.rowCount === 0) {
      return res.status(404).json({ error: "Application not found for this CE user" });
    }

    const result = await pool.query(
      `SELECT
          sm.stage_description AS stage,
          st.start_time,
          st.due_time,
          st.completed_time,
          CASE
            WHEN ut.type_name = 'SE' THEN COALESCE(um.user_name, st.assigned_to) || ' (SE: ' || COALESCE(dv.division_name, '') || ')'
            WHEN ut.type_name = 'JE' THEN COALESCE(um.user_name, st.assigned_to) || ' (JE: ' || COALESCE(lb.block_name, '') || ')'
            WHEN um.designation = 'Applicant' THEN COALESCE(um.user_name, st.assigned_to) || ' (' || um.id || ')'
            ELSE COALESCE(um.user_name, st.assigned_to)
          END AS assigned_to,
          CASE
            WHEN st.completed_time IS NULL THEN 'PENDING'
            WHEN st.due_time >= st.completed_time THEN 'ON_TIME'
            ELSE 'DELAY'
          END AS sla_time_status
       FROM sla_tracking st
       LEFT JOIN user_master      um ON um.login_id           = st.assigned_to
       LEFT JOIN user_type_master ut ON ut.id                 = um.user_type_id
       LEFT JOIN stage_master     sm ON sm.stage_name         = st.stage
       LEFT JOIN organisation      o ON o.application_id      = st.application_id
       LEFT JOIN dbrap_lgd_block  lb ON lb.block_code::text   = o.block_code::text
       LEFT JOIN dbrap_division   dv ON dv.division_code::text = lb.division_code::text
       WHERE st.application_id = $1
       ORDER BY st.start_time ASC, st.id ASC`,
      [applicationId]
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("getCEPendingApplicationHistory error:", err);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// EIC variants — same logic, no circle restriction
// ═════════════════════════════════════════════════════════════════════════════

const ensureEICOfficerMiddleware = async (req, res) => {
  const userId = String(req.query.userId || "").trim();
  if (!userId) { res.status(400).json({ error: "User ID is required" }); return null; }
  const officer = await getEICOfficer(userId);
  if (!officer)             { res.status(404).json({ error: "User not found" }); return null; }
  if (officer.unauthorized) { res.status(403).json({ error: "Unauthorized: EIC user type required" }); return null; }
  return officer;
};

const getEICPendingSummary = async (req, res) => {
  try {
    const officer = await ensureEICOfficerMiddleware(req, res);
    if (!officer) return;

    const result = await pool.query(
      `SELECT
          COUNT(DISTINCT CASE WHEN ${DAYS_PENDING_SQL} >= 0  AND ${DAYS_PENDING_SQL} <  2  THEN o.application_id END)::int AS bucket_0_2,
          COUNT(DISTINCT CASE WHEN ${DAYS_PENDING_SQL} >= 2  AND ${DAYS_PENDING_SQL} <  5  THEN o.application_id END)::int AS bucket_2_5,
          COUNT(DISTINCT CASE WHEN ${DAYS_PENDING_SQL} >= 5  AND ${DAYS_PENDING_SQL} < 10  THEN o.application_id END)::int AS bucket_5_10,
          COUNT(DISTINCT CASE WHEN ${DAYS_PENDING_SQL} >= 10                               THEN o.application_id END)::int AS bucket_10_plus
       FROM organisation o
       WHERE o.application_status = ANY($1::text[])`,
      [PENDING_STATUSES]
    );

    const row = result.rows[0] || {};
    return res.status(200).json({
      bucket_0_2:     Number(row.bucket_0_2     || 0),
      bucket_2_5:     Number(row.bucket_2_5     || 0),
      bucket_5_10:    Number(row.bucket_5_10    || 0),
      bucket_10_plus: Number(row.bucket_10_plus || 0),
    });
  } catch (err) {
    console.error("getEICPendingSummary error:", err);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getEICPendingByDivision = async (req, res) => {
  try {
    const officer = await ensureEICOfficerMiddleware(req, res);
    if (!officer) return;

    const bucket = String(req.query.bucket || "").trim();
    const bucketWhere = BUCKET_WHERE[bucket];
    if (!bucketWhere) return res.status(400).json({ error: "Invalid bucket." });

    const result = await pool.query(
      `SELECT
          dv.division_code,
          dv.division_name,
          COUNT(DISTINCT o.application_id)::int              AS application_count,
          ROUND(AVG(${DAYS_PENDING_SQL})::numeric, 1)        AS avg_pending_days
       FROM organisation o
       INNER JOIN dbrap_lgd_block lb ON lb.block_code::text    = o.block_code::text
       INNER JOIN dbrap_division  dv ON dv.division_code::text = lb.division_code::text
       WHERE o.application_status = ANY($1::text[])
         AND (${bucketWhere})
       GROUP BY dv.division_code, dv.division_name
       ORDER BY application_count DESC, dv.division_name ASC`,
      [PENDING_STATUSES]
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("getEICPendingByDivision error:", err);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getEICPendingApplicationsByDivision = async (req, res) => {
  try {
    const officer = await ensureEICOfficerMiddleware(req, res);
    if (!officer) return;

    const bucket = String(req.query.bucket || "").trim();
    const bucketWhere = BUCKET_WHERE[bucket];
    if (!bucketWhere) return res.status(400).json({ error: "Invalid bucket." });

    const divisionCode = String(req.query.divisionCode || "").trim();
    if (!divisionCode) return res.status(400).json({ error: "Division code is required" });

    const result = await pool.query(
      `SELECT
          o.application_id,
          o.organisation_name,
          o.block,
          o.village,
          o.name,
          o.type_of_connection,
          o.application_status,
          o.created_at,
          o.update_on,
          o.applicant_user_id,
          dv.division_name,
          ${PENDING_WITH_SQL},
          ROUND((${DAYS_PENDING_SQL})::numeric, 1) AS pending_days
       FROM organisation o
       INNER JOIN dbrap_lgd_block lb ON lb.block_code::text    = o.block_code::text
       INNER JOIN dbrap_division  dv ON dv.division_code::text = lb.division_code::text
       WHERE o.application_status = ANY($1::text[])
         AND dv.division_code::text = $2::text
         AND (${bucketWhere})
       ORDER BY o.update_on ASC NULLS LAST, o.created_at ASC`,
      [PENDING_STATUSES, divisionCode]
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("getEICPendingApplicationsByDivision error:", err);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getEICPendingApplicationHistory = async (req, res) => {
  try {
    const officer = await ensureEICOfficerMiddleware(req, res);
    if (!officer) return;

    const applicationId = String(req.query.applicationId || "").trim();
    if (!applicationId) return res.status(400).json({ error: "Application ID is required" });

    const result = await pool.query(
      `SELECT
          sm.stage_description AS stage,
          st.start_time,
          st.due_time,
          st.completed_time,
          CASE
            WHEN ut.type_name = 'SE' THEN COALESCE(um.user_name, st.assigned_to) || ' (SE: ' || COALESCE(dv.division_name, '') || ')'
            WHEN ut.type_name = 'JE' THEN COALESCE(um.user_name, st.assigned_to) || ' (JE: ' || COALESCE(lb.block_name, '') || ')'
            WHEN um.designation = 'Applicant' THEN COALESCE(um.user_name, st.assigned_to) || ' (' || um.id || ')'
            ELSE COALESCE(um.user_name, st.assigned_to)
          END AS assigned_to,
          CASE
            WHEN st.completed_time IS NULL THEN 'PENDING'
            WHEN st.due_time >= st.completed_time THEN 'ON_TIME'
            ELSE 'DELAY'
          END AS sla_time_status
       FROM sla_tracking st
       LEFT JOIN user_master      um ON um.login_id            = st.assigned_to
       LEFT JOIN user_type_master ut ON ut.id                  = um.user_type_id
       LEFT JOIN stage_master     sm ON sm.stage_name          = st.stage
       LEFT JOIN organisation      o ON o.application_id       = st.application_id
       LEFT JOIN dbrap_lgd_block  lb ON lb.block_code::text    = o.block_code::text
       LEFT JOIN dbrap_division   dv ON dv.division_code::text = lb.division_code::text
       WHERE st.application_id = $1
       ORDER BY st.start_time ASC, st.id ASC`,
      [applicationId]
    );

    return res.status(200).json(result.rows);
  } catch (err) {
    console.error("getEICPendingApplicationHistory error:", err);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = {
  // CE
  getCEPendingSummary,
  getCEPendingByDivision,
  getCEPendingApplicationsByDivision,
  getCEPendingApplicationHistory,
  // EIC
  getEICPendingSummary,
  getEICPendingByDivision,
  getEICPendingApplicationsByDivision,
  getEICPendingApplicationHistory,
};
