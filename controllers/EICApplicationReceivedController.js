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

const getEICApplicationReceivedApplications = async (req, res) => {
  try {
    const userId    = String(req.query.userId     || "").trim();
    const blockCode = String(req.query.block_code || "").trim();
    const applicationStatuses = parseApplicationStatuses(req.query.application_status);

    // ── Basic validation ────────────────────────────────────────────────────

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    if (applicationStatuses.some((s) => !APPLICATION_STATUS_VALUES.includes(s))) {
      return res.status(400).json({
        error: "Invalid application status filter value",
        allowedStatuses: APPLICATION_STATUS_VALUES,
      });
    }

    // ── Verify EIC user ─────────────────────────────────────────────────────

    const officerResult = await pool.query(
      `
        SELECT u.id, u.user_type_id, ut.type_name
        FROM user_master u
        INNER JOIN user_type_master ut ON ut.id = u.user_type_id
        WHERE u.id = $1
        LIMIT 1
      `,
      [userId]
    );

    if (officerResult.rows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const userTypeName = String(officerResult.rows[0].type_name || "").trim().toUpperCase();

    if (userTypeName !== "EIC") {
      return res.status(403).json({ error: "Unauthorized: EIC user type required" });
    }

    // ── Shared SELECT columns ───────────────────────────────────────────────

    const SELECT_COLS = `
      o.application_id,
      o.organisation_name,
      o.establishment_type,
      o.application_status,
      o.created_at,
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
      o.identity_proof
    `;

    let result;

    if (!blockCode || blockCode.toUpperCase() === "ALL") {
      // ── "All Circles" path: no block restriction, EIC sees everything ─────
      result = await pool.query(
        `
          SELECT ${SELECT_COLS}
          FROM organisation o
          INNER JOIN dbrap_lgd_block lb
            ON lb.block_code::text = o.block_code::text
          WHERE o.application_status = ANY($1::text[])
          ORDER BY o.created_at DESC
        `,
        [applicationStatuses]
      );
    } else {
      // ── Specific block path ───────────────────────────────────────────────
      result = await pool.query(
        `
          SELECT ${SELECT_COLS}
          FROM organisation o
          INNER JOIN dbrap_lgd_block lb
            ON lb.block_code::text = o.block_code::text
          WHERE o.block_code::text      = $1
            AND o.application_status    = ANY($2::text[])
          ORDER BY o.created_at DESC
        `,
        [blockCode, applicationStatuses]
      );
    }

    return res.status(200).json(result.rows);
  } catch (error) {
    console.error("getEICApplicationReceivedApplications error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = { getEICApplicationReceivedApplications };
