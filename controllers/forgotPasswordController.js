

const crypto = require("crypto");
const pool   = require("../db/db"); // same pool your existing code uses

// ── Re-use helpers from your existing officerController ──────────────────────
const MOBILE_REGEX = /^[6-9]\d{9}$/;

const hashPassword = (plainPassword) => {
  const salt       = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(plainPassword, salt, 64).toString("hex");
  return `$${salt}$${derivedKey}`;
};

// ── SMS config (mirrors your existing env vars) ───────────────────────────────
const SMS_API_URL        = process.env.SMS_API_URL        || "https://govtsms.odisha.gov.in/api/api.php";
const SMS_DEPARTMENT_ID  = process.env.SMS_DEPARTMENT_ID  || "D047009";
const SMS_SOURCE         = process.env.SMS_SOURCE         || "ODIGOV";
const SMS_TEMPLATE_ID    = process.env.SMS_OTP_TEMPLATE_ID || process.env.SMS_CREDENTIAL_TEMPLATE_ID || "1007529288081313959";
const SMS_ACTION         = process.env.SMS_OTP_ACTION     || "sendOTPSMS";
const SMS_ENABLED        = process.env.SMS_ENABLED        !== "false";
const SMS_TIMEOUT_MS     = Number(process.env.SMS_TIMEOUT_MS) || 10000;

// ── In-memory OTP store ───────────────────────────────────────────────────────
// Structure: {
//   username → {
//     otp,
//     expiresAt,
//     mobileNo,
//     verified,
//     resendAvailableAt,
//     resendBlockedUntil
//   }
// }
const otpSessionStore = new Map();

const OTP_TTL_MS     = 10 * 60 * 1000; // 10 minutes
const OTP_MAX_DIGITS = 6;
const OTP_RESEND_COOLDOWN_MS = 25 * 1000;
const OTP_MAX_SEND_ATTEMPTS = 3;
const OTP_RESEND_LOCKOUT_MS = 30 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────────────────────────
const generateOtp = () =>
  String(Math.floor(Math.random() * 10 ** OTP_MAX_DIGITS)).padStart(OTP_MAX_DIGITS, "0");

const normalizeMobile = (n) => String(n || "").trim().replace(/\D/g, "");

