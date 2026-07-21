const express = require("express");
const router = express.Router();
const emailAutomationController = require("../controllers/email-automation.controller.js");

router.get("/", emailAutomationController.emailAutomation);

module.exports = router;
