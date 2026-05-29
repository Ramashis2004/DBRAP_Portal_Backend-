const pool = require("../db/db");

const getActionName = (method, url) => {
  const cleanPath = url.split("?")[0];
  
  if (method === "POST") {
    if (cleanPath.includes("/register")) return "Register Organisation";
    if (cleanPath.includes("/upload")) return "Upload Payment Receipt";
    if (cleanPath.includes("/update")) return "Update Connection Details";
    if (cleanPath.includes("/login")) return "User Login";
    if (cleanPath.includes("/applicant/register")) return "Register Applicant";
    if (cleanPath.includes("/check-mobile")) return "Check Mobile";
  } else if (method === "PATCH") {
    if (cleanPath.includes("/verify")) return "Verify Payment";
    if (cleanPath.includes("/application-status")) return "Update Application Status";
    if (cleanPath.includes("/status")) return "Update Status";
    if (cleanPath.includes("/site-visit-report")) return "Upload Site Visit Report";
  } else if (method === "PUT") {
    return `Update resources at ${cleanPath}`;
  } else if (method === "DELETE") {
    return `Delete resources at ${cleanPath}`;
  }
  
  return `${method} request to ${cleanPath}`;
};

const activityLogMiddleware = (req, res, next) => {
  const { method, originalUrl } = req;
  const allowedMethods = ["POST", "PUT", "PATCH", "DELETE"];

  // Only proceed with logging logic if the method is POST, PUT, PATCH, or DELETE
  if (!allowedMethods.includes(method)) {
    return next();
  }

  // Intercept the completion of the response
  res.on("finish", async () => {
    // We only log if loginHistoryId is available on the request (meaning an authenticated request)
    if (req.loginHistoryId) {
      try {
        const action = req.actionPerformed || getActionName(method, originalUrl);
        const statusCode = res.statusCode;

        await pool.query(
          `
            INSERT INTO login_activity_logs (
              login_history_id, api_endpoint, http_method, response_status_code, action_performed
            )
            VALUES ($1, $2, $3, $4, $5)
          `,
          [
            req.loginHistoryId,
            originalUrl,
            method,
            statusCode,
            action
          ]
        );
      } catch (error) {
        console.error("Error writing login activity log:", error);
      }
    }
  });

  next();
};

module.exports = activityLogMiddleware;
