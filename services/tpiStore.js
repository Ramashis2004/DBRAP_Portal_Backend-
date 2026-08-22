const pool = require("../db/db");

// In-memory fallback stores for test mode
const testRequestStore = new Map();
const testApplicationStore = new Map();

/**
 * Ensures the odisha_one_audit_logs table exists in the database
 */
const initAuditLogTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS odisha_one_audit_logs (
        id SERIAL PRIMARY KEY,
        request_id VARCHAR(100),
        api_name VARCHAR(100),
        service_id VARCHAR(50),
        sub_service_id VARCHAR(50),
        oo_user_code VARCHAR(100),
        application_id VARCHAR(100),
        status_code VARCHAR(20),
        status_message TEXT,
        ip_address VARCHAR(50),
        user_agent TEXT,
        raw_payload TEXT,
        decrypted_data JSONB,
        execution_time_ms INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE odisha_one_audit_logs ADD COLUMN IF NOT EXISTS ip_address VARCHAR(50);
      ALTER TABLE odisha_one_audit_logs ADD COLUMN IF NOT EXISTS user_agent TEXT;
      ALTER TABLE odisha_one_audit_logs ADD COLUMN IF NOT EXISTS raw_payload TEXT;
      ALTER TABLE odisha_one_audit_logs ADD COLUMN IF NOT EXISTS decrypted_data JSONB;
      ALTER TABLE odisha_one_audit_logs ADD COLUMN IF NOT EXISTS execution_time_ms INTEGER;
    `);
  } catch (err) {
    console.warn("[ODISHA-ONE] Audit table init note:", err.message);
  }
};

// Run table initialization on startup
initAuditLogTable();

/**
 * Logs integration activity to odisha_one_audit_logs
 */
const logAudit = async ({
  requestId,
  apiName,
  serviceId,
  subServiceId,
  ooUserCode,
  applicationId,
  statusCode,
  statusMessage,
  ipAddress,
  userAgent,
  rawPayload,
  decryptedData,
  executionTimeMs,
}) => {
  const timestamp = new Date().toISOString();
  console.log(`[ODISHA-ONE AUDIT] [${timestamp}] API: ${apiName || "N/A"} | REQ_ID: ${requestId || "N/A"} | STATUS: ${statusCode || "200"} | MSG: ${statusMessage || ""} | IP: ${ipAddress || "N/A"}`);
  try {
    await pool.query(
      `
        INSERT INTO odisha_one_audit_logs
        (request_id, api_name, service_id, sub_service_id, oo_user_code, application_id, status_code, status_message, ip_address, user_agent, raw_payload, decrypted_data, execution_time_ms, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW())
      `,
      [
        requestId || null,
        apiName || null,
        serviceId || null,
        subServiceId || null,
        ooUserCode || null,
        applicationId || null,
        String(statusCode || "200"),
        statusMessage || null,
        ipAddress || null,
        userAgent || null,
        rawPayload || null,
        decryptedData ? JSON.stringify(decryptedData) : null,
        executionTimeMs || null,
      ]
    );
  } catch (err) {
    console.warn("[ODISHA-ONE AUDIT DB NOTE]", err.message);
  }
};

/**
 * Stores test request metadata
 */
const saveTestRequest = (requestId, data) => {
  testRequestStore.set(requestId, {
    ...data,
    updatedAt: new Date(),
  });
};

/**
 * Fetches test request metadata
 */
const getTestRequest = (requestId) => {
  return testRequestStore.get(requestId) || null;
};

/**
 * Stores test application state
 */
const saveTestApplication = (applicationId, data) => {
  testApplicationStore.set(applicationId, {
    ...data,
    updatedAt: new Date(),
  });
};

/**
 * Fetches test application state
 */
const getTestApplication = (applicationId) => {
  return testApplicationStore.get(applicationId) || null;
};

/**
 * Updates application status in test store
 */
const updateTestApplicationStatus = (applicationId, status, remarks, ooStatus) => {
  const app = testApplicationStore.get(applicationId);
  if (!app) return false;
  app.applicationStatus = status;
  app.remarks = remarks || app.remarks;
  app.ooStatus = ooStatus || app.ooStatus;
  app.updatedAt = new Date();
  testApplicationStore.set(applicationId, app);
  return true;
};

module.exports = {
  logAudit,
  saveTestRequest,
  getTestRequest,
  saveTestApplication,
  getTestApplication,
  updateTestApplicationStatus,
};
