// controllers/updateConnectionDetailsController.js

const db = require("../db/db"); // ✅ matches your server.js path
const { saveApplicationHistory } = require("./historyController");
const { handleSlaOnStatusChange } = require("./slaTrackingController");

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
      `SELECT
         o.application_id,
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
         o.connection_details_updated_on
       FROM organisation o
       WHERE o.block_code = $1::integer
         AND UPPER(o.application_status::TEXT) = 'PAYMENT_RECEIPT_VERIFIED'
       ORDER BY o.created_at DESC`,
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
    const fetchResult = await db.query(
      `SELECT application_id, type_of_connection, application_status::TEXT
       FROM organisation
       WHERE application_id = $1`,
      [applicationId]
    );

    if (fetchResult.rows.length === 0) {
      return res.status(404).json({ error: "Application not found." });
    }

    const app = fetchResult.rows[0];

    if (app.application_status.toUpperCase() !== "PAYMENT_RECEIPT_VERIFIED") {
      return res.status(400).json({
        error: "Connection details can only be updated for PAYMENT_RECEIPT_VERIFIED applications.",
      });
    }

    const isSingleTap =
      String(app.type_of_connection || "").toLowerCase().trim() === "single tap";


    // ✅ Build query based on connection type
    if (isSingleTap) {
      await db.query(
        `UPDATE organisation
         SET
           type_of_connection_rwss       = $1,
           name_of_project               = $2,
           tapping_point                 = $3,
           meter_id                      = NULL,
           initial_meter_reading         = NULL,
           meter_make                    = NULL,
           application_status            = 'CONNECTION_DETAILS_UPDATED',
           update_on = NOW()
         WHERE application_id = $4`,
        [
          "Unmetered",
          nameOfProject || null,
          tappingPoint  || null,
          applicationId,
        ]
      );
    } else if (typeOfConnectionRwss === "Metered") {
      await db.query(
        `UPDATE organisation
         SET
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
          applicationId,
        ]
      );
    } else {
      // Unmetered (multi-tap)
      await db.query(
        `UPDATE organisation
         SET
           type_of_connection_rwss       = $1,
           name_of_project               = $2,
           tapping_point                 = $3,
           meter_id                      = NULL,
           initial_meter_reading         = NULL,
           meter_make                    = NULL,
           application_status            = 'CONNECTION_DETAILS_UPDATED',
           update_on = NOW()
         WHERE application_id = $4`,
        [
          "Unmetered",
          nameOfProject || null,
          tappingPoint  || null,
          applicationId,
        ]
      );
    }

// inside updateConnectionDetails, after the UPDATE query succeeds:
await saveApplicationHistory(
  applicationId,
  req.body.officerId || null,                    // JE officer updating connection
  null,
  "CONNECTION_DETAILS_UPDATED",
  app.application_status,                        // old status (fetched earlier)
  "CONNECTION_DETAILS_UPDATED",
  null
);

    await handleSlaOnStatusChange({
      applicationId,
      newStatus: "CONNECTION_DETAILS_UPDATED",
      actorUserId: req.body.officerId || null,
      assignedTo: req.body?.assignedTo ?? req.body?.assigned_to ?? null,
    });

    return res.json({
      message: "Connection details updated successfully.",
      applicationId,
    });
  } catch (err) {
    console.error("updateConnectionDetails error:", err);
    return res.status(500).json({ error: "Failed to update connection details.", detail: err.message });
  }
};

module.exports = {
  getApplicationsForConnectionUpdate,
  updateConnectionDetails,
};