const fetchWithTimeout = async (url, options, timeoutMs) => {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === "AbortError")
      throw new Error(`SMS gateway timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
};

const sendOtpSms = async ({ mobileNo, otp }) => {
  if (!SMS_ENABLED) return "SMS disabled";

  const normalized = normalizeMobile(mobileNo);
  if (!MOBILE_REGEX.test(normalized))
    throw new Error("Invalid mobile number");

  const payload = new URLSearchParams({
    template_id:   SMS_TEMPLATE_ID,
    phonenumber:   normalized,
    department_id: SMS_DEPARTMENT_ID,
    action:        SMS_ACTION,
    source:        SMS_SOURCE,
    sms_content:   `Your OTP for Gramsewa Nidhi Portal is ${otp}. Please do not share this with anyone. Panchayati Raj & Drinking Water Dept. – Govt. of Odisha`,
  });

  const response = await fetchWithTimeout(
    SMS_API_URL,
    { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: payload.toString() },
    SMS_TIMEOUT_MS
  );

  if (!response.ok) throw new Error(`SMS service returned ${response.status}`);

  const text = (await response.text()).trim();
  if (/error|fail|invalid|reject/i.test(text))
    throw new Error(`SMS service rejected request: ${text}`);

  return text;
};

// ── Step 1: Send OTP ──────────────────────────────────────────────────────────
const sendOtp = async (req, res) => {
  try {
    const { username } = req.body;

    if (!username || !String(username).trim()) {
      return res.status(400).json({ error: "Officer ID / Username is required" });
    }

    const trimmed = String(username).trim();
    const existingEntry = otpSessionStore.get(trimmed);
    const now = Date.now();

    if (existingEntry?.resendBlockedUntil && now < existingEntry.resendBlockedUntil) {
      const retryAfterSeconds = Math.ceil((existingEntry.resendBlockedUntil - now) / 1000);
      return res.status(429).json({
        error: "You have exceed your time limit of send OTP try after 30 minutes.",
        resendBlocked: true,
        retryAfterSeconds,
      });
    }

    if (existingEntry?.resendAvailableAt && now < existingEntry.resendAvailableAt) {
      const retryAfterSeconds = Math.ceil((existingEntry.resendAvailableAt - now) / 1000);
      return res.status(429).json({
        error: `Please wait ${retryAfterSeconds} seconds before resending OTP.`,
        resendBlocked: false,
        retryAfterSeconds,
      });
    }

    // Look up the officer by login_id
    const result = await pool.query(
      `
        SELECT id, login_id, mobile_no, active_flag, COALESCE(user_otp_count, 0) AS user_otp_count
        FROM user_master
        WHERE login_id = $1
        LIMIT 1
      `,
      [trimmed]
    );

    if (result.rows.length === 0) {
      // Generic message — don't reveal whether user exists
      return res.status(404).json({ error: "No officer account found with that ID" });
    }

    const officer = result.rows[0];
    let currentSendCount = Number(officer.user_otp_count || 0);

    if (officer.active_flag !== "Y") {
      return res.status(403).json({ error: "Your account is inactive. Contact administrator." });
    }

    const mobileNo = normalizeMobile(officer.mobile_no);
    if (!MOBILE_REGEX.test(mobileNo)) {
      return res.status(400).json({
        error: "No valid mobile number on record. Contact administrator.",
      });
    }

    if (currentSendCount >= OTP_MAX_SEND_ATTEMPTS) {
      if (existingEntry?.resendBlockedUntil && now < existingEntry.resendBlockedUntil) {
        const retryAfterSeconds = Math.ceil((existingEntry.resendBlockedUntil - now) / 1000);
        return res.status(429).json({
          error: "You have exceed your time limit of send OTP try after 30 minutes.",
          resendBlocked: true,
          retryAfterSeconds,
        });
      }

      currentSendCount = 0;
      await pool.query(
        `
          UPDATE user_master
          SET user_otp_count = 0,
              user_otp = NULL
          WHERE login_id = $1
        `,
        [trimmed]
      );
    }

    const otp = generateOtp();
    console.log(`[OTP DEBUG] Generated OTP for user "${trimmed}": ${otp}`);
    const nextSendCount = currentSendCount + 1;
    const isLockedOutAfterThisSend = nextSendCount >= OTP_MAX_SEND_ATTEMPTS;
    const resendAvailableAt = isLockedOutAfterThisSend ? now + OTP_RESEND_LOCKOUT_MS : now + OTP_RESEND_COOLDOWN_MS;

    // Store OTP (overwrite any previous entry for this username)
    otpSessionStore.set(trimmed, {
      expiresAt: Date.now() + OTP_TTL_MS,
      verified: false,
      resendAvailableAt,
      resendBlockedUntil: isLockedOutAfterThisSend ? now + OTP_RESEND_LOCKOUT_MS : 0,
    });

    await pool.query(
      `
        UPDATE user_master
        SET user_otp = $1,
            user_otp_count = $2
        WHERE login_id = $3
      `,
      [otp, nextSendCount, trimmed]
    );

    // Auto-cleanup after TTL
    setTimeout(() => {
      const entry = otpSessionStore.get(trimmed);
      if (entry && !entry.verified) otpSessionStore.delete(trimmed);
    }, OTP_TTL_MS);

    let smsSent = true;
    try {
      await sendOtpSms({ mobileNo, otp });
    } catch (smsErr) {
      smsSent = false;
      console.error("Forgot-password SMS error:", smsErr.message);
    }

    // Mask mobile: show last 4 digits only
    const maskedMobile = `XXXXXX${mobileNo.slice(-4)}`;

    return res.status(200).json({
      message: smsSent
        ? `OTP sent to registered mobile number ${maskedMobile}`
        : "OTP generated but SMS delivery failed. Contact administrator.",
      maskedMobile,
      smsSent,
      resendAfterSeconds: isLockedOutAfterThisSend ? Math.ceil(OTP_RESEND_LOCKOUT_MS / 1000) : Math.ceil(OTP_RESEND_COOLDOWN_MS / 1000),
      resendBlocked: isLockedOutAfterThisSend,
      retryAfterSeconds: isLockedOutAfterThisSend ? Math.ceil(OTP_RESEND_LOCKOUT_MS / 1000) : Math.ceil(OTP_RESEND_COOLDOWN_MS / 1000),
      sendCount: nextSendCount,
    });
  } catch (err) {
    console.error("sendOtp error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

// ── Step 2: Verify OTP ────────────────────────────────────────────────────────
const verifyOtp = async (req, res) => {
  try {
    const { username, otp } = req.body;

    if (!username || !otp) {
      return res.status(400).json({ error: "Username and OTP are required" });
    }

    const trimmedUsername = String(username).trim();
    const trimmedOtp      = String(otp).trim();

    const entry = otpSessionStore.get(trimmedUsername);

    if (!entry) {
      return res.status(400).json({ error: "No OTP request found. Please request a new OTP." });
    }

    const storedResult = await pool.query(
      `
        SELECT COALESCE(user_otp, '') AS user_otp
        FROM user_master
        WHERE login_id = $1
        LIMIT 1
      `,
      [trimmedUsername]
    );

    if (storedResult.rows.length === 0 || !storedResult.rows[0].user_otp) {
      otpSessionStore.delete(trimmedUsername);
      return res.status(400).json({ error: "No OTP request found. Please request a new OTP." });
    }

    if (Date.now() > entry.expiresAt) {
      otpSessionStore.delete(trimmedUsername);
      return res.status(400).json({ error: "OTP has expired. Please request a new one." });
    }

    if (storedResult.rows[0].user_otp !== trimmedOtp) {
      return res.status(400).json({ error: "Incorrect OTP. Please try again." });
    }

    // Mark as verified so the reset step is unlocked
    entry.verified = true;
    otpSessionStore.set(trimmedUsername, entry);

    return res.status(200).json({ message: "OTP verified successfully" });
  } catch (err) {
    console.error("verifyOtp error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

// ── Step 3: Reset Password ────────────────────────────────────────────────────
const resetPassword = async (req, res) => {
  try {
    const { username, otp, newPassword } = req.body;

    if (!username || !otp || !newPassword) {
      return res.status(400).json({ error: "Username, OTP, and new password are required" });
    }

    const trimmedUsername = String(username).trim();
    const trimmedOtp      = String(otp).trim();
    const trimmedPassword = String(newPassword).trim();

    if (trimmedPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }

    const entry = otpSessionStore.get(trimmedUsername);

    if (!entry) {
      return res.status(400).json({ error: "Session expired. Please start the process again." });
    }

    const storedResult = await pool.query(
      `
        SELECT COALESCE(user_otp, '') AS user_otp
        FROM user_master
        WHERE login_id = $1
        LIMIT 1
      `,
      [trimmedUsername]
    );

    if (storedResult.rows.length === 0 || !storedResult.rows[0].user_otp) {
      otpSessionStore.delete(trimmedUsername);
      return res.status(400).json({ error: "Session expired. Please start the process again." });
    }

    if (Date.now() > entry.expiresAt) {
      otpSessionStore.delete(trimmedUsername);
      return res.status(400).json({ error: "OTP has expired. Please request a new one." });
    }

    if (!entry.verified || storedResult.rows[0].user_otp !== trimmedOtp) {
      return res.status(400).json({ error: "OTP verification failed. Please verify OTP first." });
    }

    const hashedPassword = hashPassword(trimmedPassword);

    const updateResult = await pool.query(
      `
        UPDATE user_master
        SET password             = $1,
            passwordchange_flag  = 'Y',
            user_otp_count       = 0,
            user_otp             = NULL
        WHERE login_id = $2
          AND COALESCE(active_flag, 'N') = 'Y'
        RETURNING id, login_id
      `,
      [hashedPassword, trimmedUsername]
    );

    if (updateResult.rows.length === 0) {
      return res.status(404).json({ error: "Officer account not found or inactive" });
    }

    // Clear OTP entry after successful reset
    otpSessionStore.delete(trimmedUsername);

    return res.status(200).json({ message: "Password reset successfully. You can now log in." });
  } catch (err) {
    console.error("resetPassword error:", err);
    return res.status(500).json({ error: "Server error" });
  }
};

module.exports = { sendOtp, verifyOtp, resetPassword };
