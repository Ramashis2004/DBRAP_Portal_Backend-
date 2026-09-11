require("dotenv").config();
const path = require("path");
const fs = require("fs").promises;
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const crypto = require("crypto");
const pool = require("./db/db");

const userManualRouter = require("./routes/userManualRoutes");
const notificationRoutes = require("./routes/notificationRoutes");
const authRoutes = require("./routes/authRoutes");
const passwordRoutes = require("./routes/changePasswordRoutes");
const organisationRoutes = require("./routes/organisationRoutes");
const applicationReceivedRoutes = require("./routes/applicationReceivedRoutes");
const ceApplicationReceivedRoutes = require("./routes/ceApplicationReceivedRoutes");
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
const aeeDashboardApplicationsRoutes = require("./routes/aeeDashboardApplicationsRoutes");
const ceDashboardApplicationsRoutes = require("./routes/ceDashboardApplicationsRoutes");
const ceDashboardOverdueRoutes = require("./routes/ceDashboardOverdueRoutes");
const eicDashboardApplicationsRoutes = require("./routes/eicDashboardApplicationsRoutes");
const eicDashboardOverdueRoutes = require("./routes/eicDashboardOverdueRoutes");
const slaConfigRoutes = require("./routes/slaConfigRoutes");
const slaTrackingRoutes = require("./routes/slaTrackingRoutes");
const publicDashboardRoutes = require("./routes/publicDashboardRoutes");
const odishaOneRoutes = require("./routes/odishaOneRoutes");
const tpiRoutes = require("./routes/tpiRoutes");
const { cePendingRouter, eicPendingRouter } = require("./routes/pendingPieChartRoutes");
const seDashboardStatusCountRoutes = require("./routes/seDashboardStatusCountRoutes");
const aeeStatusCountRoutes = require("./routes/aeeStatusCountRoutes");
const authMiddleware = require("./middlewares/authMiddleware");
const activityLogMiddleware = require("./middlewares/activityLogMiddleware");
   
const app = express();

// ==========================================
// SECURITY FIXES FOR HCL APPSCAN FINDINGS
// ==========================================

// ISSUE 8 FIX: Disable X-Powered-By header leak
app.disable("x-powered-by");

// ISSUE 5 FIX: Restrict CORS with safe fallback
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(url => url.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin) || origin.startsWith("http://10.172.32.252") || origin.startsWith("http://localhost") || origin.startsWith("http://127.0.0.1")) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"]
  })
);

// ODISHA ONE FIX: Domains allowed as cross-origin form POST targets
// (the app builds real <form>/form.submit() redirects to Odisha One's
// CANCELURL / SUCCESSURL endpoints for the TPI integration)
const odishaOneFormActionDomains = (process.env.ODISHA_ONE_FORM_ACTION_DOMAINS || "")
  .split(",")
  .map(url => url.trim())
  .filter(Boolean);

// DYNAMIC NONCE GENERATOR: Generates a unique crypto nonce per HTTP request
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});

// ISSUES 2, 3, 4, 6, 7 FIX: Configure Helmet for React Single Page Applications
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false, // <-- stop Helmet from merging in its own defaults
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        // ALLOW REACT BUNDLES ('self'), INLINE STYLES/SCRIPTS AND NONCES
        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          (req, res) => `'nonce-${res.locals.cspNonce}'`
        ],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "blob:"],
        connectSrc: [
           "'self'","blob:"
          // "http://127.0.0.1:*",
          // "http://10.172.32.252:*",
          // "ws:",
          // "wss:"
        ],
        mediaSrc: ["'self'"],
        workerSrc: ["'self'", "blob:"],
        // ODISHA ONE FIX: allow the TPI cancel/success redirect form posts
        formAction: ["'self'", ...odishaOneFormActionDomains],
        // ALLOW PDF VIEWERS AND IFRAME EMBEDS
        objectSrc: ["'none'"],
        frameSrc: ["'self'", "blob:"],
       
        frameAncestors: ["'none'"],
        requireTrustedTypesFor: ["'script'"],
      }
    },
    crossOriginEmbedderPolicy: true,
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    crossOriginResourcePolicy: { policy: "same-origin" },
    noSniff: true
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ==========================================
// ROUTES & MIDDLEWARES
// ==========================================

