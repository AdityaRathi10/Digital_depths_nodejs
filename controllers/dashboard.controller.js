const { getAuth } = require("firebase-admin/auth");
const { firebaseApp, db } = require("../backend/firebase");

async function dashboard(req, res) {
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
}

module.exports = { dashboard };
