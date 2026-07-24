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
      const email = accountData.email;

      if (email) {
        // Fetch the dynamic sub-collection named after the email
        const ordersSnapshot = await db
          .collection("automations")
          .doc(accountDoc.id)
          .collection(email)
          .get();

        ordersSnapshot.forEach((orderDoc) => {
          const orderData = orderDoc.data();
          allOrders.push({
            id: orderDoc.id,
            email: email,
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

module.exports = { getAllMail, getOrders, deleteEmail };