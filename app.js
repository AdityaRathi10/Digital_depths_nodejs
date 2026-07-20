require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const expressLayouts = require("express-ejs-layouts");
const { getAuth } = require("firebase-admin/auth");
const { firebaseApp, db } = require("./backend/firebase/index.js");
const loginController = require("./controllers/login.controller.js");
const dashboardController = require("./controllers/dashboard.controller.js");

const app = express();
const port = process.env.PORT || 3000;

// Middleware configurations
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));
app.use(expressLayouts);
app.set("layout", "_layout");
app.set("view engine", "ejs");

// ROUTES
app.post("/sessionLogout", (req, res) => {
  res.clearCookie("session");
  res.status(200).send(JSON.stringify({ status: "success" }));
});

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
app.get("/dashboard", dashboardController.dashboard);
app.get("/login", loginController.login);
app.get("/orders", (req, res) => {
  res.render("pages/order", { layout: "_layout" });
});

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
