require("dotenv").config();
const express = require("express");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const cookieParser = require("cookie-parser");
const expressLayouts = require("express-ejs-layouts");
const { getAuth } = require("firebase-admin/auth");
const path = require("path");

const KEY_PATH = path.join(
  __dirname,
  "config",
  "digital-deaft-firebase-key.json",
);

// Initialize the app cleanly using the service account certificate
const firebaseApp = initializeApp({
  credential: cert(KEY_PATH),
  projectId: "digital-deaft-2026",
});

// ✅ FIX 1: Pass the initialized app context AND target the clean "default" string identifier
const db = getFirestore(firebaseApp, "default");

const app = express();
const port = process.env.PORT || 3000;

// Middleware configurations
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));
app.use(expressLayouts);
app.set("layout", "_layout");
app.set("view engine", "ejs");

// Connection Test Wrapper
async function testConnection() {
  try {
    console.log(
      "Connecting to Firestore using configured database instance...",
    );

    // ✅ FIX 2: Do NOT redefine `const db = getFirestore()`. Use the scoped global `db` variable declared above.
    const snapshot = await db.collection("test").limit(1).get();

    console.log("✅ SUCCESS! Connected to Firestore.");
    console.log(`Found ${snapshot.size} documents in the 'test' collection.`);
  } catch (error) {
    console.error("❌ FAILED:", error.message);
  }
}

// Fire the connection check immediately on boot
testConnection();

// ROUTES
app.post("/sessionLogin", async (req, res) => {
  const idToken = req.body.idToken;
  const expiresIn = 60 * 60 * 24 * 5 * 1000; // 5 days

  try {
    // ✅ FIX 3: Pass your initialized firebaseApp context into the auth handler
    const auth = getAuth(firebaseApp);
    const sessionCookie = await auth.createSessionCookie(idToken, {
      expiresIn,
    });

    const options = { maxAge: expiresIn, httpOnly: true, secure: true };
    res.cookie("session", sessionCookie, options);

    res.status(200).send(JSON.stringify({ status: "success" }));
  } catch (error) {
    console.error("Session creation error:", error);
    res.status(401).send("UNAUTHORIZED REQUEST");
  }
});

// PAGES
app.get("/", (req, res) => {
  res.redirect("/login");
});

app.get("/dashboard", async (req, res) => {
  const sessionCookie = req.cookies.session || "";

  try {
    // ✅ FIX 4: Use scoped getAuth with explicit application context
    const auth = getAuth(firebaseApp);
    const decodedClaims = await auth.verifySessionCookie(sessionCookie, true);
    const uid = decodedClaims.uid;

    const userDoc = await db.collection("users").doc(uid).get();
    let userData = userDoc.exists
      ? userDoc.data()
      : { notes: "No data found." };

    res.render("pages/dashboard", {
      userEmail: decodedClaims.email,
      userData: userData,
    });
  } catch (error) {
    console.error("Error verifying session cookie:", error);
    console.log("No valid session, redirecting to login.");
    res.redirect("/login");
  }
});

app.get("/login", async (req, res) => {
  const sessionCookie = req.cookies.session || "";

  if (sessionCookie) {
    try {
      // ✅ FIX 5: Completely removed legacy 'admin.auth()' and updated to modular getAuth(firebaseApp)
      const auth = getAuth(firebaseApp);
      await auth.verifySessionCookie(sessionCookie, true);
      return res.redirect("/dashboard");
    } catch (error) {
      // Token expired or bad cookie; allow fallback to render login page
    }
  }

  res.render("pages/login", { layout: false });
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
