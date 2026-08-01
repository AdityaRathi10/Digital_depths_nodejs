const express = require("express");
const router = express.Router();
const apiController = require("../../controllers/api/api.controller");

router.get("/get-all-mails", apiController.getAllMail);
router.get("/orders", apiController.getOrders);
router.delete("/delete-email", apiController.deleteEmail);
router.get("/get-card-details", apiController.fetchAllCardDetails);
router.delete("/orders/clear-all", apiController.clearAllOrderData);
router.delete("/card-details/clear-all", apiController.clearAllCardData);

module.exports = router;
