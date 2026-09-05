// controllers/updateConnectionDetailsController.js

const db = require("../db/db"); // ✅ matches your server.js path
const { saveApplicationHistory } = require("./historyController");
const { handleSlaOnStatusChange } = require("./slaTrackingController");
const { pushApplicationStatusToOdishaOne } = require("./odishaOneController");

// GET /api/officer/connection-details/applications?blockCode=
const getApplicationsForConnectionUpdate = async (req, res) => {
  try {
    const { blockCode } = req.query;

    // console.log("=== getApplicationsForConnectionUpdate ===");
    // console.log("blockCode received:", blockCode, "| type:", typeof blockCode);

    if (!blockCode) {
      return res.status(400).json({ error: "blockCode is required." });
    }

    // ✅ PostgreSQL: result.rows (NOT destructured [rows])
    const result = await db.query(
      `SELECT * FROM (
       SELECT
        o.application_id,
        o.application_id AS target_application_id,
         o.organisation_name,
         o.type_of_connection,
         o.block,
         o.block_code,
         o.village,
         o.gram_panchayat,
         o.habitation,
         o.district,
         o.name,
         o.mobile_number,
         o.water_requirement,
         o.application_status,
         o.meter_id,
         o.type_of_connection_rwss,
         o.name_of_project,
         o.tapping_point,
         o.initial_meter_reading,
         o.meter_make,
         o.connection_details_updated_on,
         NULL::text AS original_application_id,
         NULL::text AS amendment_new_type_of_connection,
         NULL::text AS amendment_new_water_requirement
       FROM organisation o
       WHERE o.block_code = $1::integer
         AND UPPER(o.application_status::TEXT) IN ('PAYMENT_RECEIPT_VERIFIED', 'PAYMENT_RECEIPT_VERIFIED_FOR_TRANSFER')
       UNION ALL
       SELECT
         request.application_id,
         request.original_application_id AS target_application_id,
         request.organisation_name,
         request.new_type_of_connection AS type_of_connection,
         request.block,
         request.block_code,
         request.village,
         request.gram_panchayat,
         request.habitation,
         request.district,
         request.name,
         request.mobile_number,
         request.new_water_requirement AS water_requirement,
         request.application_status,
         original.meter_id,
         original.type_of_connection_rwss,
         original.name_of_project,
         original.tapping_point,
         original.initial_meter_reading,
         original.meter_make,
         original.connection_details_updated_on,
         request.original_application_id,
         request.new_type_of_connection,
         request.new_water_requirement
       FROM organisation request
       INNER JOIN organisation original
         ON original.application_id = request.original_application_id
       WHERE request.block_code = $1::integer
         AND request.request_type = 'AMENDMENT'
         AND UPPER(request.application_status::TEXT) = 'AMENDMENT_APPROVED'
       ) applications
       ORDER BY applications.application_id DESC`,
      [blockCode]
    );

    //console.log("Rows found:", result.rows.length);
    if (result.rows.length > 0) {
      //console.log("Sample row:", result.rows[0]);
    } else {
      // ✅ Extra debug: check if block_code exists at all (any status)
      const debugResult = await db.query(
        `SELECT application_id, block_code, application_status::TEXT
         FROM organisation
         WHERE block_code = $1::integer
         LIMIT 5`,
        [blockCode]
      );

      // ✅ Extra debug: check all PAYMENT_RECEIPT_VERIFIED rows
      const statusResult = await db.query(
        `SELECT application_id, block_code, application_status::TEXT
         FROM organisation
         WHERE UPPER(application_status::TEXT) = 'PAYMENT_RECEIPT_VERIFIED'
         LIMIT 5`
      );
    }

    return res.json({ data: result.rows });
  } catch (err) {
    console.error("getApplicationsForConnectionUpdate error:", err);
    return res.status(500).json({ error: "Failed to fetch applications.", detail: err.message });
  }
};

