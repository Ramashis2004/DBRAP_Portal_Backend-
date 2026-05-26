const pool = require("../db/db");

const STAGE_ROLE_MAP = {
  FORWARD_TO_JE: "SE",
  SITE_INSPECTION_BY_JE: "JE",
  SITE_VISIT_REPORT_UPLOAD_BY_JE: "JE",
  APPROVAL_BY_SE: "SE",
  PAYMENT_BY_USER: "USER",
  PAYMENT_VERIFICATION_BY_JE: "JE",
  CONNECTION_DETAIL_UPDATE_BY_JE: "JE",
};

const getRoleForStage = (stageName) => {
  const key = String(stageName || "").trim().toUpperCase();
  return STAGE_ROLE_MAP[key] || null;
};

const listStageSlaConfigs = async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        sm.stage_name,
        sm.stage_description,
        sc.id AS sla_id,
        sc.duration_hours,
        sc.applicable_role,
        sc.is_active,
        sc.created_at,
        sc.updated_at
      FROM stage_master sm
      LEFT JOIN LATERAL (
        SELECT id, duration_hours, applicable_role, is_active, created_at, updated_at
        FROM sla_config
        WHERE stage = sm.stage_name
          AND COALESCE(is_active, true) = true
        ORDER BY created_at DESC
        LIMIT 1
      ) sc ON true
      ORDER BY sm.stage_id ASC
    `
    );

    return res.status(200).json(
      result.rows.map((row) => ({
        stageName: row.stage_name,
        stageDescription: row.stage_description,
        sla: row.sla_id
          ? {
              id: row.sla_id,
              durationHours: row.duration_hours,
              applicableRole: row.applicable_role,
              isActive: row.is_active,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            }
          : null,
      }))
    );
  } catch (error) {
    console.error("listStageSlaConfigs error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

const saveStageSlaConfig = async (req, res) => {
  const client = await pool.connect();

  try {
    const stageName = String(req.body?.stageName || req.body?.stage_name || "").trim();
    const durationHoursRaw = req.body?.durationHours ?? req.body?.duration_hours;

    const durationHours = Number(durationHoursRaw);

    if (!stageName) {
      return res.status(400).json({ error: "stageName is required" });
    }

    if (!Number.isFinite(durationHours) || durationHours <= 0) {
      return res.status(400).json({ error: "durationHours must be a positive number" });
    }

    const stageExists = await client.query(
      `SELECT 1 FROM stage_master WHERE stage_name = $1 LIMIT 1`,
      [stageName]
    );

    if (stageExists.rowCount === 0) {
      return res.status(400).json({ error: "Invalid stageName" });
    }

    const applicableRole = getRoleForStage(stageName);

    await client.query("BEGIN");

    await client.query(
      `
      UPDATE sla_config
      SET is_active = false,
          updated_at = NOW()
      WHERE stage = $1
        AND COALESCE(is_active, true) = true
    `,
      [stageName]
    );

    const insertResult = await client.query(
      `
      INSERT INTO sla_config (stage, duration_hours, applicable_role, is_active, created_at, updated_at)
      VALUES ($1, $2, $3, true, NOW(), NOW())
      RETURNING id, stage, duration_hours, applicable_role, is_active, created_at, updated_at
    `,
      [stageName, Math.round(durationHours), applicableRole]
    );

    await client.query("COMMIT");

    return res.status(201).json(insertResult.rows[0]);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("saveStageSlaConfig error:", error);
    return res.status(500).json({ error: "Server Error" });
  } finally {
    client.release();
  }
};

module.exports = {
  listStageSlaConfigs,
  saveStageSlaConfig,
};
