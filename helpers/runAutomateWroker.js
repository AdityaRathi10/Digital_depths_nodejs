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

  let docId = null;
  let keepOpenForUser = false;

  // Single Tab Execution - Reused across all orders
  const page = await context.newPage();

  const humanDelay = async (min = 2500, max = 5500) => {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    log(`[Bot-Evasion] Reading page... pausing for ${ms}ms.`);
    await page.waitForTimeout(ms);
  };

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

    // ==========================================
    // 1. LOGIN SEQUENCE (ONCE PER ACCOUNT ON CURRENT TAB)
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
          timeout: 300000, // 5 Minutes
        });
        log("Manual verification complete. Resuming automation...", "success");
        await humanDelay(2000, 4000);
      } catch (e) {
        log(
          "Condition Failed: Manual verification timed out after 5 Minutes.",
          "error",
        );
        throw new Error("Failed due to OTP Timeout.");
      }
    } else {
      log("Sign-In successful (No OTP required).", "success");
    }

    // ==========================================
    // 1.5 CART VERIFICATION & CLEARANCE
    // ==========================================
    log("Navigating to Cart to check for existing items...");
    await page.goto("https://www.amazon.in/cart", {
      waitUntil: "commit",
      timeout: 60000,
    });
    await humanDelay(3000, 5000);

    let deleteLocators = page.locator(
      'input[value="Delete"], .sc-action-delete input',
    );
    let itemCount = await deleteLocators.count();

    if (itemCount > 0) {
      log(
        `Cart is not empty. Found ${itemCount} item(s). Clearing cart...`,
        "warn",
      );

      while (itemCount > 0) {
        await deleteLocators.first().click();
        await humanDelay(2000, 4000);

        deleteLocators = page.locator(
          'input[value="Delete"], .sc-action-delete input',
        );
        itemCount = await deleteLocators.count();
      }

      log("Cart cleared successfully.", "success");
    } else {
      log("Cart is already empty. Proceeding normally.", "info");
    }

    // ==========================================
    // 2. ORDER AUTOMATION LOOP (RUNS ON CURRENT TAB)
    // ==========================================
    const totalOrders = Math.max(1, parseInt(config.ordersPerAccount) || 1);
    log(
      `🚀 Starting Automation Loop: Total ${totalOrders} order(s) to process on current tab.`,
    );

    for (let orderIndex = 1; orderIndex <= totalOrders; orderIndex++) {
      log(`----------------------------------------`);
log(
  `📦 Processing Order ${orderIndex} of ${totalOrders} [Current Tab]...`,
);
log(`----------------------------------------`);

let capturedProductName = "Unknown Product";

try {
  // --- CLEAN ASIN LINK & FAST NAVIGATION ---
  // Tracking parameters remove karke direct link banata hai (fast redirection)
  const asinMatch = config.productLink.match(/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  const cleanProductUrl = asinMatch ? `https://www.amazon.in/dp/${asinMatch[1]}` : config.productLink;

  log(
    `[Order ${orderIndex}/${totalOrders}] Fast navigating to: ${cleanProductUrl}`,
  );

  // waitUntil: "domcontentloaded" -> Page DOM ready hote hi aage badhega
  await page.goto(cleanProductUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  // Dynamic Wait: Fixed 3-6s delay ki jagah element ready hote hi instantly trigger hoga
  await page
    .waitForSelector("#productTitle, #buy-now-button", { timeout: 8000 })
    .catch(() => {});

  // Capture Product Title
  try {
    const titleElement = page.locator("#productTitle").first();
    if ((await titleElement.count()) > 0) {
      capturedProductName = (await titleElement.innerText()).trim();
      log(
        `Captured Product Title: ${capturedProductName.substring(0, 40)}...`,
        "success",
      );
    } else {
      log("Warning: #productTitle not found on product page.", "warn");
    }
  } catch (titleErr) {
    log("Warning: Failed to extract product title.", "warn");
  }

        // --- QUANTITY SELECTION ---
        if (parseInt(config.quantity) > 1) {
          log(`Adjusting quantity to ${config.quantity}...`);
          await humanDelay(3500, 5500);

          const qtyDropdown = page
            .locator(
              "select#quantity, select[name='quantity'], select.a-native-dropdown",
            )
            .first();
          const qtyInput = page
            .locator(
              "input.quantity-text-input-with-label, div.quantity-text-input-container input",
            )
            .first();

          try {
            if (
              (await qtyDropdown.count()) > 0 &&
              (await qtyDropdown.isVisible())
            ) {
              log("Found quantity dropdown. Updating...");
              await qtyDropdown.selectOption(config.quantity.toString());
              await humanDelay(3000, 5000);
              log("Quantity successfully updated via dropdown.", "success");
            } else if (
              (await qtyInput.count()) > 0 &&
              (await qtyInput.isVisible())
            ) {
              log("Found quantity text input. Updating...");
              await qtyInput.fill(config.quantity.toString());
              await humanDelay(1000, 2000);

              await qtyInput.press("Enter");

              await page
                .waitForLoadState("domcontentloaded", { timeout: 5000 })
                .catch(() => {});
              await humanDelay(3000, 5000);
              log("Quantity successfully updated via text input.", "success");
            } else {
              log(
                `Warning: Quantity dropdown/input not found or not visible. Proceeding with default.`,
                "warn",
              );
            }
          } catch (err) {
            log(
              `Warning: Failed to update quantity to ${config.quantity}. Attempting to proceed anyway. Error: ${err.message}`,
              "warn",
            );
          }
        }

        // --- BUY NOW / ADD TO CART FALLBACK ---
        log("Looking for 'Buy Now' button...");
        const buyNowBtn = page.locator("#buy-now-button").first();
        let buyNowSuccess = false;

        if (
          (await buyNowBtn.count()) > 0 &&
          (await buyNowBtn.isVisible()) &&
          (await buyNowBtn.isEnabled())
        ) {
          try {
            log("Clicking 'Buy Now'...");
            await buyNowBtn.click({ timeout: 5000 });
            await page
              .waitForLoadState("commit", { timeout: 60000 })
              .catch(() => {});
            buyNowSuccess = true;
          } catch (e) {
            log(
              "Warning: 'Buy Now' button click failed or intercepted.",
              "warn",
            );
          }
        }

        if (!buyNowSuccess) {
          log(
            "Warning: 'Buy Now' button missing, disabled, or failed. Attempting 'Add to Cart' fallback...",
            "warn",
          );
          const addToCartBtn = page
            .locator(
              "#add-to-cart-button, input[name='submit.add-to-cart'], #freshAddToCartButton input, input[aria-labelledby='freshAddToCartButton-announce']",
            )
            .first();

          if (
            (await addToCartBtn.count()) > 0 &&
            (await addToCartBtn.isVisible())
          ) {
            await addToCartBtn.click({ timeout: 5000 });
            log(
              "Clicked 'Add to Cart'. Redirecting to Cart page...",
              "success",
            );
            await humanDelay(3000, 5000);

            log(
              `[Order ${orderIndex}/${totalOrders}] Bot stopped at Cart for manual review.`,
              "warn",
            );
            await page.goto("https://www.amazon.in/cart", {
              waitUntil: "commit",
              timeout: 60000,
            });
            await humanDelay(2000, 4000);

            try {
              await db
                .collection("automations")
                .doc(docId)
                .collection(email)
                .add({
                  order_number: orderIndex,
                  status: "Failed - Buy Now Unavailable (Added to Cart)",
                  product_link: config.productLink,
                  created_at: new Date().toISOString(),
                });
            } catch (e) {}

            keepOpenForUser = true;
            continue;
          } else {
            throw new Error(
              "Neither 'Buy Now' nor 'Add to Cart' buttons were available or working.",
            );
          }
        }

        // --- CHECKOUT: ADDRESS SELECTION ---
        log(
          `[Order ${orderIndex}/${totalOrders}] Checking Address Selection...`,
        );
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
          await page
            .waitForLoadState("commit", { timeout: 60000 })
            .catch(() => {});
        }

        // --- CHECKOUT: PAYMENT SELECTION ---
        log(
          `[Order ${orderIndex}/${totalOrders}] Handling Payment Selection for: ${config.paymentMethod}...`,
        );
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
            log("Selected Net Banking. Waiting for dropdown panel...");
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
                const dropdownTrigger = page
                  .locator(".a-dropdown-prompt")
                  .first();
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

        // =========================================================
        // --- FINAL GRAND TOTAL VALIDATION (MIN & MAX AMOUNT) ---
        // =========================================================
        log(
          `[Order ${orderIndex}/${totalOrders}] Verifying final Grand Total against limits...`,
        );
        await humanDelay(4000, 7000);

        // Updated locator targeting the exact DOM structure from your image
        const totalLocator = page
          .locator(
            'span[data-shimmer-target="ordertotals-amount"], .grand-total-price, #sc-subtotal-amount-buybox, span.payByLine, .order-summary-line-definition span',
          )
          .first();

        if ((await totalLocator.count()) > 0) {
          const rawTotalText = await totalLocator.innerText();
          const grandTotal = parseFloat(
            rawTotalText.replace(/[^\d.-]/g, ""),
          );

          // Support both naming conventions (minCheckoutTotal / minPrice & maxCheckoutTotal / maxPrice)
          const minLimit = parseFloat(
            config.minCheckoutTotal ?? config.minAmount ?? config.minPrice ?? 0,
          );
          const maxLimit = parseFloat(
            config.maxCheckoutTotal ?? config.maxAmount ?? config.maxPrice ?? Number.MAX_VALUE,
          );

          log(
            `Extracted Final Grand Total: ₹${grandTotal} (Allowed Range: ₹${minLimit} - ₹${maxLimit})`,
          );

          // Check both Min and Max limits
          if (grandTotal < minLimit || grandTotal > maxLimit) {
            log(
              `Condition Failed [Order ${orderIndex}]: Grand Total (₹${grandTotal}) is outside required range (₹${minLimit} - ₹${maxLimit}). Skipping order!`,
              "error",
            );

            await db
              .collection("automations")
              .doc(docId)
              .collection(email)
              .add({
                order_number: orderIndex,
                status: "Failed - Total Amount Outside Allowed Range",
                checkout_total: grandTotal,
                min_limit: minLimit,
                max_limit: maxLimit,
                product_link: config.productLink,
                created_at: new Date().toISOString(),
              });

            keepOpenForUser = true;
            continue; // Skip placing this order and move to next
          }

          log(
            `Grand Total ₹${grandTotal} verified successfully within allowed bounds (₹${minLimit} - ₹${maxLimit}).`,
            "success",
          );
        } else {
          log(
            "Warning: Grand Total price element not found on review page. Proceeding with caution...",
            "warn",
          );
        }

        // --- PLACE ORDER ---
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

          // ==========================================
          // REAL-TIME PAGE ANALYZER (PENDING / DUPLICATE ORDER CHECK)
          // ==========================================
          log(
            "Analyzing page in real-time for pending order warnings / redirects...",
          );

          const pendingPayBtn = page
            .locator(
              'input[value*="Pay with"], button:has-text("Pay with Net Banking"), span:has-text("Pay with Net Banking"), .a-button-input[aria-label*="Pay with"]',
            )
            .first();

          if (
            (await pendingPayBtn.count()) > 0 &&
            (await pendingPayBtn.isVisible())
          ) {
            log(
              "⚠️ Pending / Duplicate order screen detected! Clicking 'Pay with Net Banking'...",
              "warn",
            );
            await pendingPayBtn.click();
            await humanDelay(4000, 6000);
          }

          // Check if page navigated off Amazon to bank gateway
          const activeUrl = page.url().toLowerCase();
          const isActualBankGateway =
            !activeUrl.includes("amazon.in") ||
            activeUrl.includes("bank") ||
            activeUrl.includes("gateway");

          if (config.paymentMethod === "NETBANKING" && isActualBankGateway) {
            log("⚠️ ACTION REQUIRED: Bank Payment Gateway detected.", "warn");
            log(
              "Bot is PAUSED. Please complete the Net Banking payment manually. (60 seconds timeout)",
              "warn",
            );

            let timeElapsed = 0;
            let paymentSuccess = false;
            const maxWait = 60000;

            while (timeElapsed < maxWait) {
              try {
                const checkUrl = page.url().toLowerCase();
                if (
                  checkUrl.includes("amazon.in") &&
                  (checkUrl.includes("thankyou") ||
                    checkUrl.includes("your-orders") ||
                    checkUrl.includes("order-details") ||
                    checkUrl.includes("buy/thankyou"))
                ) {
                  paymentSuccess = true;
                  break;
                }
              } catch (err) {}
              await page.waitForTimeout(1000);
              timeElapsed += 1000;
            }

            if (!paymentSuccess) {
              log(
                "60 seconds limit reached on Payment Gateway. Proceeding to Orders page for verification...",
                "warn",
              );
            } else {
              log("Payment complete. Returned to Amazon.", "success");
            }

            await humanDelay(2000, 4000);
          } else {
            await page
              .waitForLoadState("commit", { timeout: 60000 })
              .catch(() => {});
            log("Order sequence submitted!", "success");
          }

          // --- FETCH ORDER DETAILS & UPDATE DB ---
          log(
            `[Order ${orderIndex}/${totalOrders}] Fetching Order Details from history...`,
          );
          await humanDelay(3000, 5000);

          const curUrl = page.url().toLowerCase();
          if (!curUrl.includes("your-orders/orders")) {
            await page.goto("https://www.amazon.in/your-orders/orders", {
              waitUntil: "commit",
              timeout: 60000,
            });
            await humanDelay(3000, 5000);
          }

          const firstOrderCard = page
            .locator(
              ".order-card, .js-order-card, .yohtmlc-order-card, .a-box-group",
            )
            .first();
          let orderBlockText = "";

          if ((await firstOrderCard.count()) > 0) {
            orderBlockText = await firstOrderCard.innerText();
          } else {
            orderBlockText = await page.innerText("body");
          }

          const orderIdMatch = orderBlockText.match(/\d{3}-\d{7}-\d{7}/);
          const orderId = orderIdMatch ? orderIdMatch[0] : "Not Found";

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
            `[Order ${orderIndex}/${totalOrders}] Captured -> ID: ${orderId} | Status: ${orderStatus} | Price: ${orderPrice}`,
            "success",
          );

          try {
            await db
              .collection("automations")
              .doc(docId)
              .collection(email)
              .add({
                order_number: orderIndex,
                order_id: orderId,
                product_name: capturedProductName,
                order_price: orderPrice,
                status: orderStatus,
                created_at: new Date().toISOString(),
              });

            await db.collection("automations").doc(docId).update({
              last_activity: new Date().toISOString(),
            });

            log(
              `Database sub-collection '${email}' updated for Order #${orderIndex}.`,
              "success",
            );
          } catch (e) {
            log(
              "Warning: Could not save final details to database (Network Timeout).",
              "warn",
            );
          }
        } else {
          throw new Error(
            "Could not locate the 'Place Order' button on the final page.",
          );
        }
      } catch (orderError) {
        log(`ERROR on Order #${orderIndex}: ${orderError.message}`, "error");
        keepOpenForUser = true;

        if (docId) {
          try {
            await db
              .collection("automations")
              .doc(docId)
              .collection("orders")
              .add({
                order_number: orderIndex,
                product_name: capturedProductName,
                status: "Failed - Execution Error",
                error_message: orderError.message,
                created_at: new Date().toISOString(),
              });
          } catch (e) {}
        }
      }

      if (orderIndex < totalOrders) {
        log(`Waiting 3 seconds before next order on current tab...`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }

    keepOpenForUser = true;
  } catch (error) {
    log(`ERROR: Sequence interrupted: ${error.message}`, "error");
    keepOpenForUser = true;

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