// POST /api/officer/connection-details/update
const updateConnectionDetails = async (req, res) => {
  const client = await db.connect();

  try {
    const {
      applicationId,
      typeOfConnectionRwss,
      nameOfProject,
      tappingPoint,
      meterId,
      initialMeterReading,
      meterMake,
    } = req.body;

    

    if (!applicationId) {
      return res.status(400).json({ error: "applicationId is required." });
    }

    // ✅ PostgreSQL syntax: $1 placeholder, result.rows
    await client.query("BEGIN");

    const fetchResult = await client.query(
            `SELECT application_id, type_of_connection, block_code, consumer_id, application_status::TEXT,
              transfer_user_flag,
              original_application_id, new_type_of_connection, new_water_requirement
       FROM organisation
       WHERE application_id = $1
       FOR UPDATE`,
      [applicationId]
    );

    if (fetchResult.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Application not found." });
    }

    let app = fetchResult.rows[0];
    const isApprovedAmendment = app.application_status.toUpperCase() === "AMENDMENT_APPROVED";
    const isTransferApplication = app.application_status.toUpperCase() === "PAYMENT_RECEIPT_VERIFIED_FOR_TRANSFER";
    const targetApplicationId = app.transfer_user_flag ? app.application_id : (app.original_application_id || app.application_id);

    if (app.original_application_id && !isTransferApplication) {
      const originalResult = await client.query(
        `SELECT application_id, type_of_connection, block_code, consumer_id, application_status::TEXT
         FROM organisation
         WHERE application_id = $1
         FOR UPDATE`,
        [app.original_application_id]
      );
      if (originalResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Original connection application not found." });
      }
      app = {
        ...originalResult.rows[0],
        original_application_id: fetchResult.rows[0].original_application_id,
        request_application_id: fetchResult.rows[0].application_id,
        new_type_of_connection: fetchResult.rows[0].new_type_of_connection,
        new_water_requirement: fetchResult.rows[0].new_water_requirement,
        request_status: fetchResult.rows[0].application_status,
      };
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `consumer:${String(app.block_code).trim()}`,
    ]);

    const statusToValidate = app.request_status || app.application_status;
    if (statusToValidate.toUpperCase() !== "PAYMENT_RECEIPT_VERIFIED" && statusToValidate.toUpperCase() !== "PAYMENT_RECEIPT_VERIFIED_FOR_TRANSFER" && !isApprovedAmendment) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        error: "Connection details can only be updated for payment-verified or approved amendment applications.",
      });
    }

    const effectiveTypeOfConnection = isApprovedAmendment
      ? app.new_type_of_connection || app.type_of_connection
      : app.type_of_connection;
    const isSingleTap = String(effectiveTypeOfConnection || "").toLowerCase().trim() === "single tap";


    // ✅ Build query based on connection type
    if (isSingleTap) {
      await client.query(
        `UPDATE organisation
         SET
           type_of_connection          = CASE WHEN $4 THEN $5 ELSE type_of_connection END,
           water_requirement            = CASE WHEN $4 THEN $6 ELSE water_requirement END,
           type_of_connection_rwss       = $1,
           name_of_project               = $2,
           tapping_point                 = $3,
           meter_id                      = NULL,
           initial_meter_reading         = NULL,
           meter_make                    = NULL,
           application_status            = 'CONNECTION_DETAILS_UPDATED',
           update_on = NOW()
         WHERE application_id = $7`,
        [
          "Unmetered",
          nameOfProject || null,
          tappingPoint  || null,
          isApprovedAmendment,
          app.new_type_of_connection || null,
          app.new_water_requirement || null,
          targetApplicationId,
        ]
      );
    } else if (typeOfConnectionRwss === "Metered") {
      await client.query(
        `UPDATE organisation
         SET
           type_of_connection          = CASE WHEN $6 THEN $7 ELSE type_of_connection END,
           water_requirement            = CASE WHEN $6 THEN $8 ELSE water_requirement END,
           type_of_connection_rwss       = $1,
           meter_id                      = $2,
           initial_meter_reading         = $3,
           meter_make                    = $4,
           name_of_project               = NULL,
           tapping_point                 = NULL,
           application_status            = 'CONNECTION_DETAILS_UPDATED',
           update_on = NOW()
         WHERE application_id = $5`,
        [
          "Metered",
          meterId            || null,
          initialMeterReading || null,
          meterMake          || null,
          targetApplicationId,
          isApprovedAmendment,
          app.new_type_of_connection || null,
          app.new_water_requirement || null,
        ]
      );
    } else {
      // Unmetered (multi-tap)
      await client.query(
        `UPDATE organisation
         SET
           type_of_connection          = CASE WHEN $4 THEN $5 ELSE type_of_connection END,
           water_requirement            = CASE WHEN $4 THEN $6 ELSE water_requirement END,
           type_of_connection_rwss       = $1,
           name_of_project               = $2,
           tapping_point                 = $3,
           meter_id                      = NULL,
           initial_meter_reading         = NULL,
           meter_make                    = NULL,
           application_status            = 'CONNECTION_DETAILS_UPDATED',
           update_on = NOW()
         WHERE application_id = $7`,
        [
          "Unmetered",
          nameOfProject || null,
          tappingPoint  || null,
          isApprovedAmendment,
          app.new_type_of_connection || null,
          app.new_water_requirement || null,
          targetApplicationId,
        ]
      );
    }

    if (isApprovedAmendment && app.request_application_id) {
      await client.query(
        `UPDATE organisation
         SET application_status = 'CONNECTION_DETAILS_UPDATED',
             update_on = NOW()
         WHERE application_id = $1`,
        [app.request_application_id]
      );
    }

    let consumerId = app.consumer_id;
    if (!consumerId) {
      const prefix = `CI${String(app.block_code).trim()}`;
      const serialResult = await client.query(
        `SELECT COALESCE(MAX(SUBSTRING(consumer_id FROM '[0-9]+$')::INTEGER), 0) AS last_serial
         FROM organisation
         WHERE consumer_id LIKE $1 || '%'
           AND consumer_id ~ ('^' || $1 || '[0-9]{5}$')`,
        [prefix]
      );

      const nextSerial = Number(serialResult.rows[0]?.last_serial || 0) + 1;
      consumerId = `${prefix}${String(nextSerial).padStart(5, "0")}`;

      await client.query(
        `UPDATE organisation
         SET consumer_id = $1
         WHERE application_id = $2`,
        [consumerId, targetApplicationId]
      );
    }

    await client.query("COMMIT");

