async function runAutomatonWorker(context, email, config, socket, db) {
  const log = (msg, type = "info") =>
    socket.emit("log", { type, msg: `[${email}] ${msg}` });
  let page;

  try {
    log("Fetching credentials from Firestore...");

    // Query the 'automations' collection by the email field
    const snapshot = await db
      .collection("automations")
      .where("email", "==", email)
      .limit(1)
      .get();

    // Condition 1: Email not found in the database
    if (snapshot.empty) {
      log(
        "Condition Failed: Account email not found in database. Stopping.",
        "error",
      );
      return;
    }

    const accountData = snapshot.docs[0].data();

    // Condition 2: Password not found for this email
    if (!accountData.password) {
      log(
        "Condition Failed: Password missing in database for this email. Stopping.",
        "error",
      );
      return;
    }

    const password = accountData.password;

    page = await context.newPage();

    log("Navigating to Amazon login...");

    // Wait for DOM content to load to prevent rushing the page
    await page.goto(
      "https://www.amazon.in/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.in%2F%3Fref_%3Dnav_ya_signin&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=inflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0",
      { waitUntil: "domcontentloaded" },
    );

    try {
      // Use a robust locator and explicit wait for the email field
      const emailLocator = page
        .locator('input[name="email"], #ap_email')
        .first();
      await emailLocator.waitFor({ state: "visible", timeout: 15000 });

      await emailLocator.fill(email);
      await page.click("input#continue");
    } catch (e) {
      // Capture what Amazon actually displayed (e.g., CAPTCHA)
      const errorScreenshot = `public/error-email-${email.split("@")[0]}.png`;
      await page.screenshot({ path: errorScreenshot });
      throw new Error(
        `Email field not found. Amazon likely blocked the request or showed a CAPTCHA. Check the screenshot at ${errorScreenshot}`,
      );
    }

    try {
      // Use a robust locator and explicit wait for the password field
      const passwordLocator = page
        .locator('input[name="password"], #ap_password')
        .first();
      await passwordLocator.waitFor({ state: "visible", timeout: 15000 });

      await passwordLocator.fill(password);

      // Playwright Best Practice: Wait for navigation while clicking a submit button
      await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click("input#signInSubmit"),
      ]);
    } catch (e) {
      const errorScreenshot = `public/error-password-${email.split("@")[0]}.png`;
      await page.screenshot({ path: errorScreenshot });
      throw new Error(
        `Password field not found. Amazon might have asked for an OTP. Check the screenshot at ${errorScreenshot}`,
      );
    }

    log("Login successful. Navigating to product link...");
    await page.goto(config.productLink, { waitUntil: "domcontentloaded" });

    log("Evaluating product price...");

    // Playwright Locators are much cleaner
    const priceLocator = page.locator(".a-price-whole").first();

    if ((await priceLocator.count()) > 0) {
      let priceText = await priceLocator.innerText();
      let currentPrice = parseFloat(priceText.replace(/,/g, ""));

      if (currentPrice > parseFloat(config.maxPrice)) {
        log(
          `Condition Failed: Price (₹${currentPrice}) exceeds Max Limit (₹${config.maxPrice}).`,
          "error",
        );
        await page.close();
        return;
      }
      log(`Price check passed: ₹${currentPrice}`);
    }

    if (parseInt(config.quantity) > 1) {
      log(`Adjusting quantity to ${config.quantity}`);
      await page.selectOption("select#quantity", config.quantity.toString());
      await page.waitForTimeout(1000);
    }

    log("Proceeding to checkout...");
    await Promise.all([
      page.waitForNavigation(),
      page.click("#buy-now-button"),
    ]);

    const totalLocator = page.locator(".grand-total-price").first();
    if ((await totalLocator.count()) > 0) {
      let totalText = await totalLocator.innerText();
      let grandTotal = parseFloat(totalText.replace(/[^\d.-]/g, ""));

      if (grandTotal > parseFloat(config.maxCheckoutTotal)) {
        log(
          `Condition Failed: Grand Total (₹${grandTotal}) exceeds limit (₹${config.maxCheckoutTotal}).`,
          "error",
        );
        await page.close();
        return;
      }
    }

    log(`Selecting payment method: ${config.paymentMethod}`);
    // await page.click('input[value="instrumentId=Cash"]');

    log(
      "Conditions met. Order ready for placement (Simulation ending).",
      "success",
    );
  } catch (error) {
    log(`Automation error: ${error.message}`, "error");
    if (page) await page.close();
  }
}

module.exports = { runAutomatonWorker };
