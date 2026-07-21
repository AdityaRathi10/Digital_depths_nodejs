const express = require("express");
const router = express.Router();
const apiController = require("../../controllers/api/api.controller");

router.get("/get-all-mails", apiController.getAllMail);
router.get("/orders", apiController.getOrders);

module.exports = router;
