const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");

const KEY_PATH = path.join(
  __dirname,
  "..",
  "..",
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

module.exports = { firebaseApp, db };
