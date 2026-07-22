async function runAccountSetupWorker(browser, email, password, socket, db) {
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

  try {
    log("Step 1: Saving credentials to Firebase DB...");

    const snapshot = await db
      .collection("automations")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      docId = snapshot.docs[0].id;
      await db.collection("automations").doc(docId).update({
        password: password,
        updated_at: new Date().toISOString(),
      });
      log("Existing account entry updated in Firebase.");
    } else {
      const newDoc = await db.collection("automations").add({
        email: email,
        password: password,
        status: "Pending Verification",
        created_at: new Date().toISOString(),
      });
      docId = newDoc.id;
      log("New account entry saved to Firebase.");
    }

    page = await context.newPage();

    const humanDelay = async (min = 2500, max = 5000) => {
      const ms = Math.floor(Math.random() * (max - min + 1)) + min;
      log(`[Bot-Evasion] Pausing for ${ms}ms...`);
      await page.waitForTimeout(ms);
    };

    // ==========================================
    // 1. AMAZON SIGN-IN & EXISTENCE CHECK
    // ==========================================
    log("Opening browser and navigating to Amazon Sign-In...");
    await page.goto(
      "https://www.amazon.in/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.in%2F%3Fref_%3Dnav_ya_signin&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=inflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0",
      { waitUntil: "commit", timeout: 60000 },
    );
    await humanDelay(2000, 3500);

    const emailLocator = page
      .locator("input[type='email'], input[name='email'], #ap_email")
      .first();
    await emailLocator.waitFor({ state: "visible", timeout: 15000 });
    await emailLocator.fill(email);
    await humanDelay(1500, 2500);
    await page
      .locator("#continue, input.a-button-input, #continue-announce")
      .first()
      .click();
    await humanDelay(2000, 3500);

    const emailErrorBox = page
      .locator(
        "#auth-error-message-box, #auth-warning-message-box, .a-alert-content:has-text('Cannot find an account')",
      )
      .first();
    if (
      (await emailErrorBox.count()) > 0 &&
      (await emailErrorBox.isVisible())
    ) {
      const errorMsg = await emailErrorBox.innerText();
      log(
        `Condition Failed: User account does not exist or Amazon rejected email: ${errorMsg.trim()}`,
        "error",
      );
      await db
        .collection("automations")
        .doc(docId)
        .update({ status: "Invalid Email / Account Missing" });
      return;
    }

    const passwordLocator = page
      .locator("input[type='password'], #ap_password, input[name='password']")
      .first();
    await passwordLocator.waitFor({ state: "visible", timeout: 15000 });
    await passwordLocator.fill(password);
    await humanDelay(1500, 2500);

    await page
      .locator("#signInSubmit, input[type='submit']#signInSubmit")
      .first()
      .click();
    log("Submitted password. Waiting for Amazon response...");

    // Wait for Amazon redirects
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    await humanDelay(3000, 5000);

    // Check 1: Password Error
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
      await db
        .collection("automations")
        .doc(docId)
        .update({ status: "Invalid Password" });
      return;
    }

    // Check 2: OTP / Captcha / Approval Interception
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
        // Pause automation until the main Amazon Navigation bar loads (indicating successful login)
        await page.waitForSelector("#nav-logo, #nav-cart, #nav-belt", {
          state: "attached",
          timeout: 600000,
        });
        log("Manual verification complete. Resuming automation...", "success");
        await humanDelay(2000, 4000);
      } catch (e) {
        log(
          "Condition Failed: Manual verification timed out after 5 minutes.",
          "error",
        );
        await db
          .collection("automations")
          .doc(docId)
          .update({ status: "Failed (OTP Timeout)" });
        return;
      }
    } else {
      log("Sign-In successful (No OTP required).", "success");
    }

    await humanDelay(2000, 4000);

    // ==========================================
    // 2. CHECK & CLEAR CART
    // ==========================================
    log("Navigating to Cart page...");
    await page.goto("https://www.amazon.in/gp/cart/view.html", {
      waitUntil: "commit",
      timeout: 60000,
    });
    await humanDelay(2500, 4500);

    const emptyCartHeader = page
      .locator("#sc-active-cart h2, .sc-your-amazon-cart-is-empty")
      .first();
    const deleteButtons = page.locator(
      ".sc-action-delete input, input[value='Delete'], span[data-action='delete'] input",
    );

    let itemCount = await deleteButtons.count();

    if (
      itemCount === 0 ||
      ((await emptyCartHeader.count()) > 0 &&
        (await emptyCartHeader.innerText()).includes("empty"))
    ) {
      log("Cart Status: Shopping cart is currently empty.", "info");
    } else {
      log(
        `Cart Status: Found items in cart. Beginning removal of ${itemCount} item(s)...`,
        "warn",
      );

      while (itemCount > 0) {
        log("Deleting cart item...");
        const firstDelete = deleteButtons.first();
        await firstDelete.click();
        await humanDelay(2000, 3500);
        itemCount = await deleteButtons.count();
      }
      log(
        "Cart cleared successfully. No products remaining in cart.",
        "success",
      );
    }

    // ==========================================
    // 3. ADDRESS CHECK & DB STORAGE
    // ==========================================
    log("Navigating to Saved Addresses page...");
    await page.goto("https://www.amazon.in/a/addresses", {
      waitUntil: "commit",
      timeout: 60000,
    });
    await humanDelay(3000, 5000);

    const addressBoxes = page.locator(
      ".a-box.a-spacing-none, #ya-myab-address-box-0, div[id*='address-tile']",
    );
    const totalAddresses = await addressBoxes.count();

    if (totalAddresses === 0) {
      log("Condition Check: No saved addresses found on this account.", "warn");
      await db.collection("automations").doc(docId).update({
        has_addresses: false,
        addresses: [],
        status: "Verified (No Addresses)",
        updated_at: new Date().toISOString(),
      });
    } else {
      log(`Found ${totalAddresses} address box(es). Extracting details...`);
      const extractedAddresses = [];

      for (let i = 0; i < totalAddresses; i++) {
        const text = await addressBoxes.nth(i).innerText();
        const cleanAddress = text
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
          .join(", ");
        if (cleanAddress) {
          extractedAddresses.push(cleanAddress);
        }
      }

      log(
        `Extracted ${extractedAddresses.length} address string(s). Saving to Firebase...`,
        "success",
      );

      await db.collection("automations").doc(docId).update({
        has_addresses: true,
        addresses: extractedAddresses,
        status: "Verified & Ready",
        updated_at: new Date().toISOString(),
      });
      log("Addresses successfully saved to Firebase database.", "success");
    }
  } catch (error) {
    log(`Setup Error: ${error.message}`, "error");
    if (docId) {
      await db
        .collection("automations")
        .doc(docId)
        .update({
          status: "Failed Verification",
          error_message: error.message,
        })
        .catch((e) => console.error(e));
    }
  } finally {
    if (context) {
      log("Closing browser session...");
      await context.close();
    }
  }
}

module.exports = { runAccountSetupWorker };