// inside updateConnectionDetails, after the UPDATE query succeeds:
await saveApplicationHistory(
  targetApplicationId,
  req.body.officerId || null,                    // JE officer updating connection
  null,
  "CONNECTION_DETAILS_UPDATED",
  app.application_status,                        // old status (fetched earlier)
  "CONNECTION_DETAILS_UPDATED",
  null
);

    await handleSlaOnStatusChange({
      applicationId: targetApplicationId,
      newStatus: "CONNECTION_DETAILS_UPDATED",
      actorUserId: req.body.officerId || null,
      assignedTo: req.body?.assignedTo ?? req.body?.assigned_to ?? null,
    });

    // Trigger API-9 for Odisha One when CONNECTION_DETAILS_UPDATED
    pushApplicationStatusToOdishaOne(applicationId, "CONNECTION_DETAILS_UPDATED", "").catch((err) => {
      console.error("API-9 CONNECTION_DETAILS_UPDATED push error:", err.message);
    });

    return res.json({
      message: "Connection details updated successfully.",
      targetApplicationId,
      consumerId,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("updateConnectionDetails error:", err);
    return res.status(500).json({ error: "Failed to update connection details.", detail: err.message });
  } finally {
    client.release();
  }
};

const getApplicationsForDisconnection = async (req, res) => {
  try {
    const { blockCode } = req.query;
    if (!blockCode) return res.status(400).json({ error: "blockCode is required." });

    const result = await db.query(
      `SELECT application_id, organisation_name, type_of_connection, block, block_code,
              village, gram_panchayat, habitation, district, name, mobile_number,
              water_requirement, application_status, preferred_disconnection_date,
              approved_on
       FROM organisation
       WHERE block_code = $1::integer
         AND UPPER(application_status::text) = 'PAYMENT_RECEIPT_VERIFIED_FOR_CANCELLATION'
       ORDER BY approved_on DESC NULLS LAST, created_at DESC`,
      [blockCode]
    );

    return res.json({ data: result.rows });
  } catch (err) {
    console.error("getApplicationsForDisconnection error:", err);
    return res.status(500).json({ error: "Failed to fetch disconnection applications.", detail: err.message });
  }
};

const disconnectWaterConnection = async (req, res) => {
  const { applicationId, disconnectionDate, disconnectionRemarks, officerId } = req.body;
  if (!applicationId) return res.status(400).json({ error: "applicationId is required." });
  if (!disconnectionDate) return res.status(400).json({ error: "disconnectionDate is required." });

  try {
    const current = await db.query(
      `SELECT application_id, application_status::text AS application_status
       FROM organisation WHERE application_id = $1 LIMIT 1`,
      [applicationId]
    );
    if (current.rowCount === 0) return res.status(404).json({ error: "Application not found." });
    const currentStatus = current.rows[0].application_status;
    const allowedDisconnectStatuses = ["PAYMENT_RECEIPT_VERIFIED_FOR_CANCELLATION"];
    if (!allowedDisconnectStatuses.includes(currentStatus)) {
      return res.status(400).json({ error: "Only cancellation applications with verified payment receipts can be disconnected." });
    }

    const result = await db.query(
      `UPDATE organisation
       SET disconnection_date = $1,
           disconnection_remarks = $2,
           application_status = 'CONNECTION_DISCONNECTED',
           update_on = NOW()
       WHERE application_id = $3
       RETURNING application_id, application_status, disconnection_date, disconnection_remarks`,
      [disconnectionDate, disconnectionRemarks || null, applicationId]
    );

    await saveApplicationHistory(
      applicationId,
      officerId || null,
      null,
      "CONNECTION_DISCONNECTED",
      currentStatus,
      "CONNECTION_DISCONNECTED",
      disconnectionRemarks || null
    );

    await handleSlaOnStatusChange({
      applicationId,
      newStatus: "CONNECTION_DISCONNECTED",
      actorUserId: officerId || null,
      assignedTo: null,
    });

    return res.json({ message: "Water connection disconnected successfully.", data: result.rows[0] });
  } catch (err) {
    console.error("disconnectWaterConnection error:", err);
    return res.status(500).json({ error: "Failed to disconnect water connection.", detail: err.message });
  }
};

module.exports = {
  getApplicationsForConnectionUpdate,
  updateConnectionDetails,
  getApplicationsForDisconnection,
  disconnectWaterConnection,
};
