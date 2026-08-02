/**
 * Worker function to scrape card details from Amazon Payment Statements.
 */
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

  // Block non-essential media assets to speed up page loads and prevent timeouts
  await context.route("**/*.{png,jpg,jpeg,pdf,svg,css,woff,woff2}", (route) =>
    route.abort(),
  );

  let docId = null;
  const page = await context.newPage();

  // Set default navigation timeout globally
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(20000);

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
      "https://www.amazon.in/ap/signin?openid.return_to=https%3A%2F%2Fwww.amazon.in%2F%3Fref_%3Dnav_signin&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=inflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0",
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

    // Unblock CSS specifically for statements page rendering if necessary
    await page.goto("https://www.amazon.in/gp/payment/statement", {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });

    // Explicitly wait for the Shadow DOM Root container to mount
    await page
      .waitForSelector("payui-transaction-history-list-view, body", {
        state: "visible",
        timeout: 30000,
      })
      .catch(() => log("Warning: Statement component load slow", "warn"));

    await humanDelay(3000, 5000);

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
      await humanDelay(4000, 6000);
    } else {
      log(
        `Warning: Could not find a filter for "${timePeriodLabel}". It may be too old or invalid.`,
        "warn",
      );
      throw new Error(`Filter ${timePeriodLabel} not found on page.`);
    }

    // ==========================================
    // 3. ITERATE THROUGH TRANSACTIONS (WITH INFINITE SCROLL)
    // ==========================================
    log("Scanning filtered list for transactions...");

    let hasMoreTransactions = true;
    let currentIndex = 0;
    let foundCardsCount = 0;

    while (hasMoreTransactions) {
      // Re-query rows dynamically on each loop to prevent stale references
      const transactionRows = page.locator(
        "payui-transaction-history-list-view .default-theme .transaction-item",
      );
      let totalRows = await transactionRows.count();
      console.log(`totalRows =>`, totalRows);

      if (totalRows === 0) {
        log("No transactions found for this filter.", "warn");
        hasMoreTransactions = false;
        break;
      }

      // INFINITE SCROLL LOGIC
      if (currentIndex >= totalRows) {
        log(
          `Reached end of currently loaded list (${totalRows}). Scrolling to bottom to load more...`,
          "info",
        );

        // Scroll to the absolute bottom of the page
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight),
        );

        // Wait exactly 10 seconds for Amazon's lazy-load AJAX to trigger and render
        log("Waiting 10 seconds for more transactions to load...");
        await page.waitForTimeout(10000);

        // Re-evaluate the total rows after scrolling
        const newTotalRows = await transactionRows.count();

        if (newTotalRows > totalRows) {
          log(
            `Success! Loaded ${newTotalRows - totalRows} more transactions. Resuming extraction...`,
            "success",
          );
          console.log(
            `Success! Loaded ${newTotalRows - totalRows} more transactions. Resuming extraction...`,
          );
          totalRows = newTotalRows; // The loop will now naturally continue processing currentIndex
          console.log(`totalRows =>`, totalRows);
        } else {
          log(
            `No more transactions loaded. Reached the absolute end at ${totalRows} transactions.`,
            "success",
          );
          console.log(
            `No more transactions loaded. Reached the absolute end at ${totalRows} transactions.`,
          );
          hasMoreTransactions = false;
          break;
        }
      }

      log(`Opening transaction ${currentIndex + 1} of ${totalRows}...`);

      const clickableRow = transactionRows
        .nth(currentIndex)
        .locator(".tux-cursor-pointer")
        .first();

      if ((await clickableRow.count()) === 0) {
        log(`Row at index ${currentIndex} not clickable. Skipping...`, "warn");
        // currentIndex++;
        continue;
      }

      await clickableRow.click().catch(async () => {
        // Fallback force click if UI element is overlapped
        await clickableRow.click({ force: true });
      });

      await humanDelay(2500, 4000);

      // ==========================================
      // 4. EXTRACT DETAILED TRANSACTION DATA
      // ==========================================
      log("Extracting transaction data points...");

      let tStatus = "Unknown Status";
      let tAmount = "Unknown Amount";

      // 4a & 4b. Status and Amount (Robust try/catch to prevent crashes)
      try {
        const headerTexts = await page
          .locator("payment-status-header tux-text")
          .allInnerTexts();

        // Extract Amount
        const amtMatch = headerTexts.find((text) => text.includes("₹"));
        if (amtMatch) {
          tAmount = amtMatch.trim();
        } else {
          // Safe fallback checking
          const fallbackLocator = page
            .locator("payment-status-header .tux-flex-row tux-text")
            .first();
          if ((await fallbackLocator.count()) > 0) {
            tAmount = await fallbackLocator.innerText({ timeout: 3000 });
          }
        }

        // Extract Status
        const statusMatch = headerTexts.find(
          (text) => !text.includes("₹") && text.trim().length > 0,
        );
        if (statusMatch) {
          tStatus = statusMatch.trim();
        }
      } catch (e) {
        log(
          "Warning: Failed to extract precise status or amount. Falling back to Unknown.",
          "warn",
        );
      }

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
        const pageText = await page.innerText("body").catch(() => "");
        const cardMatch = pageText.match(
          /(?:Visa|MasterCard|RuPay|Credit Card|Debit Card|Card).*?(?:ending in|ending with|\*\*)\s*(\d{4})/i,
        );
        if (cardMatch) tCard = cardMatch[0].trim();
      }

      // 4e. Order IDs
      const tOrderIdsRaw = await page
        .locator("payui-identifiers-entity tux-link")
        .allInnerTexts()
        .catch(() => []);
      const tOrderIds = tOrderIdsRaw
        .map((id) => id.replace(/,/g, "").trim())
        .filter(Boolean);

      // 4f. Dates (Strict mapping)
      const tDatesRaw = await page
        .locator("payui-identifiers-entity .identifier-value tux-text")
        .allInnerTexts()
        .catch(() => []);
      const tDates = tDatesRaw.map((d) => d.trim()).filter(Boolean);

      const dateRegex =
        /^\d{1,2}\s[A-Za-z]{3}\s\d{4},\s\d{1,2}:\d{2}\s(?:AM|PM)$/;
      const finalDates = {};
      let dateCount = 0;

      tDates.forEach((d) => {
        if (dateRegex.test(d)) {
          if (dateCount === 0) {
            finalDates["Order date"] = d;
          } else if (dateCount === 1) {
            finalDates["Expected Credit On"] = d;
          }
          dateCount++;
        }
      });

      log(`✅ Extracted: [${tStatus}] | ${tAmount} | ${tCard.slice(-8)}`);

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
        console.log("foundCardsCount =>", foundCardsCount);
      } catch (e) {
        log("Warning: Failed to save transaction details to database.", "warn");
      }

      // Return to statement list gracefully
      const backButton = page
        .locator(
          'tux-icon[name="chevron-left"], .back-button, button:has-text("Back")',
        )
        .first();

      if ((await backButton.count()) > 0 && (await backButton.isVisible())) {
        await backButton.click();
      } else {
        await page.goBack({ waitUntil: "domcontentloaded" });
      }

      await humanDelay(3000, 5000);
      currentIndex++;
    }

    log(
      `🎉 Finished scanning! Successfully saved ${foundCardsCount} detailed transaction(s) to the database for ${targetMonth}.`,
      "success",
    );
  } catch (error) {
    log(`ERROR: Scraping sequence interrupted: ${error.message}`, "error");
    console.log("error =>", error);
  } finally {
    if (context) {
      log("Closing isolated browser session...", "warn");
      await context.close();
    }
  }
}

module.exports = { fetchCardDetailsWorker };
