const crypto = require("crypto");
const pool = require("../db/db");

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_HASH_PREFIX = "";

const hashPassword = (plainPassword) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const derivedKey = crypto.scryptSync(plainPassword, salt, 64).toString("hex");
  return `${PASSWORD_HASH_PREFIX}$${salt}$${derivedKey}`;
};

const verifyPassword = (plainPassword, storedPassword) => {
  if (!storedPassword || !plainPassword) {
    return false;
  }

  const stored = String(storedPassword).trim();

  if (stored.startsWith("$")) {
    const [, salt, storedHash] = stored.split("$");
    if (!salt || !storedHash) {
      return false;
    }

    try {
      const derivedKey = crypto.scryptSync(plainPassword, salt, 64).toString("hex");
      return crypto.timingSafeEqual(
        Buffer.from(storedHash, "hex"),
        Buffer.from(derivedKey, "hex")
      );
    } catch {
      return false;
    }
  }

  if (/^[0-9a-f]{128}$/i.test(stored)) {
    const sha512Hash = crypto.createHash("sha512").update(plainPassword).digest("hex");

    try {
      return crypto.timingSafeEqual(
        Buffer.from(stored.toLowerCase(), "hex"),
        Buffer.from(sha512Hash, "hex")
      );
    } catch {
      return false;
    }
  }

  return stored === plainPassword;
};

const validateNewPassword = (newPassword) => {
  if (!newPassword || newPassword.length < PASSWORD_MIN_LENGTH) {
    return `New password must be at least ${PASSWORD_MIN_LENGTH} characters long`;
  }

  if (!/[A-Z]/.test(newPassword)) {
    return "New password must contain at least one uppercase letter";
  }

  if (!/[a-z]/.test(newPassword)) {
    return "New password must contain at least one lowercase letter";
  }

  if (!/\d/.test(newPassword)) {
    return "New password must contain at least one number";
  }

  if (!/[!@#$%^&*(),.?":{}|<>_\-+=/\\[\]~`';]/.test(newPassword)) {
    return "New password must contain at least one special character";
  }

  return "";
};

const changePassword = async (req, res) => {
  try {
    const userId = req.user?.id;
    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    const confirmPassword = String(req.body?.confirmPassword || "");

    if (!userId) {
      return res.status(401).json({ error: "Invalid session. Please log in again." });
    }

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({ error: "Current password, new password, and confirm password are required" });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({ error: "New password and confirm password do not match" });
    }

    const passwordError = validateNewPassword(newPassword);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }

    const result = await pool.query(
      `
        SELECT id, password
        FROM user_master
        WHERE id = $1
          AND COALESCE(active_flag, 'Y') = 'Y'
        LIMIT 1
      `,
      [userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "User account not found or inactive" });
    }

    const user = result.rows[0];

    if (!verifyPassword(currentPassword, user.password)) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    if (verifyPassword(newPassword, user.password)) {
      return res.status(400).json({ error: "New password must be different from the current password" });
    }

    await pool.query(
      `
        UPDATE user_master
        SET password = $1,
            passwordchange_flag = 'Y'
        WHERE id = $2
      `,
      [hashPassword(newPassword), userId]
    );

    return res.status(200).json({
      message: "Password changed successfully",
      passwordChangeRequired: false,
    });
  } catch (error) {
    console.error("Change password error:", error);
    return res.status(500).json({ error: "Server Error" });
  }
};

module.exports = {
  changePassword,
};
