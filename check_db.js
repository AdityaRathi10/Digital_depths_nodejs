// Import initializeApp and cert from the modern 'firebase-admin/app' module
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const path = require("path");

// 1. Path to your downloaded JSON service account key file
const KEY_PATH = path.join(
  __dirname,
  "config",
  "digital-deaft-firebase-key.json",
);

// 2. Initialize the Firebase Admin SDK using the direct cert function
initializeApp({
  credential: cert(KEY_PATH),
  projectId: "digital-deaft-2026",
  databaseURL: "https://digital-deaft-2026-default-rtdb.firebaseio.com",
});

// 3. Get Firestore instance with correct default database ID
const db = getFirestore().settings({ databaseId: "(default)" });

async function main() {
  try {
    const docRef = db.collection("test").doc("123");

    // 4. Write data
    await docRef.set({
      name: "Aditya",
      age: 21,
    });
    console.log("Data successfully written!");

    // 5. Read data
    const docSnap = await docRef.get();

    // 6. Check if document exists and print data
    if (docSnap.exists) {
      console.log("Document Data:", docSnap.data());
    } else {
      console.log("No such document found!");
    }
  } catch (error) {
    console.error("Error occurred:", error);
  }
}

module.exports = main;
