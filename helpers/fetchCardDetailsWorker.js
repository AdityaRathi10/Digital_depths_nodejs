async function fetchCardDetailsWorker(browser, email, targetMonth, socket, db) {
  const log = (msg, type = "info") =>
    socket.emit("log", { type, msg: `[${email} - Card Scraper] ${msg}` });

  const context = await browser.newContext({
    viewport: null,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  let docId = null;
  const page = await context.newPage();

  const humanDelay = async (min = 2500, max = 5500) => {
    const ms = Math.floor(Math.random() * (max - min + 1)) + min;
    log(`[Bot-Evasion] Pausing for ${ms}ms...`);
    await page.waitForTimeout(ms);
  };

  try {
    log(`Step 1: Fetching credentials for ${email}...`);
    const snapshot = await db
      .collection("automations")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (snapshot.empty || !snapshot.docs[0].data().password) {
      log("Condition Failed: Email or Password missing in database.", "error");
      return;
    }

    docId = snapshot.docs[0].id;
    const password = snapshot.docs[0].data().password;

    // ==========================================
    // 1. STANDARD LOGIN SEQUENCE (WITH OTP INTERCEPT)
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
          timeout: 300000,
        });
        log("Manual verification complete. Resuming automation...", "success");
        await humanDelay(2000, 4000);
      } catch (e) {
        throw new Error("Failed due to OTP Timeout.");
      }
    } else {
      log("Sign-In successful.", "success");
    }

    // ==========================================
    // 2. NAVIGATE TO STATEMENTS & APPLY FILTERS
    // ==========================================
    log("Navigating to Amazon Payment Statements...");
    await page.goto("https://www.amazon.in/gp/payment/statement", {
      waitUntil: "commit",
      timeout: 60000,
    });
    await humanDelay(4000, 6000);

    // Apply Payment Mode Filter
    log("Applying 'Credit/Debit Card' filter...");
    const cardFilterRadio = page
      .locator(`tux-text:has-text("Credit/Debit Card")`)
      .first();
    if (
      (await cardFilterRadio.count()) > 0 &&
      (await cardFilterRadio.isVisible())
    ) {
      await cardFilterRadio.click();
      log(
        `Payment mode filter applied. Waiting for table refresh...`,
        "success",
      );
      await humanDelay(3000, 5000);
    } else {
      log(
        `Warning: 'Credit/Debit Card' filter not found. Proceeding anyway.`,
        "warn",
      );
    }

    // Apply Time Period Filter
    const currentYear = new Date().getFullYear();
    const timePeriodLabel = `${targetMonth} ${currentYear}`;

    log(`Applying time period filter for: ${timePeriodLabel}...`);
    const filterRadio = page
      .locator(`tux-text:has-text("${timePeriodLabel}")`)
      .first();

    if ((await filterRadio.count()) > 0 && (await filterRadio.isVisible())) {
      await filterRadio.click();
      log(
        `Time filter applied. Waiting for transactions to load...`,
        "success",
      );
      await humanDelay(4000, 7000);
    } else {
      log(
        `Warning: Could not find a filter for "${timePeriodLabel}". It may be too old or invalid.`,
        "warn",
      );
      throw new Error(`Filter ${timePeriodLabel} not found on page.`);
    }

    // ==========================================
    // 3. ITERATE THROUGH TRANSACTIONS
    // ==========================================
    log("Scanning filtered list for transactions...");

    let hasMoreTransactions = true;
    let currentIndex = 0;
    let foundCardsCount = 0;

    while (hasMoreTransactions) {
      // Re-evaluate list dynamically to avoid Stale Element Reference errors
      const transactionRows = page.locator(
        "payui-transaction-history-list-view .default-theme .transaction-item",
      );
      const totalRows = await transactionRows.count();

      if (currentIndex >= totalRows) {
        hasMoreTransactions = false;
        break;
      }

      log(`Opening transaction ${currentIndex + 1} of ${totalRows}...`);

      const clickableRow = transactionRows
        .nth(currentIndex)
        .locator(".tux-cursor-pointer")
        .first();
      await clickableRow.click();

      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await humanDelay(3000, 5000);

      // ==========================================
      // 4. EXTRACT DETAILED TRANSACTION DATA
      // ==========================================
      log("Extracting transaction data points...");

      // 4a. Status
      const tStatus = await page
        .locator(
          "payment-status-header .payment-status-bubble-wrapper tux-text",
        )
        .first()
        .innerText({ timeout: 3000 })
        .catch(() => "Unknown Status");

      // 4b. Amount
      const headerTexts = await page
        .locator("payment-status-header tux-text")
        .allInnerTexts()
        .catch(() => []);

      const amtMatch = headerTexts.find((text) => text.includes("₹"));
      const tAmount =
        amtMatch?.trim() ||
        (await page
          .locator("payment-status-header .tux-flex-row tux-text")
          .first()
          .innerText({ timeout: 3000 })
          .catch(() => "Unknown Amount"));

      // 4c. Product Name
      const tProduct = await page
        .locator('div[part="title"] span, .title-below span')
        .first()
        .innerText({ timeout: 3000 })
        .catch(() => "Unknown Product");

      // 4d. Card Details
      let tCard = "Unknown Card";
      const cardEl = page
        .locator('payment-method-entity tux-text:has-text("**")')
        .first();
      if ((await cardEl.count()) > 0) {
        tCard = await cardEl
          .innerText({ timeout: 3000 })
          .catch(() => "Unknown Card");
      } else {
        // Regex Fallback
        const pageText = await page.innerText("body").catch(() => "");
        const cardMatch = pageText.match(
          /(?:Visa|MasterCard|RuPay|Credit Card|Debit Card|Card).*?(?:ending in|ending with|\*\*)\s*(\d{4})/i,
        );
        if (cardMatch) tCard = cardMatch[0].trim();
      }

      // 4e. Order IDs (Multiple)
      const tOrderIdsRaw = await page
        .locator("payui-identifiers-entity tux-link")
        .allInnerTexts()
        .catch(() => []);
      const tOrderIds = tOrderIdsRaw
        .map((id) => id.replace(/,/g, "").trim())
        .filter((id) => id);

      // 4f. Dates (Multiple)
      const tDatesRaw = await page
        .locator("payui-identifiers-entity .identifier-value tux-text")
        .allInnerTexts()
        .catch(() => []);
      const tDates = tDatesRaw.map((d) => d.trim()).filter((d) => d);

      const dateRegex =
        /^\d{1,2}\s[A-Za-z]{3}\s\d{4},\s\d{1,2}:\d{2}\s(?:AM|PM)$/;
      const finalDates = {};
      let dateCount = 0;

      tDates
        .map((d) => d.trim())
        .forEach((d) => {
          if (dateRegex.test(d)) {
            if (dateCount === 0) {
              finalDates["order date"] = d;
            } else if (dateCount === 1) {
              finalDates["Expected Credit On"] = d;
            }
            dateCount++;
          }
        });

      log(
        `✅ Extracted: [${tStatus}] | ${tAmount} | ${tCard.substring(tCard.length - 8)}`,
      );

      console.log({
        tStatus,
        tAmount,
        tProduct,
        tCard: tCard.replace(/\D/g, ""),
        tOrderIds,
        finalDates,
        timePeriodLabel,
      });

      // ==========================================
      // 5. SAVE TO DATABASE
      // ==========================================
      try {
        await db
          .collection("automations")
          .doc(docId)
          .collection("card-details")
          .add({
            type: "Transaction Detail",
            status: tStatus,
            amount: tAmount,
            product_name: tProduct,
            card_details: tCard.replace(/\D/g, ""),
            order_ids: tOrderIds,
            transaction_dates: finalDates,
            statement_month: timePeriodLabel,
            created_at: new Date().toISOString(),
          });
        foundCardsCount++;
      } catch (e) {
        log("Warning: Failed to save transaction details to database.", "warn");
      }

      // Go back to the main statement list for the next iteration
      await page.goBack();
      await page.waitForLoadState("domcontentloaded").catch(() => {});

      // Crucial: Wait for the Shadow DOM list component to rebuild
      await humanDelay(4000, 6000);

      currentIndex++;
    }

    log(
      `🎉 Finished scanning! Successfully saved ${foundCardsCount} detailed transaction(s) to the database for ${targetMonth}.`,
      "success",
    );
  } catch (error) {
    log(`ERROR: Scraping sequence interrupted: ${error.message}`, "error");
  } finally {
    if (context) {
      log("Closing isolated browser session...", "warn");
      await context.close();
    }
  }
}

module.exports = { fetchCardDetailsWorker };
