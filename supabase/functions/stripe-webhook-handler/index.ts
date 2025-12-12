import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Note: No "import Stripe" here. We use native fetch.

// === INIT CLIENTS ===
const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
);

// Initialize Stripe Keys
const STRIPE_KEYS = {
  test: {
    secret: Deno.env.get("STRIPE_SECRET_KEY_TEST"),
    webhook: Deno.env.get("STRIPE_WEBHOOK_SECRET_TEST"),
  },
  live: {
    secret: Deno.env.get("STRIPE_SECRET_KEY_LIVE"),
    webhook: Deno.env.get("STRIPE_WEBHOOK_SECRET_LIVE"),
  },
};

// === SENDGRID CONFIGURATION ===
const SENDGRID_API_KEY = Deno.env.get("CRM_SENDGRID_API_KEY");
const FROM_EMAIL = Deno.env.get("CRM_FROM_EMAIL") || "noreply@yourdomain.com";
const FROM_NAME = Deno.env.get("CRM_FROM_NAME") || "Your CRM Team";
const LOGIN_URL = "https://fxlabsprime.com";

// === CONFIGURATION ===
const PRICE_DURATION_DAYS = {
  test_3m: 90,
  test_1y: 365,
  international_3m: 90,
  international_1y: 365,
};

// === CRYPTO HELPER FOR SIGNATURE VERIFICATION ===
async function verifyStripeSignature(payload, headerSignature, secret) {
  const encoder = new TextEncoder();
  const parts = headerSignature.split(",");
  const timestamp = parts.find((p) => p.startsWith("t="))?.split("=")[1];
  const signature = parts.find((p) => p.startsWith("v1="))?.split("=")[1];

  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const signatureBytes = Uint8Array.from(signature.match(/.{1,2}/g).map((byte) => parseInt(byte, 16)));
  
  const isValid = await crypto.subtle.verify(
    "HMAC",
    key,
    signatureBytes,
    encoder.encode(signedPayload)
  );

  return isValid;
}

