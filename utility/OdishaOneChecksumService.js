const crypto = require("crypto");

/**
 * Calculates SHA-512 checksum according to Odisha One specification (Section 6.2):
 * Format: departmentId|"val1"|"val2"|...|checksumKey
 * - First element: departmentId (unquoted)
 * - Middle elements: Each JSON parameter value (except CHECKSUM) wrapped in double quotes
 * - Last element: checksumKey (unquoted)
 * - Algorithm: SHA-512 in lowercase hex
 */
function generateChecksum(paramArray, deptId, checksumKey) {
  if (!paramArray || typeof paramArray !== "object") return "";

  const effectiveDeptId = deptId || paramArray.DEPARTEMENTID || process.env.ODISHA_ONE_DEPARTMENT_ID;
  const effectiveChecksumKey = checksumKey || process.env.ODISHA_ONE_CHECKSUM_KEY;

  const keys = Object.keys(paramArray).filter((k) => k !== "CHECKSUM");
  const quotedValues = [];

  for (const key of keys) {
    const value = paramArray[key];
    let strValue = "";

    if (value === null || value === undefined) {
      strValue = "";
    } else if (typeof value === "object") {
      // Convert nested objects/arrays (e.g. TPIURLS) to unescaped JSON string
      strValue = JSON.stringify(value).replace(/\\\//g, "/");
    } else {
      strValue = String(value);
    }

    quotedValues.push(`"${strValue}"`);
  }

  const hashString = `${effectiveDeptId}|${quotedValues.join("|")}|${effectiveChecksumKey}`;
  return crypto.createHash("sha512").update(hashString, "utf-8").digest("hex");
}

/**
 * Compares received checksum against calculated checksum (case-insensitive)
 */
function verifyChecksum(paramArray, deptId, checksumKey, receivedChecksum) {
  if (!receivedChecksum) return false;
  const calculated = generateChecksum(paramArray, deptId, checksumKey);
  return calculated.toLowerCase() === String(receivedChecksum).toLowerCase();
}

module.exports = {
  generateChecksum,
  verifyChecksum,
};

