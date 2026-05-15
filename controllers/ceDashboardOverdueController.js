

const pool = require("../db/db");

// ── getCEOfficer / ensureCEOfficer ───────────────────────────────────────────
// (same helpers as the main CE dashboard controller — import from there if shared)
const getCEOfficer = async (userId) => {
  const result = await pool.query(
    `SELECT id, login_id, user_type_id, circle_code
     FROM user_master WHERE id = $1 LIMIT 1`,
    [userId]
  );
  const officer = result.rows[0] || null;
  if (!officer) return null;
  if (Number(officer.user_type_id) !== 6) return { unauthorized: true };
  const circleCodes = String(officer.circle_code || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!circleCodes.length) return { missingCircle: true };
  return { ...officer, circleCodes };
};

const ensureCEOfficer = async (req, res) => {
  const userId = String(req.query.userId || "").trim();
  if (!userId) { res.status(400).json({ error: "User ID is required" }); return null; }
  const officer = await getCEOfficer(userId);
  if (!officer)            { res.status(404).json({ error: "User not found" }); return null; }
  if (officer.unauthorized){ res.status(403).json({ error: "Unauthorized: CE user type required" }); return null; }
  if (officer.missingCircle){ res.status(400).json({ error: "CE user has no circle assigned" }); return null; }
  return officer;
};