// === MAIN HANDLER ===
serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature) {
    return new Response("Missing signature", { status: 400 });
  }

  const rawBody = await req.text();
  let isTestMode = false;
  let activeSecretKey = "";

  // 1. Verify Signature (Try Test, then Live)
  const isTestValid = await verifyStripeSignature(rawBody, signature, STRIPE_KEYS.test.webhook);
  
  if (isTestValid) {
    isTestMode = true;
    activeSecretKey = STRIPE_KEYS.test.secret;
    console.log("🧪 Test mode webhook received");
  } else {
    const isLiveValid = await verifyStripeSignature(rawBody, signature, STRIPE_KEYS.live.webhook);
    if (isLiveValid) {
      isTestMode = false;
      activeSecretKey = STRIPE_KEYS.live.secret;
      console.log("🔴 Live mode webhook received");
    } else {
      console.error("❌ Invalid Signature (both test and live failed)");
      return new Response("Invalid signature", { status: 400 });
    }
  }

  const event = JSON.parse(rawBody);

  console.log(`📨 Received event: ${event.type}, ID: ${event.id}, Mode: ${isTestMode ? "TEST" : "LIVE"}`);

  try {
    if (event.type === "invoice.paid") {
      // Pass activeSecretKey for API calls
      return await handleInvoicePaid(event, isTestMode, activeSecretKey);
    }

    if (event.type === "checkout.session.completed") {
      console.log(`ℹ️ Checkout completed for ${event.data.object.customer_email}`);
    } else if (event.type === "invoice.payment_failed") {
      console.log(`⚠️ Payment failed for ${event.data.object.customer_email}`);
    }

    return new Response("OK - Event Logged", { status: 200 });
  } catch (err) {
    console.error(`❌ Error processing ${event.type}:`, err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// === THE LOGIC ===
async function handleInvoicePaid(event, isTestMode, stripeSecretKey) {
  const invoice = event.data.object;

  // 1. Skip $0 invoices
  if (invoice.amount_paid === 0) {
    console.log("ℹ️ Skipping $0 invoice");
    return new Response("OK", { status: 200 });
  }

  // 2. Extract Data
  const email = invoice.customer_email;
  const newStripeCustomerId = invoice.customer;
  const paymentIntentId = invoice.payment_intent || invoice.id;
  const receiptUrl = invoice.hosted_invoice_url;
  const amount = invoice.amount_paid / 100;
  const currency = (invoice.currency || "usd").toLowerCase();
  const now = new Date();

  if (!email) {
    console.error("❌ Invoice missing email, cannot identify user.");
    return new Response("Missing Email", { status: 400 });
  }

  // 3. IDENTIFY USER - Include converted_at in the select
  let { data: userMeta } = await supabase
    .from("crm_user_metadata")
    .select("user_id, email, subscription_ends_at, stripe_customer_id, converted_at")
    .or(`stripe_customer_id.eq.${newStripeCustomerId},email.eq.${email}`)
    .maybeSingle();

  let userId = userMeta?.user_id;
  let isNewUser = !userId;
  let generatedPassword = null;

  // === BRANCH A: NEW USER ===
  if (isNewUser) {
    console.log(`👤 Creating New User: ${email}`);
    generatedPassword = generatePassword();

    const { data: newUser, error: createErr } = await supabase.auth.admin.createUser({
      email: email,
      password: generatedPassword,
      email_confirm: true,
    });

    if (createErr) {
      if (createErr.message?.includes("already exists")) {
        console.log("⚠️ User exists in Auth, recovering...");
        const { data: existingUsers } = await supabase.auth.admin.listUsers();
        const existingUser = existingUsers.users?.find((u) => u.email === email);
        if (existingUser) {
          userId = existingUser.id;
          generatedPassword = null;
          isNewUser = false;
        } else {
          throw createErr;
        }
      } else {
        throw createErr;
      }
    } else {
      userId = newUser.user.id;
    }
  }

  // === BRANCH B: CALCULATE DURATION ===
  let durationDays = 30;
  const lineItem = invoice.lines?.data?.[0];

  if (lineItem?.price?.metadata?.priceId) {
    durationDays = PRICE_DURATION_DAYS[lineItem.price.metadata.priceId] ?? 30;
  } else if (lineItem?.period) {
    const start = lineItem.period.start;
    const end = lineItem.period.end;
    durationDays = Math.ceil((end - start) / 86400);
  }

  const basisDate = now;
  const newEndsAt = new Date(basisDate);
  newEndsAt.setUTCDate(newEndsAt.getUTCDate() + durationDays);

  // === BRANCH C: UPDATE DATABASE & SEND EMAIL ===
  if (isNewUser) {
    // --- NEW USER FLOW ---
    const priceId = lineItem?.price?.metadata?.priceId || "";
    let region = "International";
    if (priceId.includes("test")) region = isTestMode ? "Test" : "International";
    else if (priceId.includes("international")) region = "International";

    const { error: metaError } = await supabase.from("crm_user_metadata").insert({
      user_id: userId,
      email: email,
      stripe_customer_id: newStripeCustomerId,
      region: region,
      subscription_status: "paid",
      subscription_ends_at: newEndsAt.toISOString(),
      converted_at: now.toISOString(), // ✅ Set converted_at for new user
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
    if (metaError) throw metaError;

    if (generatedPassword) {
      console.log(`📧 Sending WELCOME Email to ${email}...`);
      await sendEmail(email, generatedPassword, durationDays, receiptUrl, "welcome");
    }
  } else {
    // --- EXISTING USER FLOW ---
    console.log(`🔄 Updating Existing User: ${email}`);

    // === ZOMBIE SUBSCRIPTION CLEANUP (Raw API Version) ===
    const storedStripeId = userMeta?.stripe_customer_id;

    if (storedStripeId && storedStripeId !== newStripeCustomerId) {
      console.log(`⚠️ DUPLICATE BILLING DETECTED. Cleaning up OLD ID: ${storedStripeId}`);

      try {
        // 1. Fetch Active Subs for OLD ID
        const subsResp = await fetch(
          `https://api.stripe.com/v1/subscriptions?customer=${storedStripeId}&status=active`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${stripeSecretKey}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
          }
        );
        
        const subsData = await subsResp.json();

        if (subsData.data) {
          // 2. Cancel them
          for (const sub of subsData.data) {
             console.log(`🧹 Cancelling old sub: ${sub.id}`);
             await fetch(`https://api.stripe.com/v1/subscriptions/${sub.id}`, {
               method: "DELETE",
               headers: {
                 Authorization: `Bearer ${stripeSecretKey}`,
               }
             });
          }
        }
      } catch (err) {
        console.error("❌ Failed to cleanup old subscriptions (API error):", err);
      }
    }

    // ✅ Build update object - set converted_at only if it's null
    const updateData = {
      subscription_status: "paid",
      subscription_ends_at: newEndsAt.toISOString(),
      stripe_customer_id: newStripeCustomerId,
      updated_at: now.toISOString(),
    };

    // Only set converted_at if it's not already set (first payment)
    if (!userMeta?.converted_at) {
      updateData.converted_at = now.toISOString();
      console.log(`💰 First payment detected - setting converted_at for ${email}`);
    }

    const { error: updateError } = await supabase
      .from("crm_user_metadata")
      .update(updateData)
      .eq("user_id", userId);
    if (updateError) throw updateError;

    console.log(`📧 Sending RENEWAL Email to ${email}...`);
    await sendEmail(email, null, durationDays, receiptUrl, "renewal");
  }

  // === STEP 4: RECORD PAYMENT ===
  const { error: payError } = await supabase.from("crm_payment").insert({
    user_id: userId,
    amount,
    currency,
    stripe_payment_id: paymentIntentId,
    paid_at: now.toISOString(),
    stripe_customer_id: newStripeCustomerId,
    receipt_url: receiptUrl,
  });

  if (payError) {
    if (payError.code === "23505") {
      console.warn(`⚠️ Payment ${paymentIntentId} already recorded.`);
    } else {
      console.error("❌ Payment insert failed:", payError);
    }
  }

  console.log(`✅ Success for ${email}`);
  return new Response("OK", { status: 200 });
}

// ==========================================
// === HELPER FUNCTIONS ===
// ==========================================

function generatePassword() {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => charset[byte % charset.length]).join("");
}

function createEmailTemplate(email, password, days, receiptUrl, type = "welcome") {
  const isWelcome = type === "welcome";
  const headline = isWelcome ? "Welcome Pro Trader" : "Subscription Renewed";
  const preheader = isWelcome
    ? `You have been added to FxLabs Prime. Your subscription covers ${days} days.`
    : `Your FxLabs Prime subscription has been renewed for ${days} days.`;

  const passwordRow = isWelcome
    ? `<tr>
         <td style="padding:8px 0; color:#555; font-weight:600;">Password:</td>
         <td style="padding:8px 0;">
           <span style="font-family: 'Courier New', monospace; background-color:#fff; padding:6px 12px; border-radius:4px; font-size:16px; font-weight:bold; color:#07c05c; letter-spacing:2px; border:1px solid #e6e7ec;">${password}</span>
         </td>
       </tr>`
    : "";

  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0; padding:0; background-color:#f6f7fb; font-family: Arial, Helvetica, sans-serif; color:#222;">
    <div style="display:none;font-size:1px;line-height:1px;max-height:0px;max-width:0px;opacity:0;overflow:hidden;">
      ${preheader}
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:90%; background:#07c05c; color:#ffffff; border-radius:12px; overflow:hidden;">
            <tr>
              <td style="padding:14px 16px;">
                <span style="font-weight:700; font-size:18px;">FxLabs Prime</span>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:30px;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:90%; background-color:#ffffff; border-radius:12px; padding:30px;">
            <tr>
              <td>
                <h1 style="text-align:center; font-size:32px; color:#04af47; margin:0 0 20px;">${headline}</h1>
                
                <p style="font-size:16px; line-height:1.6; color:#444; margin-bottom:20px; text-align:center;">
                  This is the requested test body text. It confirms that the system is functioning as expected and your invoice data is processed correctly.
                </p>

                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:2px solid #04af47; border-radius:12px; margin:16px 0;">
                  <tr>
                    <td style="padding:24px;">
                      <strong style="color:#111; font-size:15px;">Account Details</strong>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
                        <tr>
                          <td style="padding:8px 0; color:#555; font-weight:600;">Email:</td>
                          <td style="padding:8px 0;">${email}</td>
                        </tr>
                        ${passwordRow}
                        <tr>
                          <td style="padding:8px 0; color:#555; font-weight:600;">Duration:</td>
                          <td style="padding:8px 0;">${days} days</td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0; color:#555; font-weight:600;">Invoice:</td>
                          <td style="padding:8px 0;">
                             <a href="${receiptUrl}" style="color:#07c05c; text-decoration:underline; font-weight:bold;">View Receipt</a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <p style="text-align:center; margin-top:20px;">
                  <a href="${LOGIN_URL}" style="display:inline-block; background-color:#07c05c; color:#ffffff; text-decoration:none; padding:12px 32px; border-radius:6px; font-weight:bold;">
                    Open Dashboard
                  </a>
                </p>

              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}

async function sendEmail(email, password, days, receiptUrl, type = "welcome") {
  if (!SENDGRID_API_KEY) return { success: false, error: "No API Key" };

  const subject = type === "welcome" ? "Welcome to FxLabs Prime" : "FxLabs Prime: Subscription Renewed";
  const emailData = {
    personalizations: [{ to: [{ email }], subject: subject }],
    from: { email: FROM_EMAIL, name: FROM_NAME },
    content: [{ type: "text/html", value: createEmailTemplate(email, password, days, receiptUrl, type) }],
  };

  try {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SENDGRID_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(emailData),
    });
    
    if (response.ok) {
      console.log(`✅ Email sent to ${email}`);
      return { success: true };
    }
    console.error(`❌ SendGrid failed: ${await response.text()}`);
  } catch (error) {
    console.error(`❌ Email exception:`, error);
  }
}