async function runAutomatonWorker(browser, email, config, socket, db) {
  const log = (msg, type = "info") =>
    socket.emit("log", { type, msg: `[${email}] ${msg}` });

  const context = await browser.newContext({
    viewport: null,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  let page;
  let docId = null;
  let keepOpenForUser = false;

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
    // 1. LOGIN SEQUENCE (WITH OTP INTERCEPT)
    // ==========================================
    log("Navigating to Amazon Sign-In...");
    await page.goto(
      "https://www.amazon.in/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.in%2F%3Fref_%3Dnav_ya_signin&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=inflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0",
      { waitUntil: "commit", timeout: 60000 },
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

    const passwordLocator = page
      .locator("input[type='password'], #ap_password, input[name='password']")
      .first();
    await passwordLocator.waitFor({ state: "visible", timeout: 15000 });
    await passwordLocator.fill(password);
    await humanDelay(1500, 3000);

    await page
      .locator("#signInSubmit, input[type='submit']#signInSubmit")
      .first()
      .click();
    log("Submitted password. Waiting for Amazon response...");

    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await humanDelay(3000, 5000);

    const pwdErrorBox = page
      .locator(
        "#auth-error-message-box, .a-alert-content:has-text('Important Notice!'), .a-alert-content:has-text('password is incorrect')",
      )
      .first();
    if ((await pwdErrorBox.count()) > 0 && (await pwdErrorBox.isVisible())) {
      log(
        "Condition Failed: Password incorrect or account alert triggered.",
        "error",
      );
      try {
        await db.collection("automations").doc(docId).collection(email).add({
          status: "Failed - Invalid Password",
          created_at: new Date().toISOString(),
        });
      } catch (e) {
        log("Database warning: Could not save failure status.", "warn");
      }
      return;
    }

    const currentUrl = page.url().toLowerCase();
    const isChallengeUrl =
      currentUrl.includes("cvf") ||
      currentUrl.includes("mfa") ||
      currentUrl.includes("challenge") ||
      currentUrl.includes("approval");
    const hasOtpInput =
      (await page
        .locator(
          'input[name="otpCode"], input[name="code"], #cvf-input-code, #auth-mfa-otpcode',
        )
        .count()) > 0;

    if (isChallengeUrl || hasOtpInput) {
      log("⚠️ ACTION REQUIRED: OTP or Security Challenge detected!", "warn");
      log(
        "Bot is PAUSED. Please enter the OTP manually in the opened browser window. (5 min timeout)",
        "warn",
      );

      try {
        await page.waitForSelector("#nav-logo, #nav-cart, #nav-belt", {
          state: "attached",
          timeout: 300000, // 5 min
        });
        log("Manual verification complete. Resuming automation...", "success");
        await humanDelay(2000, 4000);
      } catch (e) {
        log(
          "Condition Failed: Manual verification timed out after 5 minutes.",
          "error",
        );
        throw new Error("Failed due to OTP Timeout.");
      }
    } else {
      log("Sign-In successful (No OTP required).", "success");
    }

    // ==========================================
    // 2. PRODUCT PAGE & BUY NOW
    // ==========================================
    log("Login successful. Navigating to product...");
    await humanDelay(3000, 6000);
    await page.goto(config.productLink, {
      waitUntil: "commit",
      timeout: 60000,
    });
    await humanDelay(4000, 7000);

    const priceBoxLocator = page.locator(".a-price-whole").first();
    if ((await priceBoxLocator.count()) > 0) {
      let currentPrice = parseFloat(
        (await priceBoxLocator.innerText()).replace(/,/g, ""),
      );
      if (currentPrice > parseFloat(config.maxPrice)) {
        log(
          `Condition Failed: Price (₹${currentPrice}) exceeds Max Limit (₹${config.maxPrice}).`,
          "error",
        );

        try {
          await db.collection("automations").doc(docId).collection(email).add({
            status: "Failed - Price Exceeded Limit",
            product_link: config.productLink,
            price_found: currentPrice,
            created_at: new Date().toISOString(),
          });
        } catch (e) {}
        return;
      }
      log(`Price verified: ₹${currentPrice}`);
    }

    if (parseInt(config.quantity) > 1) {
      log(`Adjusting quantity to ${config.quantity}...`);
      const qtyLocator = page
        .locator(
          "select#quantity, select[name='quantity'], select.a-native-dropdown",
        )
        .first();

      if ((await qtyLocator.count()) > 0 && (await qtyLocator.isVisible())) {
        try {
          await qtyLocator.selectOption(config.quantity.toString());
          log("Quantity successfully updated.");
          await humanDelay(2500, 4500);
        } catch (err) {
          log(
            `Warning: Found dropdown but failed to select ${config.quantity}. Attempting to proceed anyway.`,
            "warn",
          );
        }
      } else {
        log(
          "Warning: Quantity dropdown not found or not visible. Proceeding with default quantity.",
          "warn",
        );
      }
    }

    log("Clicking 'Buy Now'...");
    await page.click("#buy-now-button");
    await page.waitForLoadState("commit", { timeout: 60000 }).catch(() => {});

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

      await addressButton.click();
      await page.waitForLoadState("commit", { timeout: 60000 }).catch(() => {});
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
          } catch (e) {
            const dropdownTrigger = page.locator(".a-dropdown-prompt").first();
            await dropdownTrigger.click({ force: true });
            await humanDelay(1500, 3000);

            const bankOption = page
              .locator(`.a-popover-inner a:has-text("${config.bankName}")`)
              .first();
            await bankOption.click({ force: true });
          }
          await humanDelay(2000, 4000);
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
        await usePaymentBtn.click();
        await page
          .waitForLoadState("commit", { timeout: 60000 })
          .catch(() => {});
      }
    }

    // ==========================================
    // 5. FINAL GRAND TOTAL & PLACE ORDER (WITH BANK GATEWAY INTERCEPT)
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

        try {
          await db.collection("automations").doc(docId).collection(email).add({
            status: "Failed - Total Exceeded Limit",
            checkout_total: grandTotal,
            created_at: new Date().toISOString(),
          });
        } catch (e) {}
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

      await placeOrderBtn.click();
      await humanDelay(3000, 5000);

      if (config.paymentMethod === "NETBANKING") {
        log("⚠️ ACTION REQUIRED: Bank Payment Gateway detected.", "warn");
        log(
          "Bot is PAUSED. Please complete the Net Banking payment manually. (5 minute timeout)",
          "warn",
        );

        // STEP 1 & 2: Resilient polling to wait for the user to return to Amazon
        let timeElapsed = 0;
        let paymentSuccess = false;
        const maxWait = 300000; // 5 minutes

        while (timeElapsed < maxWait) {
          try {
            const currentUrl = page.url().toLowerCase();
            if (
              currentUrl.includes("amazon.in") &&
              (currentUrl.includes("thankyou") ||
                currentUrl.includes("your-orders") ||
                currentUrl.includes("order-details") ||
                currentUrl.includes("buy/thankyou"))
            ) {
              paymentSuccess = true;
              break;
            }
          } catch (err) {
            // Ignore execution context errors during redirection
          }
          await page.waitForTimeout(5000); // Check every 5 seconds
          timeElapsed += 5000;
        }

        if (!paymentSuccess) {
          log(
            "Condition Failed: Manual payment verification timed out.",
            "error",
          );
          throw new Error("Failed due to Payment Gateway Timeout.");
        }

        log("Payment complete. Returned to Amazon.", "success");
        await humanDelay(3000, 5000);
      } else {
        await page
          .waitForLoadState("commit", { timeout: 60000 })
          .catch(() => {});
        log("Order sequence submitted!", "success");
      }
    } else {
      throw new Error(
        "Could not locate the 'Place Order' button on the final page.",
      );
    }

    // ==========================================
    // 6. FETCH DETAILED ORDER DATA & SUB-COLLECTION DB UPDATE
    // ==========================================
    log("Step 6: Fetching Order Details from history...");
    await humanDelay(5000, 8000);

    await page.goto("https://www.amazon.in/your-orders/orders", {
      waitUntil: "commit",
      timeout: 60000,
    });
    await humanDelay(4000, 6000);

    const firstOrderCard = page
      .locator(".order-card, .js-order-card, .yohtmlc-order-card, .a-box-group")
      .first();
    let orderBlockText = "";

    if ((await firstOrderCard.count()) > 0) {
      orderBlockText = await firstOrderCard.innerText();
    } else {
      orderBlockText = await page.innerText("body");
    }

    const orderIdMatch = orderBlockText.match(/\d{3}-\d{7}-\d{7}/);
    const orderId = orderIdMatch ? orderIdMatch[0] : "Not Found";

    const titleLocator = page
      .locator(
        ".yohtmlc-product-title, .a-link-normal, .a-link-normal.yohtmlc-item-title, .a-link-normal:has(.a-text-bold)",
      )
      .first();
    let productName = "Unknown Product";
    if ((await titleLocator.count()) > 0) {
      productName = (await titleLocator.innerText()).trim();
    }

    const orderTotalLocator = page
      .locator(".yohtmlc-order-total, .a-color-price, .value")
      .first();
    let orderPrice = "Unknown Price";
    if ((await orderTotalLocator.count()) > 0) {
      orderPrice = (await orderTotalLocator.innerText()).trim();
    }

    let orderStatus = "Success";
    const blockTextLower = orderBlockText.toLowerCase();

    if (
      blockTextLower.includes("payment failed") ||
      blockTextLower.includes("attention is required") ||
      blockTextLower.includes("action required") ||
      blockTextLower.includes("revise payment") ||
      blockTextLower.includes("cancelled")
    ) {
      orderStatus = "Failed";
    }

    log(
      `Order Details Captured -> ID: ${orderId} | Status: ${orderStatus} | Price: ${orderPrice}`,
    );

    try {
      await db.collection("automations").doc(docId).collection(email).add({
        order_id: orderId,
        product_name: productName,
        order_price: orderPrice,
        status: orderStatus,
        created_at: new Date().toISOString(),
      });

      await db.collection("automations").doc(docId).update({
        last_activity: new Date().toISOString(),
      });

      log(
        `Database sub-collection '${email}' successfully updated with order details.`,
        "success",
      );
    } catch (e) {
      log(
        "Warning: Could not save final details to database (Network Timeout).",
        "warn",
      );
    }

    keepOpenForUser = true;
  } catch (error) {
    log(`ERROR: Sequence interrupted: ${error.message}`, "error");
    if (docId) {
      try {
        await db.collection("automations").doc(docId).collection(email).add({
          status: "Failed - Execution Error",
          error_message: error.message,
          created_at: new Date().toISOString(),
        });
      } catch (e) {
        log(
          "Warning: Could not save error status to database (Network Timeout).",
          "warn",
        );
      }
    }
  } finally {
    if (context && !keepOpenForUser) {
      log("Destroying isolated session due to failure/condition...", "warn");
      await context.close();
    } else if (keepOpenForUser) {
      log(
        "Automation bot detached. The browser tab will remain open for your manual review.",
        "success",
      );
    }
  }
}

module.exports = { runAutomatonWorker };
