const pool = require("../db/db");

const daysExpression = (endColumn, startColumn) =>
  `GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${endColumn} - ${startColumn})) / 86400))`;

const getPublicDashboardSummary = async (req, res) => {
  try {
    const applicationsResult = await pool.query(
      `
        SELECT
          ROW_NUMBER() OVER (ORDER BY COALESCE(NULLIF(o.district, ''), 'Unknown'))::int AS sl_no,
          'Commercial Water Connection' AS service_name,
          COALESCE(NULLIF(o.district, ''), 'Unknown') AS district_name,
          COUNT(*)::int AS applications_received,
          COUNT(*) FILTER (
            WHERE o.application_status::text IN (
              'APPLICATION_APPROVED',
              'APPLICATION_REJECTED',
              'CONNECTION_DETAILS_UPDATED'
            )
          )::int AS applications_processed_approved,
          COUNT(*) FILTER (
            WHERE o.application_status::text NOT IN (
              'APPLICATION_APPROVED',
              'APPLICATION_REJECTED',
              'CONNECTION_DETAILS_UPDATED'
            )
          )::int AS applications_pending,
          9::int AS ortpsa_timeline,
          COUNT(*) FILTER (
            WHERE o.application_status::text IN (
              'APPLICATION_APPROVED'
              
            )
            AND o.update_on IS NOT NULL
            AND ${daysExpression("o.update_on", "o.created_at")} <= 9
          )::int AS applications_approved_within_timeline,
          ROUND(AVG(${daysExpression("COALESCE(o.update_on, NOW())", "o.created_at")})::numeric, 1) AS avg_time_taken,
 MIN(
    CASE
      WHEN ${daysExpression("COALESCE(o.update_on, NOW())", "o.created_at")} > 0
      THEN ${daysExpression("COALESCE(o.update_on, NOW())", "o.created_at")}
    END
  )::int AS min_time_taken,
            MAX(${daysExpression("COALESCE(o.update_on, NOW())", "o.created_at")})::int AS max_time_taken
        FROM organisation o
        GROUP BY COALESCE(NULLIF(o.district, ''), 'Unknown')
        ORDER BY district_name
      `
    );

    const inspectionsResult = await pool.query(
      `
        SELECT
          COUNT(*)
           FILTER (
            WHERE due_time IS NOT NULL
              AND completed_time IS NULL
          )::int AS inspections_to_be_conducted,
          COUNT(*) FILTER (
            WHERE due_time IS NOT NULL
              AND completed_time IS NOT NULL
              AND due_time >= completed_time
          )::int AS inspections_conducted_within_timeline,
          COUNT(*) FILTER (
            WHERE due_time IS NOT NULL
              AND completed_time IS NOT NULL
              AND due_time < completed_time
          )::int AS inspections_conducted_beyond_timeline,
          COUNT(*) FILTER (
            WHERE due_time IS NOT NULL
              AND completed_time IS NULL
          )::int AS pending_inspections,
          'NA' AS enterprises_exempted_self_certification,
          'NA' AS enterprises_exempted_third_party_certification
        FROM sla_tracking
        WHERE stage = 'SITE_VISIT_REPORT_UPLOAD_BY_JE'
      `
    );

    const inspectionReportsResult = await pool.query(
      `
        SELECT
          COUNT(*)FILTER (
            WHERE due_time IS NOT NULL
              AND completed_time IS NOT NULL
          ) ::int AS inspections_conducted,
          COUNT(*) FILTER (
            WHERE due_time IS NOT NULL
              AND completed_time IS NOT NULL
              AND due_time > completed_time
          )::int AS reports_uploaded_within_24_hours,
          COUNT(*) FILTER (
            WHERE due_time IS NOT NULL
              AND completed_time IS NOT NULL
              AND due_time < completed_time
          )::int AS reports_uploaded_beyond_24_hours
        FROM sla_tracking
        WHERE stage = 'SITE_VISIT_REPORT_UPLOAD_BY_JE'
      `
    );

    return res.status(200).json({
      applications: applicationsResult.rows,
      inspections: inspectionsResult.rows[0] || {},
      inspectionReports: inspectionReportsResult.rows[0] || {},
    });
  } catch (error) {
    console.error("Public dashboard summary error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = {
  getPublicDashboardSummary,
};