// ── Shared CTE ────────────────────────────────────────────────────────────────
// Joins sla_tracking → organisation → block → division → district
// Filters to this CE's circles and only rows where completed_time > due_time
const OVERDUE_CTE = `
  WITH overdue AS (
    SELECT
      st.application_id,
      st.stage,
      o.block_code,
      EXTRACT(EPOCH FROM (st.completed_time - st.due_time)) / 86400.0 AS overdue_days
    FROM sla_tracking st
    INNER JOIN organisation       o  ON o.application_id    = st.application_id
    INNER JOIN dbrap_lgd_block    lb ON lb.block_code::text  = o.block_code::text
    INNER JOIN dbrap_division     dv ON dv.division_code::text = lb.division_code::text
    INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
    WHERE st.completed_time IS NOT NULL
      AND st.due_time       IS NOT NULL
      AND st.completed_time > st.due_time
      AND dd.circle_code::text = ANY($1::text[])
  )
`;

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ce-dashboard/overdue-summary?userId=…
// Returns bucket counts across ALL sla_tracking stages for this CE's circles.
// Each sla_tracking row (stage) is counted independently.
// ─────────────────────────────────────────────────────────────────────────────
const getCEDashboardOverdueSummary = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const result = await pool.query(
      `${OVERDUE_CTE}
       SELECT
         COUNT(DISTINCT CASE WHEN overdue_days >= 1 AND overdue_days <  2 THEN application_id END)::int AS bucket_0_2,
         COUNT(DISTINCT CASE WHEN overdue_days >= 2 AND overdue_days <  5 THEN application_id END)::int AS bucket_2_5,
         COUNT(DISTINCT CASE WHEN overdue_days >= 5 AND overdue_days < 10 THEN application_id END)::int AS bucket_5_10,
         COUNT(DISTINCT CASE WHEN overdue_days >= 10                      THEN application_id END)::int AS bucket_10_plus
       FROM overdue`,
      [officer.circleCodes]
    );

    const row = result.rows[0] || {};
    return res.status(200).json({
      bucket_0_2:     Number(row.bucket_0_2     || 0),
      bucket_2_5:     Number(row.bucket_2_5     || 0),
      bucket_5_10:    Number(row.bucket_5_10    || 0),
      bucket_10_plus: Number(row.bucket_10_plus || 0),
    });
  } catch (error) {
    console.error("getCEDashboardOverdueSummary error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ce-dashboard/overdue-by-division?userId=…&bucket=0_2|2_5|5_10|10_plus
//
// For the chosen bucket returns per-division:
//   division_name       – division name
//   application_count   – number of overdue sla_tracking rows (stage-level)
//   avg_overdue_days    – average days late (1 decimal)
//
// To count unique applications instead of stages, change COUNT(*) to
// COUNT(DISTINCT ov.application_id).
// ─────────────────────────────────────────────────────────────────────────────
const BUCKET_WHERE = {
  "0_2":     "overdue_days >= 1 AND overdue_days <  2",
  "2_5":     "overdue_days >= 2 AND overdue_days <  5",
  "5_10":    "overdue_days >= 5 AND overdue_days < 10",
  "10_plus": "overdue_days >= 10",
};

const getCEDashboardOverdueByDivision = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const bucket = String(req.query.bucket || "").trim();
    const bucketWhere = BUCKET_WHERE[bucket];
    if (!bucketWhere) {
      return res.status(400).json({
        error: "Invalid bucket. Use: 0_2 | 2_5 | 5_10 | 10_plus",
      });
    }

    const result = await pool.query(
      `${OVERDUE_CTE}
       SELECT
         dv.division_code,
         dv.division_name,
         COUNT(DISTINCT ov.application_id)::int   AS application_count,
         ROUND(AVG(ov.overdue_days)::numeric, 1)  AS avg_overdue_days
       FROM overdue ov
       INNER JOIN dbrap_lgd_block lb ON lb.block_code::text    = ov.block_code::text
       INNER JOIN dbrap_division  dv ON dv.division_code::text = lb.division_code::text
       WHERE ${bucketWhere}
       GROUP BY dv.division_code, dv.division_name
       ORDER BY application_count DESC, dv.division_name ASC`,
      [officer.circleCodes]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getCEDashboardOverdueByDivision error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getCEDashboardOverdueApplicationsByDivision = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const bucket = String(req.query.bucket || "").trim();
    const bucketWhere = BUCKET_WHERE[bucket];
    if (!bucketWhere) {
      return res.status(400).json({
        error: "Invalid bucket. Use: 0_2 | 2_5 | 5_10 | 10_plus",
      });
    }

    const divisionCode = String(req.query.divisionCode || "").trim();
    if (!divisionCode) {
      return res.status(400).json({ error: "Division code is required" });
    }

    const result = await pool.query(
      `${OVERDUE_CTE}
       SELECT DISTINCT ON (o.application_id)
         o.application_id,
         o.organisation_name,
         o.block,
         o.village,
         o.name,
         o.type_of_connection,
         o.application_status,
         o.created_at,
         ov.overdue_days
       FROM overdue ov
       INNER JOIN dbrap_lgd_block lb ON lb.block_code::text    = ov.block_code::text
       INNER JOIN dbrap_division  dv ON dv.division_code::text = lb.division_code::text
       INNER JOIN organisation    o  ON o.application_id       = ov.application_id
       WHERE ${bucketWhere}
         AND dv.division_code::text = $2::text
       ORDER BY o.application_id, ov.overdue_days DESC`,
      [officer.circleCodes, divisionCode]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getCEDashboardOverdueApplicationsByDivision error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getCEDashboardOverdueApplicationHistory = async (req, res) => {
  try {
    const officer = await ensureCEOfficer(req, res);
    if (!officer) return;

    const applicationId = String(req.query.applicationId || "").trim();
    if (!applicationId) {
      return res.status(400).json({ error: "Application ID is required" });
    }

    const accessResult = await pool.query(
      `
        SELECT 1
        FROM organisation o
        INNER JOIN dbrap_lgd_block lb ON lb.block_code::text = o.block_code::text
        INNER JOIN dbrap_division dv ON dv.division_code::text = lb.division_code::text
        INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
        WHERE o.application_id = $1
          AND dd.circle_code::text = ANY($2::text[])
        LIMIT 1
      `,
      [applicationId, officer.circleCodes]
    );

    if (accessResult.rowCount === 0) {
      return res.status(404).json({ error: "Application not found for this CE user" });
    }

    const result = await pool.query(
      `
        SELECT
    sm.stage_description AS stage,
    st.start_time,
    st.due_time,
    st.completed_time,
    CASE
        WHEN ut.type_name = 'SE'
            THEN COALESCE(um.user_name, st.assigned_to) 
                 || ' (SE: ' || COALESCE(dv.division_name, '') || ')'
        WHEN ut.type_name = 'JE'
            THEN COALESCE(um.user_name, st.assigned_to) 
                 || ' (JE: ' || COALESCE(lb.block_name, '') || ')'
        WHEN um.designation = 'Applicant'
            THEN COALESCE(um.user_name, st.assigned_to)
                 || ' (' || um.id || ')'
        ELSE COALESCE(um.user_name, st.assigned_to)
    END AS assigned_to,
    CASE
        WHEN st.due_time >= st.completed_time THEN 'ON_TIME'
        WHEN st.completed_time > st.due_time THEN 'DELAY'
        WHEN st.completed_time IS NULL AND st.due_time < NOW() THEN 'PENDING'
        ELSE NULL
    END AS sla_time_status
FROM sla_tracking st

LEFT JOIN user_master um
    ON um.login_id = st.assigned_to

LEFT JOIN user_type_master ut
    ON ut.id = um.user_type_id

LEFT JOIN stage_master sm
    ON sm.stage_name = st.stage

LEFT JOIN organisation o
    ON o.application_id = st.application_id

LEFT JOIN dbrap_lgd_block lb
    ON lb.block_code::text = o.block_code::text

LEFT JOIN dbrap_division dv
    ON dv.division_code::text = lb.division_code::text

WHERE st.application_id = $1

ORDER BY st.start_time ASC, st.id ASC;
      `,
      [applicationId]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getCEDashboardOverdueApplicationHistory error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = {
  getCEDashboardOverdueSummary,
  getCEDashboardOverdueByDivision,
  getCEDashboardOverdueApplicationsByDivision,
  getCEDashboardOverdueApplicationHistory,
};

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — add to your Express router file
// ─────────────────────────────────────────────────────────────────────────────
//
//   const {
//     getCEDashboardOverdueSummary,
//     getCEDashboardOverdueByDivision,
//   } = require("./controllers/ceDashboardOverdue");
//
//   router.get("/ce-dashboard/overdue-summary",     getCEDashboardOverdueSummary);
//   router.get("/ce-dashboard/overdue-by-division", getCEDashboardOverdueByDivision);
