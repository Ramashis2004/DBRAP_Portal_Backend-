require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./db/db");

const authRoutes = require("./routes/authRoutes");
const organisationRoutes = require("./routes/organisationRoutes");
const applicationReceivedRoutes = require("./routes/applicationReceivedRoutes");
const ceApplicationReceivedRoutes = require("./routes/CEApplicationReceivedRoutes");
const eicApplicationReceivedRoutes = require("./routes/eicApplicationReceivedRoutes");
const sePaymentDetailsRoutes = require("./routes/sePaymentDetailsRoutes");
const jePaymentDetailsRoutes = require("./routes/jePaymentDetailsRoutes");
const locationRoutes = require("./routes/locationRoutes");
const forgotPasswordRoute = require("./routes/forgotPasswordRoute");
const applicantAuthRoutes = require("./routes/applicantAuthRoutes");
const applicantApplicationRoutes = require("./routes/applicantApplicationRoutes");
const historyRoutes = require("./routes/historyRoutes");

const pendingApplicationsRoutes = require("./routes/pendingApplicationsRoutes");
const paymentVerificationRoutes = require("./routes/paymentVerificationRoutes");
const updateConnRoutes = require("./routes/updateConnectionDetailsRoutes");
const applicantPaymentRoutes = require("./routes/applicantPaymentRoutes");
const seDashboardApplicationsRoutes = require("./routes/seDashboardApplicationsRoutes");
const ceDashboardApplicationsRoutes = require("./routes/ceDashboardApplicationsRoutes");
const ceDashboardOverdueRoutes = require("./routes/ceDashboardOverdueRoutes");
const eicDashboardApplicationsRoutes = require("./routes/eicDashboardApplicationsRoutes");
const eicDashboardOverdueRoutes = require("./routes/eicDashboardOverdueRoutes");
const slaConfigRoutes = require("./routes/slaConfigRoutes");
const slaTrackingRoutes = require("./routes/slaTrackingRoutes");

const app = express();

app.use(cors());
app.use(express.json());
app.get("/api/officer/test", (req, res) => {
  res.json({ ok: true });
});

app.use("/api/applicant-payment", applicantPaymentRoutes);
app.use("/api/pending-applications", pendingApplicationsRoutes);

app.use("/api/auth", authRoutes);
app.use("/api/organisation", organisationRoutes);
app.use("/api/application-received", applicationReceivedRoutes);
app.use("/api/ce-application-received", ceApplicationReceivedRoutes);
app.use("/api/eic-application-received", eicApplicationReceivedRoutes);
app.use("/api/se-payment-details", sePaymentDetailsRoutes);
app.use("/api/je-payment-details", jePaymentDetailsRoutes);
app.use("/api/location", locationRoutes);
app.use("/api/applicant-auth", applicantAuthRoutes);
app.use("/api/applicant-application", applicantApplicationRoutes);
app.use("/api/history", historyRoutes);
app.use("/api", forgotPasswordRoute);
app.use("/api/payment-verification", paymentVerificationRoutes);
app.use("/api/officer", updateConnRoutes);
app.use("/api/se-dashboard-applications", seDashboardApplicationsRoutes);
app.use("/api/ce-dashboard-applications", ceDashboardApplicationsRoutes);
app.use("/api/ce-dashboard", ceDashboardOverdueRoutes);
app.use("/api/eic-dashboard-applications", eicDashboardApplicationsRoutes);
app.use("/api/eic-dashboard", eicDashboardOverdueRoutes);
app.use("/api/sla-config", slaConfigRoutes);
app.use("/api/sla-tracking", slaTrackingRoutes);

const PORT = process.env.PORT || 5000;

