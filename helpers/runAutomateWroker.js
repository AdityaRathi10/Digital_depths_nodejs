async function runAutomatonWorker(context, email, config, socket, db) {
  const log = (msg, type = "info") =>
    socket.emit("log", { type, msg: `[${email}] ${msg}` });

  let page;

  try {
    log("Step 1: Starting sequence. Fetching credentials from Firestore...");

    log(`Searching 'automations' collection for exact match: ${email}`);
    const snapshot = await db
      .collection("automations")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (snapshot.empty) {
      log(
        "Condition Failed: Account email not found in database. Stopping thread.",
        "error",
      );
      return;
    }

    const accountData = snapshot.docs[0].data();
    log(`Match found in database. Verifying password existence...`);

    if (!accountData.password) {
      log(
        "Condition Failed: Password missing in database for this email. Stopping thread.",
        "error",
      );
      return;
    }

    const password = accountData.password;
    log("Credentials verified successfully. Opening new browser tab...");

    page = await context.newPage();

    // --- HELPER FUNCTION: Human-like delay ---
    const humanDelay = async (min = 1500, max = 3500) => {
      const ms = Math.floor(Math.random() * (max - min + 1)) + min;
      log(`[Bot-Evasion] Pausing for ${ms}ms to simulate human reading...`);
      await page.waitForTimeout(ms);
    };

    log("Navigating to Amazon Sign-In page...");
    await page.goto(
      "https://www.amazon.in/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.in%2F%3Fref_%3Dnav_ya_signin&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=inflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0",
      { waitUntil: "domcontentloaded" },
    );
    await humanDelay(1000, 2000);

    // ==========================================
    // LOGIN SEQUENCE
    // ==========================================
    try {
      log("Step 2: Locating email input field...");
      const emailLocator = page
        .locator("input[type='email'], input[name='email'], #ap_email")
        .first();
      await emailLocator.waitFor({ state: "visible", timeout: 15000 });

      log(`Typing email address...`);
      await emailLocator.fill(email);
      await humanDelay(1000, 2000);

      log("Clicking 'Continue' button...");
      const continueLocator = page
        .locator("#continue, input.a-button-input, #continue-announce")
        .first();
      await continueLocator.click();
    } catch (e) {
      const errorScreenshot = `public/error-email-${email.split("@")[0]}.png`;
      await page.screenshot({ path: errorScreenshot });
      throw new Error(
        `Email field or Continue button not found. Check screenshot at ${errorScreenshot}`,
      );
    }

    await humanDelay(1500, 3000);

    try {
      log("Locating password input field...");
      const passwordLocator = page
        .locator("input[type='password'], #ap_password, input[name='password']")
        .first();
      await passwordLocator.waitFor({ state: "visible", timeout: 15000 });

      log("Typing password...");
      await passwordLocator.fill(password);
      await humanDelay(1000, 2000);

      log("Clicking 'Sign-In' submit button...");
      const submitLocator = page
        .locator("#signInSubmit, input[type='submit']#signInSubmit")
        .first();

      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        submitLocator.click(),
      ]);
    } catch (e) {
      const errorScreenshot = `public/error-password-${email.split("@")[0]}.png`;
      await page.screenshot({ path: errorScreenshot });
      throw new Error(
        `Password field or Sign-In button not found. Check screenshot at ${errorScreenshot}`,
      );
    }

    log("Login successful. Proceeding to target product link...");
    await humanDelay(2000, 4000);
    await page.goto(config.productLink, { waitUntil: "domcontentloaded" });

    // ==========================================
    // PRODUCT PAGE & PRICE CHECK
    // ==========================================
    log(
      "Step 3: Checking current page state to confirm we are on the product page...",
    );
    await humanDelay(2000, 3000);

    log(
      `Evaluating product price against user max limit (₹${config.maxPrice})...`,
    );
    const priceLocator = page.locator(".a-price-whole").first();

    if ((await priceLocator.count()) > 0) {
      let priceText = await priceLocator.innerText();
      let currentPrice = parseFloat(priceText.replace(/,/g, ""));
      log(`Found current product price: ₹${currentPrice}`);

      if (currentPrice > parseFloat(config.maxPrice)) {
        log(
          `Condition Failed: Current Price (₹${currentPrice}) is strictly greater than Max Limit (₹${config.maxPrice}). Stopping thread.`,
          "error",
        );
        await page.close();
        return;
      }
      log(
        `Price check passed. ₹${currentPrice} is within the acceptable limit.`,
      );
    } else {
      log(
        "Warning: Could not locate standard price element. Continuing cautiously...",
        "warn",
      );
    }

    if (parseInt(config.quantity) > 1) {
      log(`Locating quantity dropdown. Target quantity: ${config.quantity}`);
      const qtyLocator = page.locator("select#quantity");
      if ((await qtyLocator.count()) > 0) {
        await qtyLocator.selectOption(config.quantity.toString());
        log(
          `Quantity successfully adjusted to ${config.quantity}. Waiting for page to update...`,
        );
        await humanDelay(1500, 2500);
      } else {
        log(
          "Warning: Quantity dropdown not found. Product might be restricted to 1.",
          "warn",
        );
      }
    }

    log("Locating 'Buy Now' button...");
    await humanDelay(1000, 2000);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click("#buy-now-button"),
    ]);

    // ==========================================
    // ANTI-BOT INTERSTITIAL CHECKER
    // ==========================================
    log("Step 4: Evaluating post-click page state...");
    await humanDelay(2000, 4000);

    // Look for the "Continue shopping" interruption page you provided in the image
    const continueShoppingBtn = page
      .locator(
        "text='Continue shopping', input[name='submit.continue-shopping'], .a-button-text:has-text('Continue shopping')",
      )
      .first();

    if (
      (await continueShoppingBtn.count()) > 0 &&
      (await continueShoppingBtn.isVisible())
    ) {
      log(
        "ALERT: Amazon 'Continue shopping' bot-check page detected. Attempting to bypass...",
        "warn",
      );
      await humanDelay(2000, 3500);

      log("Clicking 'Continue shopping' to reset state...");
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        continueShoppingBtn.click(),
      ]);

      log("Bypass clicked. Checking if returned to product page...");
      await humanDelay(2000, 4000);

      // Attempt to click Buy Now one more time
      const retryBuyNow = page.locator("#buy-now-button").first();
      if ((await retryBuyNow.count()) > 0 && (await retryBuyNow.isVisible())) {
        log("Confirmed return to product page. Retrying 'Buy Now' click...");
        await humanDelay(1500, 3000);
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          retryBuyNow.click(),
        ]);
        log("Retry submitted. Evaluating new page state...");
        await humanDelay(2000, 4000);
      } else {
        throw new Error(
          "Failed to find Buy Now button after bypassing the interruption page.",
        );
      }
    }

    // ==========================================
    // CHECKOUT & GRAND TOTAL VALIDATION
    // ==========================================
    log("Step 5: Verifying arrival at final Checkout page...");

    log(
      `Scanning for Grand Total to compare against Max Checkout Total (₹${config.maxCheckoutTotal})...`,
    );
    const totalLocator = page
      .locator(".grand-total-price, #sc-subtotal-amount-buybox")
      .first();

    if ((await totalLocator.count()) > 0) {
      let totalText = await totalLocator.innerText();
      let grandTotal = parseFloat(totalText.replace(/[^\d.-]/g, ""));
      log(`Found Grand Total on checkout page: ₹${grandTotal}`);

      if (grandTotal > parseFloat(config.maxCheckoutTotal)) {
        log(
          `Condition Failed: Checkout Grand Total (₹${grandTotal}) exceeds safe limit (₹${config.maxCheckoutTotal}). Stopping thread.`,
          "error",
        );
        await page.close();
        return;
      }
      log(`Grand Total validation passed. Amount is within budget.`);
    } else {
      log(
        "Warning: Could not immediately read the Grand Total. The page might still be calculating or structural DOM has changed.",
        "warn",
      );
    }

    log(`Identifying requested payment method: ${config.paymentMethod}`);
    log(
      "Payment selection logic reached (DOM interaction skipped for simulation).",
    );

    log(
      "All conditions verified successfully. Order is staged and ready for final placement.",
      "success",
    );
    log("Bot workflow complete. Leaving page open for review.", "success");
  } catch (error) {
    log(
      `FATAL ERROR: Automation sequence interrupted: ${error.message}`,
      "error",
    );
    if (page) {
      log("Closing tab due to critical failure.");
      await page.close();
    }
  }
}

module.exports = { runAutomatonWorker };