// Public routes (No token required)
app.use("/api/user-manual", userManualRouter);
app.use("/api/notification", notificationRoutes);
app.use("/api/auth", authRoutes); // LOGIN ROUTE MUST BE PUBLIC
app.use("/api/applicant-auth", applicantAuthRoutes);
app.use("/api/public-dashboard", publicDashboardRoutes);
app.use("/api/odisha-one", odishaOneRoutes);
app.use("/api/v1/tpi", tpiRoutes);
app.use("/api", forgotPasswordRoute);

// Protected routes (Token required)
app.use(authMiddleware);
app.use(activityLogMiddleware);

app.get("/api/officer/test", (req, res) => {
  res.json({ ok: true });
});
app.use("/api/applicant-payment", applicantPaymentRoutes);
app.use("/api/pending-applications", pendingApplicationsRoutes);
app.use("/api/password", passwordRoutes);

app.use("/api/organisation", organisationRoutes);
app.use("/api/application-received", applicationReceivedRoutes);
app.use("/api/ce-application-received", ceApplicationReceivedRoutes);
app.use("/api/eic-application-received", eicApplicationReceivedRoutes);
app.use("/api/se-payment-details", sePaymentDetailsRoutes);
app.use("/api/je-payment-details", jePaymentDetailsRoutes);
app.use("/api/location", locationRoutes);
app.use("/api/applicant-application", applicantApplicationRoutes);
app.use("/api/history", historyRoutes);
app.use("/api/payment-verification", paymentVerificationRoutes);
app.use("/api/officer", updateConnRoutes);
app.use("/api/se-dashboard-applications", seDashboardApplicationsRoutes);
app.use("/api/aee-dashboard-applications", aeeDashboardApplicationsRoutes);
app.use("/api/ce-dashboard-applications", ceDashboardApplicationsRoutes);
app.use("/api/ce-dashboard", ceDashboardOverdueRoutes);
app.use("/api/eic-dashboard-applications", eicDashboardApplicationsRoutes);
app.use("/api/eic-dashboard", eicDashboardOverdueRoutes);
app.use("/api/sla-config", slaConfigRoutes);
app.use("/api/sla-tracking", slaTrackingRoutes);
app.use("/api/ce-pending", cePendingRouter);
app.use("/api/eic-pending", eicPendingRouter);
app.use("/api/se-dashboard-applications", seDashboardStatusCountRoutes);
app.use("/api/aee-dashboard-applications", aeeStatusCountRoutes);

// Global Error Handler Logger
app.use((err, req, res, next) => {
  console.error("❌ EXPRESS SERVER ERROR:", err.stack || err);
  res.status(500).json({
    success: false,
    message: err.message || "Internal Server Error"
  });
});

// Serve frontend static files in production
//const frontendDistPath = path.join(__dirname, "../../frontend/DBRAP_Portal_Frontend/dist");

const frontendDistPath = path.resolve(
  __dirname,
  process.env.FRONTEND_DIST_PATH
);

app.use(express.static(frontendDistPath, {
  setHeaders: (res, filePath) => {
    if (path.basename(filePath) === "index.html") {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  },
}));

// Wildcard route to handle React Router client-side routing
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith("/api")) {
    return next();
  }
  res.sendFile(path.join(frontendDistPath, "index.html"));
});

const PORT = process.env.PORT || 8080;

const ensureOrganisationSchema = async () => {
  // ... unchanged, same as your original file ...
};

const startServer = async () => {
  try {
    const uploadDir = path.join(
      process.env.UPLOAD_PATH || "uploads",
      "Money Receipts"
    );

    await fs.mkdir(uploadDir, {
      recursive: true,
    });

    await ensureOrganisationSchema();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`Secured server running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to initialize organisation schema:", error);
    process.exit(1);
  }
};

startServer();