const ensureOrganisationSchema = async () => {
  const enumExistsResult = await pool.query(`
    SELECT 1
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'application_status_enum'
      AND n.nspname = 'public'
    LIMIT 1
  `);

  if (enumExistsResult.rowCount === 0) {
    await pool.query(`
      CREATE TYPE public.application_status_enum AS ENUM (
        'APPLICATION_SUBMITTED',
        'APPLICATION_FORWARDED_TO_JE',
        'JE_VERIFIED_REPORT_UPLOADED',
        'APPLICATION_APPROVED'
      )
    `);
  }

  await pool.query(`
    ALTER TABLE organisation
    ADD COLUMN IF NOT EXISTS application_id TEXT
  `);

  await pool.query(`
    ALTER TABLE organisation
    ADD COLUMN IF NOT EXISTS application_status public.application_status_enum NOT NULL DEFAULT 'APPLICATION_SUBMITTED'
  `);

  await pool.query(`
    ALTER TABLE organisation
    ADD COLUMN IF NOT EXISTS site_visit_report TEXT
  `);

  await pool.query(`
    ALTER TABLE organisation
    ADD COLUMN IF NOT EXISTS applicant_user_id TEXT
  `);

  await pool.query(`
    UPDATE organisation
    SET application_status = 'APPLICATION_SUBMITTED'
    WHERE application_status IS NULL
  `);

  await pool.query(`
    ALTER TABLE organisation
    ALTER COLUMN application_status SET DEFAULT 'APPLICATION_SUBMITTED'
  `);

  await pool.query(`
    ALTER TABLE organisation
    ALTER COLUMN application_status SET NOT NULL
  `);

  await pool.query(`
    ALTER TABLE organisation
    DROP COLUMN IF EXISTS status
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS organisation_application_id_idx
    ON organisation (application_id)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS dbrap_payment_details (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      block_code TEXT NOT NULL,
      application_id TEXT NOT NULL,
      connection_type TEXT NOT NULL,
      amount NUMERIC(12, 2) NOT NULL,
      date_of_payment DATE NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'PAID',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE dbrap_payment_details ADD COLUMN IF NOT EXISTS user_id TEXT`);
  await pool.query(`ALTER TABLE dbrap_payment_details ADD COLUMN IF NOT EXISTS block_code TEXT`);
  await pool.query(`ALTER TABLE dbrap_payment_details ADD COLUMN IF NOT EXISTS application_id TEXT`);
  await pool.query(`ALTER TABLE dbrap_payment_details ADD COLUMN IF NOT EXISTS connection_type TEXT`);
  await pool.query(`ALTER TABLE dbrap_payment_details ADD COLUMN IF NOT EXISTS amount NUMERIC(12, 2)`);
  await pool.query(`ALTER TABLE dbrap_payment_details ADD COLUMN IF NOT EXISTS date_of_payment DATE`);
  await pool.query(`ALTER TABLE dbrap_payment_details ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'PAID'`);
  await pool.query(`ALTER TABLE dbrap_payment_details ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW()`);

  await pool.query(`
    DO $func$
    DECLARE
      applicant_role_id INTEGER := 7;
      application_menu_id INTEGER;
      apply_option_id INTEGER;
    BEGIN
      INSERT INTO dbrap_role (role_id, role_name, role_desc, status, abbr)
      SELECT applicant_role_id, 'Applicant', 'Applicant', true, 'APP'
      WHERE NOT EXISTS (
        SELECT 1 FROM dbrap_role WHERE role_id = applicant_role_id
      );

      SELECT menu_id
      INTO application_menu_id
      FROM dbrap_menu
      WHERE LOWER(menu_name) = 'application management'
      LIMIT 1;

      IF application_menu_id IS NULL THEN
        SELECT COALESCE(MAX(menu_id), 0) + 1 INTO application_menu_id FROM dbrap_menu;
        INSERT INTO dbrap_menu (menu_id, menu_name, menu_description, status, menu_priority)
        VALUES (application_menu_id, 'Application Management', 'Applicant application services', true, '1');
      END IF;

      INSERT INTO dbrap_role_menu_mapping (role_id, menu_id, serial_no)
      SELECT applicant_role_id, application_menu_id, 1
      WHERE NOT EXISTS (
        SELECT 1 FROM dbrap_role_menu_mapping
        WHERE role_id = applicant_role_id AND menu_id = application_menu_id
      );

      SELECT option_id
      INTO apply_option_id
      FROM dbrap_options
      WHERE LOWER(option_name) = 'apply connection'
        AND menu_id = application_menu_id
      LIMIT 1;

      IF apply_option_id IS NULL THEN
        SELECT COALESCE(MAX(option_id), 0) + 1 INTO apply_option_id FROM dbrap_options;
        INSERT INTO dbrap_options (
          option_id, menu_id, option_name, option_description, option_url, priority, status
        )
        VALUES (
          apply_option_id,
          application_menu_id,
          'Apply Connection',
          'Apply for new commercial water connection',
          '/applicant-organisation-registration',
          '1',
          true
        );
      END IF;

      INSERT INTO dbrap_role_options_mapping (role_id, option_id, status)
      SELECT applicant_role_id, apply_option_id, true
      WHERE NOT EXISTS (
        SELECT 1 FROM dbrap_role_options_mapping
        WHERE role_id = applicant_role_id AND option_id = apply_option_id
      );
    END $func$;
  `);

  // Create login_history table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS login_history (
      id BIGSERIAL PRIMARY KEY,
      user_id TEXT,
      login_id TEXT,
      user_name TEXT,
      ip_address TEXT,
      user_agent TEXT,
      login_status TEXT NOT NULL DEFAULT 'SUCCESS',
      login_time TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sla_config (
      id BIGSERIAL PRIMARY KEY,
      stage TEXT NOT NULL,
      duration_hours INT NOT NULL,
      applicable_role TEXT,
      is_active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS sla_config_stage_active_idx
    ON sla_config (stage, is_active)
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS sla_config_one_active_per_stage_idx
    ON sla_config (stage)
    WHERE is_active = true
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sla_tracking (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      assigned_to TEXT,
      start_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      due_time TIMESTAMPTZ,
      completed_time TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'ON_TIME',
      escalation_level INT NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS sla_tracking_application_id_idx
    ON sla_tracking (application_id)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS sla_tracking_application_stage_idx
    ON sla_tracking (application_id, stage)
  `);

  await pool.query(`
    DO $func$
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'organisation'
      ) THEN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'sla_tracking_application_id_fk'
        ) THEN
          ALTER TABLE sla_tracking
          ADD CONSTRAINT sla_tracking_application_id_fk
          FOREIGN KEY (application_id)
          REFERENCES organisation(application_id)
          ON DELETE CASCADE;
        END IF;
      END IF;
    END $func$;
  `);

  // Create application_history table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS application_history (
      id BIGSERIAL PRIMARY KEY,
      application_id TEXT,
      user_id TEXT,
      user_name TEXT,
      action_type TEXT,
      old_value TEXT,
      new_value TEXT,
      remarks TEXT,
      action_time TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
};

const startServer = async () => {
  try {
    await ensureOrganisationSchema();
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to initialize organisation schema:", error);
    process.exit(1);
  }
};

startServer();
