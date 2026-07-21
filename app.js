require("dotenv").config();
const express = require("express");
const cookieParser = require("cookie-parser");
const expressLayouts = require("express-ejs-layouts");
const { getAuth } = require("firebase-admin/auth");
const { firebaseApp, db } = require("./backend/firebase/index.js");
const loginController = require("./controllers/login.controller.js");
const dashboardController = require("./controllers/dashboard.controller.js");
const emailAutomationController = require("./controllers/email-automation.controller.js");
const http = require("http");
const { Server } = require("socket.io");
const { chromium } = require("playwright");
const { runAutomatonWorker } = require("./helpers/runAutomateWroker.js");
const { exec } = require("child_process");
const { runAccountSetupWorker } = require("./helpers/accountWorker.js");
const apiRoute = require("./routes/api/api.route.js");

const app = express();
const port = process.env.PORT || 3000;
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Allows connections from your deployed Render URL
    methods: ["GET", "POST"],
    credentials: true,
  },
  transports: ["websocket", "polling"], // Force support for both protocols
});

// Middleware configurations
app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));
app.use(expressLayouts);
app.set("layout", "_layout");
app.set("view engine", "ejs");

// Set global variable for EJS to track current route
app.use((req, res, next) => {
  res.locals.path = req.path;
  next();
});

// Handle WebSocket connections
io.on("connection", (socket) => {
  console.log("Client connected to dashboard UI.");

  socket.on("start-engine", async (config) => {
    const emails = config.emails
      .split("\n")
      .map((e) => e.trim())
      .filter((e) => e);
    socket.emit("log", {
      type: "info",
      msg: `Engine started. Loaded ${emails.length} target accounts.`,
    });

    // Launch Browser Once
    const browser = await chromium.launch({
      headless: false,
      channel: "chrome",
      args: ["--start-maximized", "--disable-dev-shm-usage", "--no-sandbox"],
    });

    // 🛑 UPDATED: Enforce max 10 threads to strictly protect RAM/CPU
    const requestedThreads = parseInt(config.threads) || 1;
    const workers = Math.min(requestedThreads, 10);

    socket.emit("log", {
      type: "info",
      msg: `Queue initialized. Processing maximum ${workers} accounts per batch.`,
    });

    // The Batching Loop (Now processes in chunks of 10)
    for (let i = 0; i < emails.length; i += workers) {
      const chunk = emails.slice(i, i + workers);

      socket.emit("log", {
        type: "info",
        msg: `--- STARTING BATCH ${Math.floor(i / workers) + 1} (${chunk.length} accounts) ---`,
      });

      // Run the batch of 10 concurrently
      const promises = chunk.map((email) =>
        runAutomatonWorker(browser, email, config, socket, db),
      );

      // Wait for all 10 to finish completely before moving on to the next 10
      await Promise.all(promises);

      socket.emit("log", {
        type: "success",
        msg: `--- BATCH ${Math.floor(i / workers) + 1} COMPLETED. Freeing up RAM for next batch. ---`,
      });
    }

    socket.emit("log", {
      type: "success",
      msg: "All automation batches completed successfully.",
    });
    // await browser.close(); // Close the main browser engine when all batches are 100% done
  });

  // email automation
  socket.on("start-account-setup", async (data) => {
    const { email, password } = data;

    if (!email || !password) {
      socket.emit("log", {
        type: "error",
        msg: "Email and Password are required.",
      });
      return;
    }

    socket.emit("log", {
      type: "info",
      msg: `Received account verification request for: ${email}`,
    });

    // Launch the browser (Keep headless: false so you can see it working locally)
    const browser = await chromium.launch({
      headless: false,
      channel: "chrome", // Use local chrome if building as .exe
      args: ["--start-maximized", "--disable-dev-shm-usage", "--no-sandbox"],
    });

    // Call the worker you built in Step 1
    await runAccountSetupWorker(browser, email, password, socket, db);

    // Clean up when the worker finishes completely
    await browser.close();
  });

  socket.on("trigger-saved-signin", async (data) => {
    const { email } = data;
    socket.emit("log", {
      type: "info",
      msg: `Initiating sign-in process for database account: ${email}`,
    });

    try {
      // Fetch the specific password for this email from DB
      const snapshot = await db
        .collection("automations")
        .where("email", "==", email)
        .limit(1)
        .get();

      if (snapshot.empty || !snapshot.docs[0].data().password) {
        socket.emit("log", {
          type: "error",
          msg: `Error: Password not found in database for ${email}.`,
        });
        return;
      }

      const password = snapshot.docs[0].data().password;

      // Launch Browser
      const browser = await chromium.launch({
        headless: false,
        channel: "chrome",
        args: ["--start-maximized", "--disable-dev-shm-usage", "--no-sandbox"],
      });

      // Call the existing worker function
      await runAccountSetupWorker(browser, email, password, socket, db);
    } catch (error) {
      socket.emit("log", {
        type: "error",
        msg: `System Error: ${error.message}`,
      });
    }
  });
});

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
app.use("/api", apiRoute);

// PAGES
app.get("/", (req, res) => {
  res.redirect("/login");
});
app.get("/dashboard", dashboardController.dashboard);
app.get("/email-automation", emailAutomationController.emailAutomation);
app.get("/login", loginController.login);
app.get("/orders", (req, res) => {
  res.render("pages/order", { layout: "_layout" });
});

server.listen(port, "localhost", () => {
  console.log(`=========================================`);
  console.log(`Amazon Automation Bot is Running!`);
  console.log(`DO NOT CLOSE THIS WINDOW.`);
  console.log(`=========================================`);

  // Automatically open the user's default browser to the UI
  const url = `http://localhost:${port}`;
  const command = process.platform === "win32" ? `start ${url}` : `open ${url}`;
  exec(command);
});
