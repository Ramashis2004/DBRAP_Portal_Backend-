const pool = require("../db/db");

const getEICOfficer = async (userId) => {
  const result = await pool.query(
    `
      SELECT u.id, u.login_id, u.user_type_id, ut.type_name
      FROM user_master u
      INNER JOIN user_type_master ut ON ut.id = u.user_type_id
      WHERE u.id = $1
      LIMIT 1
    `,
    [userId]
  );

  const officer = result.rows[0] || null;
  if (!officer) return null;
  if (String(officer.type_name || "").trim().toUpperCase() !== "EIC") return { unauthorized: true };
  return officer;
};

const ensureEICOfficer = async (req, res) => {
  const userId = String(req.query.userId || "").trim();
  if (!userId) {
    res.status(400).json({ error: "User ID is required" });
    return null;
  }

  const officer = await getEICOfficer(userId);
  if (!officer) {
    res.status(404).json({ error: "User not found" });
    return null;
  }
  if (officer.unauthorized) {
    res.status(403).json({ error: "Unauthorized: EIC user type required" });
    return null;
  }

  return officer;
};

const OVERDUE_CTE = `
  WITH overdue AS (
    SELECT
      st.application_id,
      st.stage,
      o.block_code,
      EXTRACT(EPOCH FROM (st.completed_time - st.due_time)) / 86400.0 AS overdue_days
    FROM sla_tracking st
    INNER JOIN organisation       o  ON o.application_id       = st.application_id
    INNER JOIN dbrap_lgd_block    lb ON lb.block_code::text    = o.block_code::text
    INNER JOIN dbrap_division     dv ON dv.division_code::text = lb.division_code::text
    INNER JOIN dbrap_lgd_district dd ON dd.district_code::text = dv.dist_id::text
    WHERE st.completed_time IS NOT NULL
      AND st.due_time       IS NOT NULL
      AND st.completed_time > st.due_time
  )
`;

const BUCKET_WHERE = {
  "0_2": "overdue_days >  0 AND overdue_days <  2",
  "2_5": "overdue_days >= 2 AND overdue_days <  5",
  "5_10": "overdue_days >= 5 AND overdue_days < 10",
  "10_plus": "overdue_days >= 10",
};

const getEICDashboardOverdueSummary = async (req, res) => {
  try {
    const officer = await ensureEICOfficer(req, res);
    if (!officer) return;

    const result = await pool.query(
      `${OVERDUE_CTE}
       SELECT
         COUNT(DISTINCT CASE WHEN overdue_days >  0 AND overdue_days <  2 THEN application_id END)::int AS bucket_0_2,
         COUNT(DISTINCT CASE WHEN overdue_days >= 2 AND overdue_days <  5 THEN application_id END)::int AS bucket_2_5,
         COUNT(DISTINCT CASE WHEN overdue_days >= 5 AND overdue_days < 10 THEN application_id END)::int AS bucket_5_10,
         COUNT(DISTINCT CASE WHEN overdue_days >= 10                      THEN application_id END)::int AS bucket_10_plus
       FROM overdue`
    );

    const row = result.rows[0] || {};
    return res.status(200).json({
      bucket_0_2: Number(row.bucket_0_2 || 0),
      bucket_2_5: Number(row.bucket_2_5 || 0),
      bucket_5_10: Number(row.bucket_5_10 || 0),
      bucket_10_plus: Number(row.bucket_10_plus || 0),
    });
  } catch (error) {
    console.error("getEICDashboardOverdueSummary error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getEICDashboardOverdueByDivision = async (req, res) => {
  try {
    const officer = await ensureEICOfficer(req, res);
    if (!officer) return;

    const bucket = String(req.query.bucket || "").trim();
    const bucketWhere = BUCKET_WHERE[bucket];
    if (!bucketWhere) {
      return res.status(400).json({ error: "Invalid bucket. Use: 0_2 | 2_5 | 5_10 | 10_plus" });
    }

    const result = await pool.query(
      `${OVERDUE_CTE}
       SELECT
         dv.division_code,
         dv.division_name,
         COUNT(DISTINCT ov.application_id)::int AS application_count,
         ROUND(AVG(ov.overdue_days)::numeric, 1) AS avg_overdue_days
       FROM overdue ov
       INNER JOIN dbrap_lgd_block lb ON lb.block_code::text    = ov.block_code::text
       INNER JOIN dbrap_division  dv ON dv.division_code::text = lb.division_code::text
       WHERE ${bucketWhere}
       GROUP BY dv.division_code, dv.division_name
       ORDER BY application_count DESC, dv.division_name ASC`
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getEICDashboardOverdueByDivision error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getEICDashboardOverdueApplicationsByDivision = async (req, res) => {
  try {
    const officer = await ensureEICOfficer(req, res);
    if (!officer) return;

    const bucket = String(req.query.bucket || "").trim();
    const bucketWhere = BUCKET_WHERE[bucket];
    if (!bucketWhere) {
      return res.status(400).json({ error: "Invalid bucket. Use: 0_2 | 2_5 | 5_10 | 10_plus" });
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
         AND dv.division_code::text = $1::text
       ORDER BY o.application_id, ov.overdue_days DESC`,
      [divisionCode]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getEICDashboardOverdueApplicationsByDivision error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const getEICDashboardOverdueApplicationHistory = async (req, res) => {
  try {
    const officer = await ensureEICOfficer(req, res);
    if (!officer) return;

    const applicationId = String(req.query.applicationId || "").trim();
    if (!applicationId) {
      return res.status(400).json({ error: "Application ID is required" });
    }

    const accessResult = await pool.query(
      `SELECT 1 FROM organisation WHERE application_id = $1 LIMIT 1`,
      [applicationId]
    );

    if (accessResult.rowCount === 0) {
      return res.status(404).json({ error: "Application not found" });
    }

    const result = await pool.query(
      `
        SELECT
          st.stage,
          st.start_time,
          COALESCE(um.user_name, st.assigned_to) AS assigned_to,
          st.completed_time,
          st.status AS application_status
        FROM sla_tracking st
        LEFT JOIN user_master um
          ON um.login_id = st.assigned_to
         AND COALESCE(um.active_flag, 'N') = 'Y'
        WHERE st.application_id = $1
        ORDER BY st.start_time ASC, st.id ASC
      `,
      [applicationId]
    );

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getEICDashboardOverdueApplicationHistory error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = {
  getEICDashboardOverdueSummary,
  getEICDashboardOverdueByDivision,
  getEICDashboardOverdueApplicationsByDivision,
  getEICDashboardOverdueApplicationHistory,
};
