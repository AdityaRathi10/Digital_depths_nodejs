const express = require("express");
const router = express.Router();
const loginController = require("../controllers/login.controller.js");

router.get("/", loginController.login);

module.exports = router;
