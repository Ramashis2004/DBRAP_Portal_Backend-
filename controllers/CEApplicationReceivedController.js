const pool = require("../db/db");
const { APPLICATION_STATUS } = require("../constraints/application_status_enum");

const parseApplicationStatuses = (value) => {
  const rawValues = Array.isArray(value)
    ? value
    : String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

  const statuses =
    rawValues.length > 0 ? rawValues : [APPLICATION_STATUS.APPLICATION_SUBMITTED];

  return statuses.map((status) => String(status).trim().toUpperCase());
};

const APPLICATION_STATUS_VALUES = Object.values(APPLICATION_STATUS);

/**
 * GET /api/ce-application-received/applications
 *
 * When block_code is absent or "ALL":
 *   → returns all applications across every circle mapped to this CE user.
 *
 * When block_code is a specific code:
 *   → returns applications for that block only (existing behaviour, with
 *     circle-ownership guard preserved).
 */
const getCEApplicationReceivedApplications = async (req, res) => {
  try {
    const userId    = String(req.query.userId     || "").trim();
    const blockCode = String(req.query.block_code || "").trim();
    const applicationStatuses = parseApplicationStatuses(req.query.application_status);

    // ── Validate inputs ─────────────────────────────────────────────────────

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    if (applicationStatuses.some((s) => !APPLICATION_STATUS_VALUES.includes(s))) {
      return res.status(400).json({
        error: "Invalid application status filter value",
        allowedStatuses: APPLICATION_STATUS_VALUES,
      });
    }

    // ── Verify CE user exists and has user_type_id = 6 ─────────────────────

    const officerResult = await pool.query(
      `
        SELECT id, user_type_id, circle_code
        FROM user_master
        WHERE id = $1
        LIMIT 1
      `,
      [userId]
    );

    if (officerResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const officer    = officerResult.rows[0];
    const userTypeId = Number(officer.user_type_id);

    if (userTypeId !== 6) {
      return res.status(403).json({ error: "Unauthorized: CE user type required" });
    }

    const ceCircleCodes = String(officer.circle_code || "")
      .split(",")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);

    if (!ceCircleCodes.length) {
      return res.status(403).json({ error: "CE user has no circle assigned" });
    }

    // ── Shared SELECT columns ───────────────────────────────────────────────

    const SELECT_COLS = `
      o.application_id,
      o.organisation_name,
      o.establishment_type,
      o.application_status,
      o.created_at,
      o.update_on,
      o.forward_on,
      o.site_visit_report,
      o.site_visit_report_upload_on,
      o.approved_on,
      o.district_code,
      o.block_code,
      o.district,
      o.block,
      o.gram_panchayat,
      o.village,
      o.habitation,
      o.name,
      o.gender,
      o.email,
      o.mobile_number,
      o.type_of_connection,
      o.water_requirement,
      o.property_proof,
      o.registration_proof,
      o.ownership_proof,
      o.owner_indemnity_bond,
      o.identity_proof,
      o.applicant_user_id,
      dv.division_name

    `;

    let result;

    if (!blockCode || blockCode.toUpperCase() === "ALL") {
      // ── "All Circles" path: all apps across every circle mapped to this CE ─
      //
      // Join path (ownership guard via circle):
      //   organisation (block_code)
      //     → dbrap_lgd_block (block_code → division_code)
      //     → dbrap_division  (division_code → dist_id)
      //     → dbrap_lgd_district (district_code → circle_code)
      //
      result = await pool.query(
        `
          SELECT ${SELECT_COLS}
          FROM organisation o
          INNER JOIN dbrap_lgd_block lb
            ON lb.block_code::text = o.block_code::text
          INNER JOIN dbrap_division dv
            ON dv.division_code::text = lb.division_code::text
          INNER JOIN dbrap_lgd_district dd
            ON dd.district_code::text = dv.dist_id::text
          WHERE dd.circle_code::text = ANY($1::text[])
            AND o.application_status = ANY($2::text[])
          ORDER BY o.created_at DESC
        `,
        [ceCircleCodes, applicationStatuses]
      );
    } else {
      // ── Specific block path (existing behaviour) ────────────────────────────
      result = await pool.query(
        `
          SELECT ${SELECT_COLS}
          FROM organisation o
          INNER JOIN dbrap_lgd_block lb
            ON lb.block_code::text = o.block_code::text
          INNER JOIN dbrap_division dv
            ON dv.division_code::text = lb.division_code::text
          INNER JOIN dbrap_lgd_district dd
            ON dd.district_code::text = dv.dist_id::text
          WHERE o.block_code::text       = $1
            AND dd.circle_code::text     = ANY($2::text[])
            AND o.application_status     = ANY($3::text[])
          ORDER BY o.created_at DESC
        `,
        [blockCode, ceCircleCodes, applicationStatuses]
      );
    }

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getCEApplicationReceivedApplications error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = { getCEApplicationReceivedApplications };
