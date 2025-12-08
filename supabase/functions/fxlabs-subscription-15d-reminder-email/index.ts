import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.22.4";

// SendGrid & App Config
const SENDGRID_API_KEY = Deno.env.get("CRM_SENDGRID_API_KEY");
const FROM_EMAIL = Deno.env.get("CRM_FROM_EMAIL") || "noreply@fxlabsprime.com";
const FROM_NAME = Deno.env.get("CRM_FROM_NAME") || "FxLabs Prime";
const DASHBOARD_URL = "https://crm.fxlabsprime.com/dashboard";
const PRICING_URL = "https://fxlabsprime.com/pricing";

// Max concurrent email sends
const MAX_CONCURRENT_EMAILS = 10;

function createErrorResponse(message: string, status = 500, code: string | null = null) {
  const res: any = { error: message };
  if (code) res.code = code;
  return new Response(JSON.stringify(res), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// === Validation ===
const userSchema = z.object({
  user_id: z.string().uuid(),
  email: z.string().email(),
  subscription_ends_at: z.string(),
});

const requestSchema = z.object({
  users: z.array(userSchema).min(1).max(100), // Max 100 users per batch
});

/**
 * Subscription expiry reminder email template
 */
function createSubscriptionExpiryReminderEmail(email: string, expiryDate: string): string {
  const formattedDate = new Date(expiryDate).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Subscription Expiring Soon - FxLabs Prime</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    .preheader { display:none !important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; }
    @media only screen and (max-width: 600px) { .container { width: 100% !important; } }
  </style>
</head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family: Arial, sans-serif; color:#222;">
  <div class="preheader">Your FxLabs Prime subscription expires in 15 days.</div>

  <!-- Header -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
    <tr>
      <td align="center">
        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:90%; background:#07c05c; color:#ffffff; border-radius:12px; overflow:hidden; font-family:Arial,Helvetica,sans-serif;">
          <tr>
            <td style="padding:14px 16px;">
              <span style="display:inline-block;vertical-align:middle;">
                <img src="https://hyajwhtkwldrmlhfiuwg.supabase.co/storage/v1/object/public/fxlabs-public/fxlabs_logo_white.png" width="18" height="18" alt="FxLabs Prime" style="vertical-align:middle;display:inline-block" />
              </span>
              <span style="display:inline-block;vertical-align:middle;font-weight:700;margin-left:8px;">FxLabs Prime</span>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

  <!-- Main -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:30px;">
    <tr>
      <td align="center">
        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:90%; background:#fff; border-radius:12px; padding:30px; box-shadow:0 4px 12px rgba(0,0,0,0.1);">
          <tr>
            <td>
              <h2 style="margin:0 0 12px; color:#111; font-size:20px;">Your Subscription is Expiring Soon</h2>
              <p style="margin:0 0 16px; color:#444;">
                Your <strong>FxLabs Prime</strong> subscription will expire in <strong>15 days</strong> on <strong>${formattedDate}</strong>.
              </p>

              <!-- Expiry Notice -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff4e6; border:1px solid #ffcc80; border-radius:8px; margin:16px 0;">
                <tr>
                  <td style="padding:20px;">
                    <div style="font-size:32px; text-align:center; margin-bottom:12px;">⏰</div>
                    <p style="margin:0; text-align:center; color:#e65100; font-size:16px; font-weight:600;">
                      Subscription ends on ${formattedDate}
                    </p>
                  </td>
                </tr>
              </table>

              <p style="margin:16px 0; color:#444;">
                Don't miss out on premium market insights, automated signals, and exclusive features! Renew your subscription today to continue enjoying:
              </p>

              <!-- Benefits -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;">
                <tr>
                  <td style="padding:8px 0; color:#444;">
                    <span style="color:#07c05c; font-weight:bold; margin-right:8px;">✓</span>
                    Real-time market analysis and signals
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#444;">
                    <span style="color:#07c05c; font-weight:bold; margin-right:8px;">✓</span>
                    Advanced technical indicators
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#444;">
                    <span style="color:#07c05c; font-weight:bold; margin-right:8px;">✓</span>
                    Priority support and updates
                  </td>
                </tr>
                <tr>
                  <td style="padding:8px 0; color:#444;">
                    <span style="color:#07c05c; font-weight:bold; margin-right:8px;">✓</span>
                    Exclusive trading strategies
                  </td>
                </tr>
              </table>

              <!-- CTA Buttons -->
              <p style="text-align:center; margin:24px 0;">
                <a href="${PRICING_URL}" style="background:#07c05c; color:#fff; padding:14px 36px; border-radius:6px; text-decoration:none; font-weight:bold; font-size:16px; display:inline-block; margin:0 8px 12px;">
                  Renew Subscription
                </a>
                <br/>
                <a href="${DASHBOARD_URL}" style="background:#fff; color:#07c05c; padding:12px 32px; border-radius:6px; text-decoration:none; font-weight:bold; font-size:14px; display:inline-block; border:2px solid #07c05c; margin:0 8px;">
                  View Dashboard
                </a>
              </p>

              <!-- Support -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fc; border:1px solid #e1e5eb; border-radius:8px; margin:20px 0 0;">
                <tr>
                  <td style="padding:12px 16px; font-size:14px; color:#555;">
                    <strong>Need help?</strong> Message us on Telegram: 
                    <a href="https://t.me/Fxlabs_prime" style="color:#07c05c; font-weight:600; text-decoration:none;">@Fxlabs_prime</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

  <!-- Footer -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px; padding:20px 0;">
    <tr>
      <td align="center" style="font-size:12px; color:#666; line-height:1.6; max-width:600px; padding:0 20px;">
        FxLabs Prime provides automated market insights and notifications for informational and educational purposes only.
        Nothing in this email constitutes financial advice, investment recommendations, or an offer to trade.
        Trading in forex, CFDs, or crypto involves high risk, and you may lose more than your initial investment.
        Data may be delayed or inaccurate; FxLabs Prime assumes no responsibility for any trading losses.
        Always verify information independently and comply with your local laws and regulations before acting on any signal.
        Use of this service implies acceptance of our
        <a href="https://fxlabsprime.com/terms-of-service" target="_blank" rel="noopener noreferrer" style="color:#07c05c; text-decoration:none;">Terms of Service</a>
        and
        <a href="https://fxlabsprime.com/privacy-policy" target="_blank" rel="noopener noreferrer" style="color:#07c05c; text-decoration:none;">Privacy Policy</a>.
        <br/><br/>
        Need help? Chat with us on Telegram:
        <a href="https://t.me/Fxlabs_prime" target="_blank" rel="noopener noreferrer" style="color:#07c05c; text-decoration:none;">@Fxlabs_prime</a>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}

/**
 * Send single email with retry (2 attempts per email)
 */
async function sendEmailToUser(
  email: string,
  expiryDate: string,
  userId: string
): Promise<{ success: boolean; email: string; user_id: string; error?: string }> {
  if (!SENDGRID_API_KEY) {
    return {
      success: false,
      email,
      user_id: userId,
      error: "SendGrid not configured",
    };
  }

  const payload = {
    personalizations: [
      {
        to: [{ email }],
        subject: "⏰ Your FxLabs Prime Subscription Expires in 15 Days",
      },
    ],
    from: {
      email: FROM_EMAIL,
      name: FROM_NAME,
    },
    content: [
      {
        type: "text/html",
        value: createSubscriptionExpiryReminderEmail(email, expiryDate),
      },
    ],
  };

  // Try twice (initial + 1 retry at email level)
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SENDGRID_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        return { success: true, email, user_id: userId };
      }

      const err = await res.text();
      
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      return {
        success: false,
        email,
        user_id: userId,
        error: `SendGrid error: ${res.status}`,
      };
    } catch (e) {
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      return {
        success: false,
        email,
        user_id: userId,
        error: e instanceof Error ? e.message : "Network error",
      };
    }
  }

  return {
    success: false,
    email,
    user_id: userId,
    error: "Failed after retry",
  };
}

