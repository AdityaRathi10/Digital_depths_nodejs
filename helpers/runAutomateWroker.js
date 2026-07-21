async function runAutomatonWorker(browser, email, config, socket, db) {
  const log = (msg, type = "info") =>
    socket.emit("log", { type, msg: `[${email}] ${msg}` });

  const context = await browser.newContext({ viewport: null });
  let page;
  let docId = null;
  let keepOpenForUser = false; // NEW FLAG: Tracks if we should leave the tab open

  try {
    log("Step 1: Fetching credentials from Firestore...");
    const snapshot = await db
      .collection("automations")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (snapshot.empty || !snapshot.docs[0].data().password) {
      log(
        "Condition Failed: Email or Password missing in database. Stopping.",
        "error",
      );
      return;
    }

    docId = snapshot.docs[0].id;
    const password = snapshot.docs[0].data().password;

    page = await context.newPage();

    const humanDelay = async (min = 2500, max = 5500) => {
      const ms = Math.floor(Math.random() * (max - min + 1)) + min;
      log(`[Bot-Evasion] Reading page... pausing for ${ms}ms.`);
      await page.waitForTimeout(ms);
    };

    // ==========================================
    // 1. LOGIN SEQUENCE
    // ==========================================
    log("Navigating to Amazon Sign-In...");
    await page.goto(
      "https://www.amazon.in/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.in%2F%3Fref_%3Dnav_ya_signin&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=inflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0",
      { waitUntil: "domcontentloaded" },
    );
    await humanDelay(2000, 4000);

    try {
      const emailLocator = page
        .locator("input[type='email'], input[name='email'], #ap_email")
        .first();
      await emailLocator.waitFor({ state: "visible", timeout: 15000 });
      await emailLocator.fill(email);
      await humanDelay(1500, 3000);
      await page
        .locator("#continue, input.a-button-input, #continue-announce")
        .first()
        .click();
    } catch (e) {
      throw new Error("Email field or Continue button not found.");
    }

    await humanDelay(3000, 5000);

    try {
      const passwordLocator = page
        .locator("input[type='password'], #ap_password, input[name='password']")
        .first();
      await passwordLocator.waitFor({ state: "visible", timeout: 15000 });
      await passwordLocator.fill(password);
      await humanDelay(1500, 3000);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page
          .locator("#signInSubmit, input[type='submit']#signInSubmit")
          .first()
          .click(),
      ]);
    } catch (e) {
      throw new Error("Password field or Sign-In button not found.");
    }

    // ==========================================
    // 2. PRODUCT PAGE & BUY NOW
    // ==========================================
    log("Login successful. Navigating to product...");
    await humanDelay(3000, 6000);
    await page.goto(config.productLink, { waitUntil: "domcontentloaded" });
    await humanDelay(4000, 7000);

    const priceLocator = page.locator(".a-price-whole").first();
    if ((await priceLocator.count()) > 0) {
      let currentPrice = parseFloat(
        (await priceLocator.innerText()).replace(/,/g, ""),
      );
      if (currentPrice > parseFloat(config.maxPrice)) {
        log(
          `Condition Failed: Price (₹${currentPrice}) exceeds Max Limit (₹${config.maxPrice}).`,
          "error",
        );
        return;
      }
      log(`Price verified: ₹${currentPrice}`);
    }

    if (parseInt(config.quantity) > 1) {
      log(`Adjusting quantity to ${config.quantity}`);
      const qtyLocator = page.locator("select#quantity");
      if ((await qtyLocator.count()) > 0) {
        await qtyLocator.selectOption(config.quantity.toString());
        await humanDelay(2500, 4500);
      }
    }

    log("Clicking 'Buy Now'...");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click("#buy-now-button"),
    ]);

    // ==========================================
    // 3. CHECKOUT: ADDRESS SELECTION
    // ==========================================
    log("Step 3: Checking Address Selection...");
    await humanDelay(4000, 6000);

    const addressButton = page
      .locator(
        'input[data-testid="Address_select"], span:has-text("Deliver to this address") input, input[aria-labelledby="orderSummaryPrimaryActionBtn-announce"]',
      )
      .first();

    if (
      (await addressButton.count()) > 0 &&
      (await addressButton.isVisible())
    ) {
      log("Clicking 'Deliver to this address'...");
      await humanDelay(1500, 3000);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        addressButton.click(),
      ]);
    }

    // ==========================================
    // 4. CHECKOUT: DYNAMIC PAYMENT SELECTION
    // ==========================================
    log(`Step 4: Handling Payment Selection for: ${config.paymentMethod}...`);
    await humanDelay(3000, 5000);

    await page.evaluate(() => window.scrollBy(0, 400));
    await humanDelay(2000, 4000);

    let paymentSelected = false;

    if (config.paymentMethod === "UPI") {
      const upiRadio = page
        .locator('input[type="radio"][value*="UPI"]')
        .first();
      if ((await upiRadio.count()) > 0) {
        await upiRadio.click({ force: true });
        log("Selected UPI. Waiting for input field...");
        await humanDelay(2500, 4500);

        const upiInput = page
          .locator('input[name*="addUpiVpa"], input[placeholder*="UPI"]')
          .first();
        if ((await upiInput.count()) > 0 && (await upiInput.isVisible())) {
          log(`Entering UPI ID: ${config.upiId}`);
          await upiInput.fill(config.upiId);
          await humanDelay(2000, 4000);

          const verifyBtn = page
            .locator(
              'input[name*="ValidateUpiId"], span:has-text("Verify") input, span:has-text("Verify")',
            )
            .first();
          if ((await verifyBtn.count()) > 0) {
            log("Verifying UPI ID...");
            await verifyBtn.click();
            await humanDelay(5000, 7000);
          }
        }
        paymentSelected = true;
      }
    } else if (config.paymentMethod === "NETBANKING") {
      const nbRadio = page
        .locator('input[type="radio"][value*="NetBanking"]')
        .first();
      if ((await nbRadio.count()) > 0) {
        await nbRadio.click({ force: true });
        log(
          "Selected Net Banking. Waiting for dropdown panel to animate open...",
        );
        await humanDelay(3000, 5000);

        const bankDropdown = page
          .locator('select[name="ppw-bankSelection_dropdown"]')
          .first();

        if ((await bankDropdown.count()) > 0) {
          log(`Attempting to select Bank: ${config.bankName}`);
          try {
            await bankDropdown.selectOption(
              { label: config.bankName },
              { force: true, timeout: 5000 },
            );
            log("Bank selected successfully via native dropdown.");
          } catch (e) {
            log(
              "Native dropdown select blocked by Amazon's custom UI. Attempting fallback click...",
              "warn",
            );

            const dropdownTrigger = page.locator(".a-dropdown-prompt").first();
            await dropdownTrigger.click({ force: true });
            await humanDelay(1500, 3000);

            const bankOption = page
              .locator(`.a-popover-inner a:has-text("${config.bankName}")`)
              .first();
            await bankOption.click({ force: true });
            log("Bank selected via custom UI fallback.");
          }
          await humanDelay(2000, 4000);
        } else {
          log(
            "Warning: Could not locate the Net Banking dropdown element.",
            "warn",
          );
        }
        paymentSelected = true;
      }
    } else if (config.paymentMethod === "COD") {
      const codRadio = page
        .locator(
          'input[type="radio"][value*="COD"], input[type="radio"][value*="Cash"]',
        )
        .first();
      if ((await codRadio.count()) > 0) {
        await codRadio.click({ force: true });
        paymentSelected = true;
      }
    } else if (config.paymentMethod === "CARD") {
      const cardRadio = page
        .locator('input[type="radio"][value*="CreditCard"]')
        .first();
      if ((await cardRadio.count()) > 0) {
        await cardRadio.click({ force: true });
        paymentSelected = true;
      }
    }

    if (paymentSelected) {
      log("Payment method configured successfully.");
      await humanDelay(2500, 4500);

      const usePaymentBtn = page
        .locator(
          'input[name="ppw-widgetEvent:SetPaymentPlanSelectContinueEvent"], span:has-text("Use this payment method") input',
        )
        .first();
      if (
        (await usePaymentBtn.count()) > 0 &&
        (await usePaymentBtn.isVisible())
      ) {
        log("Clicking 'Use this payment method'...");
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          usePaymentBtn.click(),
        ]);
      }
    } else {
      log(
        "Warning: Requested payment method not found or currently unavailable.",
        "warn",
      );
    }

    // ==========================================
    // 5. FINAL GRAND TOTAL & PLACE ORDER
    // ==========================================
    log("Step 5: Verifying final Grand Total...");
    await humanDelay(4000, 7000);

    const totalLocator = page
      .locator(".grand-total-price, #sc-subtotal-amount-buybox, span.payByLine")
      .first();
    if ((await totalLocator.count()) > 0) {
      let grandTotal = parseFloat(
        (await totalLocator.innerText()).replace(/[^\d.-]/g, ""),
      );
      if (grandTotal > parseFloat(config.maxCheckoutTotal)) {
        log(
          `Condition Failed: Grand Total (₹${grandTotal}) exceeds limit (₹${config.maxCheckoutTotal}).`,
          "error",
        );
        return;
      }
    }

    log("Locating final 'Place Your Order' button...");
    const placeOrderBtn = page
      .locator(
        'input[name="placeYourOrder1"], #placeYourOrder, #submitOrderButtonId',
      )
      .first();

    if ((await placeOrderBtn.count()) > 0) {
      log("Clicking 'Place Your Order'...");
      await humanDelay(2000, 4000);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        placeOrderBtn.click(),
      ]);
      log("Order sequence submitted!", "success");
    } else {
      throw new Error(
        "Could not locate the 'Place Order' button on the final page.",
      );
    }

    // ==========================================
    // 6. FETCH ORDER ID & DETACH BOT
    // ==========================================
    log("Step 6: Fetching Order ID and transferring control...");
    await humanDelay(5000, 8000);

    log("Navigating to Orders page to confirm ID...");
    await page.goto("https://www.amazon.in/your-orders/orders", {
      waitUntil: "domcontentloaded",
    });
    await humanDelay(4000, 6000);

    const pageText = await page.innerText("body");
    const orderIdMatch = pageText.match(/\d{3}-\d{7}-\d{7}/);

    if (orderIdMatch) {
      const orderId = orderIdMatch[0];
      log(`Order ID retrieved: ${orderId}`, "success");

      await db.collection("automations").doc(docId).update({
        order_id: orderId,
        status: "Success",
        updated_at: new Date().toISOString(),
      });
      log("Firebase database updated successfully.", "success");
    } else {
      log(
        "Warning: Sequence complete, but could not extract Order ID from the page.",
        "warn",
      );
      await db.collection("automations").doc(docId).update({
        status: "Success (ID Not Extracted)",
        updated_at: new Date().toISOString(),
      });
    }

    // Flipping the flag! The sequence is successful, do not close the tab.
    keepOpenForUser = true;
  } catch (error) {
    log(`ERROR: Sequence interrupted: ${error.message}`, "error");
    if (docId) {
      await db
        .collection("automations")
        .doc(docId)
        .update({
          status: "Failed",
          error_message: error.message,
          updated_at: new Date().toISOString(),
        })
        .catch((e) => console.error("DB Error:", e));
    }
  } finally {
    // UPDATED FINALLY BLOCK: Check the flag before closing
    if (context && !keepOpenForUser) {
      log("Destroying isolated session due to failure/condition...", "warn");
      await context.close();
    } else if (keepOpenForUser) {
      log(
        "Automation bot detached. The browser tab will remain open for your manual review.",
        "success",
      );
      // We DO NOT call context.close() here. The user takes over.
    }
  }
}

module.exports = { runAutomatonWorker };
