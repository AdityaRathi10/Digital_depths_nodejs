const { getAuth } = require("firebase-admin/auth");
const { firebaseApp } = require("../backend/firebase");

async function login(req, res) {
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
}

module.exports = { login };