/**
 * Process batch with concurrency control and batch-level retry for failed emails
 * Total retry strategy:
 * - Each email: 2 attempts (initial + 1 retry) in sendEmailToUser
 * - Batch level: 3 attempts (initial + 2 retries) for failed emails
 * - Max total attempts per email: up to 6 (2 attempts × 3 batch retries)
 */
async function processBatchWithRetry(users: z.infer<typeof userSchema>[]) {
  const allResults: Array<{
    success: boolean;
    email: string;
    user_id: string;
    error?: string;
    attempts?: number;
  }> = [];

  let currentUsers = users;
  let retryAttempt = 0;
  const maxBatchRetries = 2; // Total of 3 attempts (initial + 2 retries)

  while (retryAttempt <= maxBatchRetries && currentUsers.length > 0) {
    console.log(
      `Batch attempt ${retryAttempt + 1}/${maxBatchRetries + 1} for ${currentUsers.length} users`
    );

    const attemptResults: Array<{
      success: boolean;
      email: string;
      user_id: string;
      error?: string;
    }> = [];

    // Process in chunks to control concurrency
    for (let i = 0; i < currentUsers.length; i += MAX_CONCURRENT_EMAILS) {
      const chunk = currentUsers.slice(i, i + MAX_CONCURRENT_EMAILS);

      const chunkResults = await Promise.all(
        chunk.map((user) =>
          sendEmailToUser(user.email, user.subscription_ends_at, user.user_id)
        )
      );

      attemptResults.push(...chunkResults);
    }

    // Separate successful and failed
    const successful = attemptResults.filter((r) => r.success);
    const failed = attemptResults.filter((r) => !r.success);

    // Add successful results with attempt count
    allResults.push(
      ...successful.map((r) => ({
        ...r,
        attempts: retryAttempt + 1,
      }))
    );

    console.log(
      `Attempt ${retryAttempt + 1}: ${successful.length} sent, ${failed.length} failed`
    );

    // If no failures or last retry attempt, we're done
    if (failed.length === 0 || retryAttempt === maxBatchRetries) {
      // Add final failed results with attempt count
      if (failed.length > 0) {
        allResults.push(
          ...failed.map((r) => ({
            ...r,
            attempts: retryAttempt + 1,
          }))
        );
      }
      break;
    }

    // Prepare failed users for retry
    currentUsers = failed.map((r) => {
      const user = users.find((u) => u.user_id === r.user_id);
      return user!;
    });

    retryAttempt++;

    // Wait before retry (exponential backoff)
    const waitTime = Math.min(1000 * Math.pow(2, retryAttempt), 5000); // Max 5s
    console.log(`Waiting ${waitTime}ms before retry...`);
    await new Promise((r) => setTimeout(r, waitTime));
  }

  return allResults;
}

