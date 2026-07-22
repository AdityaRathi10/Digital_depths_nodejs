const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");
const fs = require("fs");

// 1. The path when running normally via 'node app.js'
const devPath = path.join(
  __dirname,
  "..",
  "..",
  "config",
  "digital-deaft-firebase-key.json",
);

// 2. The path when running inside the compiled .exe (from dist/bundle.js)
const exePath = path.join(
  __dirname,
  "..",
  "config",
  "digital-deaft-firebase-key.json",
);

// 3. A final fallback checking the current working directory
const rootPath = path.join(
  process.cwd(),
  "config",
  "digital-deaft-firebase-key.json",
);

let KEY_PATH;

// Smartly detect which environment we are in
if (fs.existsSync(devPath)) {
  KEY_PATH = devPath;
} else if (fs.existsSync(exePath)) {
  KEY_PATH = exePath;
} else if (fs.existsSync(rootPath)) {
  KEY_PATH = rootPath;
} else {
  console.error("FATAL ERROR: Could not find the Firebase config JSON file!");
}

// Initialize the app cleanly using the service account certificate
const firebaseApp = initializeApp({
  credential: cert(KEY_PATH),
  projectId: "digital-deaft-2026",
});

// ✅ FIX 1: Pass the initialized app context AND target the clean "default" string identifier
const db = getFirestore(firebaseApp, "default");

module.exports = { firebaseApp, db };
