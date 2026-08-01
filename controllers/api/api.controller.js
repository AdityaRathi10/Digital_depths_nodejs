const { db } = require("../../backend/firebase");

// 1. Fetch all email accounts
async function getAllMail(req, res) {
  try {
    const snapshot = await db.collection("automations").get();
    const emails = [];

    snapshot.forEach((doc) => {
      const data = doc.data();
      // Only push entries that actually have an email and a password
      if (data.email && data.password) {
        emails.push({
          id: doc.id,
          email: data.email,
          status: data.status || "Pending",
        });
      }
    });

    res.json({ success: true, emails: emails });
  } catch (error) {
    console.error("Failed to fetch emails:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// 2. Fetch all orders
async function getOrders(req, res) {
  try {
    const accountsSnapshot = await db.collection("automations").get();
    let allOrders = [];

    // Loop through all parent account documents
    for (const accountDoc of accountsSnapshot.docs) {
      const accountData = accountDoc.data();
      // Fetch the dynamic sub-collection named after the email
      const ordersSnapshot = await db
        .collection("automations")
        .doc(accountDoc.id)
        .collection("orders")
        .get();

      ordersSnapshot.forEach((orderDoc) => {
        const orderData = orderDoc.data();
        allOrders.push({
          id: orderDoc.id,
          email: orderData.email || "N/A",
          orderId: orderData.order_id || "Pending...",
          productName: orderData.product_name || "N/A",
          price:
            orderData.order_price ||
            orderData.checkout_total ||
            orderData.price_found ||
            "N/A",
          status: orderData.status || "Pending",
          createdAt: orderData.created_at || new Date().toISOString(),
        });
      });
    }

    // Sort all orders globally by newest first
    allOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ success: true, orders: allOrders });
  } catch (error) {
    console.error("Failed to fetch orders:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

// 3. NEW: Delete email document from database
async function deleteEmail(req, res) {
  try {
    const { email } = req.body;

    if (!email) {
      return res
        .status(400)
        .json({ success: false, error: "Email is required" });
    }

    // Search for documents matching the email
    const snapshot = await db
      .collection("automations")
      .where("email", "==", email)
      .get();

    if (snapshot.empty) {
      return res
        .status(404)
        .json({ success: false, error: "Account not found in database" });
    }

    // Delete matching document(s)
    const deletePromises = snapshot.docs.map((doc) => doc.ref.delete());
    await Promise.all(deletePromises);

    res.json({ success: true, message: "Email deleted successfully" });
  } catch (error) {
    console.error("Failed to delete email:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

async function fetchAllCardDetails(req, res) {
  try {
    const accountsSnapshot = await db.collection("automations").get();
    let allCardData = [];

    for (const accountDoc of accountsSnapshot.docs) {
      const accountData = accountDoc.data();
      const email = accountData.email || "N/A";
      const docId = accountDoc.id;

      // Subcollection 'card-details' ko fetch kar rahe hain
      const cardDetailsSnapshot = await db
        .collection("automations")
        .doc(docId)
        .collection("card-details")
        .get();

      // console.log("cardDetailsSnapshot =>", cardDetailsSnapshot);

      if (!cardDetailsSnapshot.empty) {
        cardDetailsSnapshot.forEach((cardDoc) => {
          const data = cardDoc.data();

          // Extracting nested transaction_dates safely
          const transactionDates = data.transaction_dates || {};
          const orderDate = transactionDates["order date"] || "N/A";
          const expectedCreditDate =
            transactionDates["Expected Credit On"] || "N/A";

          // Array of order_ids ko safe comma-separated string me convert kar rahe hain
          const orderIds = Array.isArray(data.order_ids)
            ? data.order_ids.join(", ")
            : data.order_ids || "N/A";

          allCardData.push({
            id: cardDoc.id,
            parentDocId: docId,
            email: email,
            amount: data.amount || "N/A",
            cardDetails: data.card_details || "N/A",
            orderIds: orderIds,
            productName: data.product_name || "N/A",
            statementMonth: data.statement_month || "N/A",
            status: data.status || "Pending",
            orderDate: orderDate,
            expectedCreditDate: expectedCreditDate,
            type: data.type || "Transaction Detail",
            createdAt: data.created_at || new Date().toISOString(),
          });
        });
      }
    }

    allCardData.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json({ success: true, cardDetails: allCardData });
  } catch (error) {
    console.error("Failed to fetch card details:", error);
    res.status(500).json({ success: false, error: error.message });
  }
}

async function clearAllOrderData(req, res) {
  try {
    // 1. Fetch all parent account documents from the "automations" collection
    const accountsSnapshot = await db.collection("automations").get();
    const deletePromises = [];

    // 2. Loop through every account to find their "orders" sub-collection
    for (const accountDoc of accountsSnapshot.docs) {
      // Fetch all documents inside this account's "orders" sub-collection
      const subCollectionRef = db
        .collection("automations")
        .doc(accountDoc.id)
        .collection("orders");

      const subCollectionSnapshot = await subCollectionRef.get();

      // Add each deletion task to our massive promise array
      subCollectionSnapshot.docs.forEach((doc) => {
        deletePromises.push(doc.ref.delete());
      });
    }

    // 3. Delete all documents across all accounts concurrently
    await Promise.all(deletePromises);

    res.json({
      success: true,
      message: `Successfully cleared all ${deletePromises.length} records across all accounts!`,
    });
  } catch (error) {
    console.error("Failed to clear all database records:", error);
    res.status(500).json({ error: "Failed to clear all data." });
  }
}

async function clearAllCardData(req, res) {
  try {
    // 1. Fetch all parent account documents from the "automations" collection
    const accountsSnapshot = await db.collection("automations").get();
    const deletePromises = [];

    // 2. Loop through every account to find their "orders" sub-collection
    for (const accountDoc of accountsSnapshot.docs) {
      // Fetch all documents inside this account's "orders" sub-collection
      const subCollectionRef = db
        .collection("automations")
        .doc(accountDoc.id)
        .collection("card-details");

      const subCollectionSnapshot = await subCollectionRef.get();

      // Add each deletion task to our massive promise array
      subCollectionSnapshot.docs.forEach((doc) => {
        deletePromises.push(doc.ref.delete());
      });
    }

    // 3. Delete all documents across all accounts concurrently
    await Promise.all(deletePromises);

    res.json({
      success: true,
      message: `Successfully cleared all ${deletePromises.length} records across all accounts!`,
    });
  } catch (error) {
    console.error("Failed to clear all database records:", error);
    res.status(500).json({ error: "Failed to clear all data." });
  }
}

module.exports = {
  getAllMail,
  getOrders,
  deleteEmail,
  fetchAllCardDetails,
  clearAllOrderData,
  clearAllCardData,
};