// === MAIN HANDLER ===
serve(async (req) => {
  if (req.method !== "POST") {
    return createErrorResponse("Method not allowed", 405);
  }

  try {
    // Verify service role key
    const authHeader = req.headers.get("Authorization");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== serviceRoleKey) {
      return createErrorResponse("Unauthorized", 401, "UNAUTHORIZED");
    }

    // Parse & Validate Body
    let body;
    try {
      body = await req.json();
    } catch {
      return createErrorResponse("Invalid JSON", 400, "INVALID_JSON");
    }

    const validated = requestSchema.parse(body);

    console.log(`Processing batch of ${validated.users.length} users`);

    // Process batch with retry
    const results = await processBatchWithRetry(validated.users);

    const successful = results.filter((r) => r.success);
    const failed = results.filter((r) => !r.success);

    console.log(
      `Batch complete: ${successful.length} sent, ${failed.length} failed after all retries`
    );

    // Return results
    return new Response(
      JSON.stringify({
        message: "Batch processing complete",
        total: validated.users.length,
        successful: successful.length,
        failed: failed.length,
        results: {
          successful: successful.map((r) => ({ 
            email: r.email, 
            user_id: r.user_id,
            attempts: r.attempts 
          })),
          failed: failed.map((r) => ({
            email: r.email,
            user_id: r.user_id,
            error: r.error,
            attempts: r.attempts
          })),
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      const details = error.issues.map((i) => ({
        field: i.path.join("."),
        message: i.message,
      }));
      return new Response(
        JSON.stringify({
          error: "Validation error",
          code: "VALIDATION_ERROR",
          details,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    console.error("Unexpected error:", error);
    return createErrorResponse("Internal server error", 500, "INTERNAL_ERROR");
  }
});