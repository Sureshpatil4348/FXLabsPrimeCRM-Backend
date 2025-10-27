import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.22.4";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import { genSaltSync, hashSync } from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";
// ========== SENDGRID CONFIGURATION ==========
const SENDGRID_API_KEY = Deno.env.get("CRM_SENDGRID_API_KEY");
const FROM_EMAIL = Deno.env.get("CRM_FROM_EMAIL");
const FROM_NAME = Deno.env.get("CRM_FROM_NAME");
const LOGIN_URL = "https://fxlabsprime-crm-qa.netlify.app/login/partner";
// ============================================
// Utility: Generate random 8-character alphanumeric password
function generatePassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  let password = '';
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  for(let i = 0; i < 8; i++){
    password += chars[array[i] % chars.length];
  }
  return password;
}
// Utility: Get JWT secret
function getJWTSecret() {
  const secret = Deno.env.get("CRM_CUSTOM_JWT_SECRET");
  if (!secret) {
    throw new Error("CRM_CUSTOM_JWT_SECRET environment variable is not set");
  }
  return new TextEncoder().encode(secret);
}
// Utility: JWT Secret error
function createJWTSecretErrorResponse() {
  return new Response(JSON.stringify({
    error: "JWT secret configuration error",
    code: "JWT_SECRET_ERROR"
  }), {
    status: 500,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
// Utility: Standard error response
function createErrorResponse(message, status = 500, code = null, details = []) {
  const errorResponse = {
    error: message
  };
  if (code) {
    errorResponse.code = code;
  }
  if (details.length > 0) {
    errorResponse.details = details;
  }
  return new Response(JSON.stringify(errorResponse), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
// Utility: Zod validation errors
function createValidationErrorResponse(zodError, status = 400) {
  const details = zodError.issues.map((issue)=>({
      field: issue.path.join("."),
      message: issue.message
    }));
  return createErrorResponse("Validation error", status, "VALIDATION_ERROR", details);
}
/**
 * Create email HTML template for partner
 */ function createEmailTemplate(email, password, fullName) {
  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <title>Welcome to FxLabs Prime Partner Program</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      .preheader { display:none !important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; overflow:hidden; mso-hide:all; }
      @media only screen and (max-width: 600px) {
        .container { width: 100% !important; }
      }
    </style>
  </head>
  <body style="margin:0; padding:0; background-color:#f6f7fb; font-family: Arial, Helvetica, sans-serif; color:#222;">
    <div class="preheader">
      Welcome to the FxLabs Prime Partner Program!
    </div>

    <!-- Header -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#07c05c; padding:16px 20px;">
      <tr>
        <td align="center" style="color:#fff; font-size:18px; font-weight:600;">
          FxLabs Prime Partner Program
        </td>
      </tr>
    </table>

    <!-- Main Body -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:30px;">
      <tr>
        <td align="center">
          <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:90%; background-color:#ffffff; border-radius:12px; padding:30px;">
            <tr>
              <td>
                <h2 style="margin:0 0 12px; color:#111;">Welcome, ${fullName}!</h2>
                <p style="margin:0 0 16px;">
                  You have been added to the <strong>FxLabs Prime Partner Program</strong>.
                </p>

                <!-- Credentials Box -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb; border:1px solid #e6e7ec; border-radius:8px; margin:16px 0;">
                  <tr>
                    <td style="padding:20px; font-size:14px; line-height:1.6;">
                      <strong style="color:#111; font-size:15px;">Your Partner Login Credentials</strong>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
                        <tr>
                          <td style="padding:8px 0; color:#555; font-weight:600;">Email:</td>
                          <td style="padding:8px 0; color:#111;">${email}</td>
                        </tr>
                        <tr>
                          <td style="padding:8px 0; color:#555; font-weight:600;">Password:</td>
                          <td style="padding:8px 0;">
                            <span style="font-family: 'Courier New', monospace; background-color:#fff; padding:6px 12px; border-radius:4px; font-size:16px; font-weight:bold; color:#07c05c; letter-spacing:2px; border:1px solid #e6e7ec;">${password}</span>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <!-- CTA -->
                <p style="margin:20px 0 0; text-align:center;">
                  <a href="${LOGIN_URL}" style="display:inline-block; background-color:#07c05c; color:#ffffff; text-decoration:none; padding:12px 32px; border-radius:6px; font-weight:bold; font-size:15px;" aria-label="Login to FxLabs Prime Partner Portal">
                    Login to Partner Portal
                  </a>
                </p>

                <!-- Important Notice -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff7e6; border:1px solid #ffd59e; border-radius:8px; margin:20px 0 0;">
                  <tr>
                    <td style="padding:14px 16px; font-size:14px; line-height:1.6; color:#663c00;">
                      <strong>⚠️ Important:</strong> Please change your password after your first login for security purposes. Go to <strong>Your Profile</strong> and update your password immediately.
                    </td>
                  </tr>
                </table>

                <!-- Support -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb; border:1px solid #e6e7ec; border-radius:8px; margin:16px 0 0;">
                  <tr>
                    <td style="padding:12px 16px; font-size:14px; line-height:1.6; color:#555;">
                      <strong style="color:#111;">Need help?</strong> Message us on Telegram:
                      <a href="https://t.me/Fxlabs_prime" target="_blank" rel="noopener noreferrer" style="color:#07c05c; text-decoration:none; font-weight:600;">@Fxlabs_prime</a>
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
        <td align="center" style="font-size:12px; color:#555; line-height:1.6; max-width:600px; padding:0 20px;">
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
 * Send email via SendGrid with 1 retry
 */ async function sendEmail(email, password, fullName) {
  if (!SENDGRID_API_KEY) {
    console.error("❌ SendGrid API key not configured");
    return {
      success: false,
      error: "Email service not configured"
    };
  }
  const emailData = {
    personalizations: [
      {
        to: [
          {
            email
          }
        ],
        subject: "Welcome to Your CRM - Partner Account Created"
      }
    ],
    from: {
      email: FROM_EMAIL,
      name: FROM_NAME
    },
    content: [
      {
        type: "text/html",
        value: createEmailTemplate(email, password, fullName)
      }
    ]
  };
  // Try sending email twice (initial + 1 retry)
  for(let attempt = 1; attempt <= 2; attempt++){
    try {
      console.log(`📧 Sending email to ${email} (attempt ${attempt}/2)`);
      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SENDGRID_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(emailData)
      });
      if (response.ok) {
        console.log(`✅ Email sent successfully to ${email}`);
        return {
          success: true
        };
      }
      const errorText = await response.text();
      console.error(`❌ SendGrid error for ${email} (${response.status}): ${errorText}`);
      if (attempt === 1) {
        console.log(`🔄 Retrying email to ${email}...`);
        await new Promise((resolve)=>setTimeout(resolve, 1000));
        continue;
      }
      return {
        success: false,
        error: `SendGrid error: ${response.status}`
      };
    } catch (error) {
      console.error(`❌ Exception sending email to ${email}:`, error);
      if (attempt === 1) {
        console.log(`🔄 Retrying email to ${email}...`);
        await new Promise((resolve)=>setTimeout(resolve, 1000));
        continue;
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "Network error"
      };
    }
  }
  return {
    success: false,
    error: "Failed after retry"
  };
}
// Initialize Supabase client
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase env vars not set");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
// Input validation schema (password removed)
const createPartnerSchema = z.object({
  full_name: z.string().min(1, "Full name is required"),
  email: z.string().email("Invalid email format"),
  commission_percent: z.number().int().min(0, "Commission must be ≥ 0").max(50, "Commission must be ≤ 50").optional().default(10)
});
serve(async (req)=>{
  if (req.method !== "POST") {
    return createErrorResponse("Method not allowed", 405);
  }
  try {
    // === 1. Validate Admin-Token ===
    const adminToken = req.headers.get("Admin-Token") ?? req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!adminToken) {
      return createErrorResponse("Admin-Token header required", 401);
    }
    let secret;
    try {
      secret = getJWTSecret();
    } catch (error) {
      return createJWTSecretErrorResponse();
    }
    const { payload } = await jwtVerify(adminToken, secret, {
      algorithms: [
        "HS256"
      ],
      issuer: Deno.env.get("CRM_JWT_ISSUER") ?? undefined,
      audience: Deno.env.get("CRM_JWT_AUDIENCE") ?? undefined
    });
    if (payload.role !== "admin") {
      return createErrorResponse("Admin access required", 403);
    }
    // === 2. Parse and validate request body ===
    let body;
    try {
      body = await req.json();
    } catch  {
      return createErrorResponse("Invalid JSON in request body", 400, "INVALID_JSON");
    }
    const validated = createPartnerSchema.parse(body);
    // === 3. Check if partner email already exists ===
    const normalizedEmail = validated.email.trim().toLowerCase();
    const { data: existing } = await supabase.from("crm_partner").select("id").eq("email", normalizedEmail).maybeSingle();
    if (existing) {
      return createErrorResponse("Partner with this email already exists", 409);
    }
    // === 4. Generate random password ===
    const generatedPassword = generatePassword();
    console.log(`🔑 Generated password for ${normalizedEmail}: ${generatedPassword}`);
    // === 5. Hash password and insert ===
    const cost = Number.parseInt(Deno.env.get("BCRYPT_COST") ?? "12", 10) || 12;
    const salt = genSaltSync(cost);
    const passwordHash = hashSync(generatedPassword, salt);
    const { data: inserted, error: insertError } = await supabase.from("crm_partner").insert({
      email: normalizedEmail,
      full_name: validated.full_name,
      password_hash: passwordHash,
      commission_percent: validated.commission_percent,
      is_active: true
    }).select("email, full_name").single();
    if (insertError) {
      if (insertError.code === "23505") {
        return createErrorResponse("Partner with this email already exists", 409);
      }
      console.error("Insert error:", insertError);
      return createErrorResponse("Failed to create partner", 500);
    }
    // === 6. Send welcome email ===
    const emailResult = await sendEmail(normalizedEmail, generatedPassword, validated.full_name);
    if (!emailResult.success) {
      console.warn(`⚠️ Partner created but email failed for ${normalizedEmail}: ${emailResult.error}`);
    }
    // === 7. Success ===
    return new Response(JSON.stringify({
      message: `Partner ${inserted.full_name} with Email - ${inserted.email} has been created successfully`,
      email_sent: emailResult.success,
      email_error: emailResult.error || null
    }), {
      status: 201,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createValidationErrorResponse(error);
    }
    if (error?.name === "JWTExpired" || error?.name === "JWSSignatureVerificationFailed") {
      return createErrorResponse("Invalid or expired Admin-Token", 401);
    }
    console.error("Unexpected error:", error);
    return createErrorResponse("Internal server error", 500);
  }
});
