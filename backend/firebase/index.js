const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");
const fs = require("fs");

let KEY_PATH = path.join(
  __dirname,
  "..",
  "..",
  "config",
  "digital-deaft-firebase-key.json",
);

// Cloud Fallback: If it doesn't exist in 'config', look in the root directory (Render)
if (!fs.existsSync(KEY_PATH)) {
  KEY_PATH = path.join(
    __dirname,
    "..",
    "..",
    "digital-deaft-firebase-key.json",
  );
}

// Initialize the app cleanly using the service account certificate
const firebaseApp = initializeApp({
  credential: cert(KEY_PATH),
  projectId: "digital-deaft-2026",
});

// ✅ FIX 1: Pass the initialized app context AND target the clean "default" string identifier
const db = getFirestore(firebaseApp, "default");

module.exports = { firebaseApp, db };
