import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import { z } from "https://esm.sh/zod@3.22.4";
// ========== SENDGRID CONFIGURATION ==========
const SENDGRID_API_KEY = Deno.env.get("CRM_SENDGRID_API_KEY");
const FROM_EMAIL = Deno.env.get("CRM_FROM_EMAIL") || "noreply@yourdomain.com";
const FROM_NAME = Deno.env.get("CRM_FROM_NAME") || "Your CRM Team";
const LOGIN_URL = "https://fxlabsprime.com";
// ============================================
// JWT utilities
function getJWTSecret() {
  const secret = Deno.env.get("CRM_CUSTOM_JWT_SECRET");
  if (!secret) {
    throw new Error("CRM_CUSTOM_JWT_SECRET environment variable is not set");
  }
  return new TextEncoder().encode(secret);
}
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
function createErrorResponse(message, status = 500, code = null, details = []) {
  const errorResponse = {
    error: message
  };
  if (code) errorResponse.code = code;
  if (details?.length > 0) errorResponse.details = details;
  return new Response(JSON.stringify(errorResponse), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
function createValidationErrorResponse(zodError, status = 400) {
  const details = zodError.issues.map((issue)=>({
      field: issue.path?.join(".") || "",
      message: issue.message
    }));
  return createErrorResponse("Validation error", status, "VALIDATION_ERROR", details);
}
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
// Configuration
const rawTrial = Deno.env.get("CRM_DEFAULT_TRIAL_DAYS");
const parsedTrial = Number.parseInt(rawTrial ?? "", 10);
const DEFAULT_TRIAL_DAYS = Number.isFinite(parsedTrial) && parsedTrial >= 1 ? parsedTrial : 15;
// Validation schema
const createUserSchema = z.object({
  users: z.array(z.object({
    email: z.string().email("Invalid email format")
  })).min(1, "At least one user is required"),
  region: z.enum([
    "India",
    "International"
  ], {
    errorMap: ()=>({
        message: "Region must be 'India' or 'International'"
      })
  }),
  trial_days: z.number().int().min(1, "trial_days must be a positive integer").optional().default(DEFAULT_TRIAL_DAYS)
});
/**
 * Generate 8-digit alphanumeric password
 */ function generatePassword() {
  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  return Array.from(array, (byte)=>charset[byte % charset.length]).join("");
}
/**
 * Create email HTML template
 */
function createEmailTemplate(email, password, trialDays) {
  return `
<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
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
      You have been added to FxLabs Prime. Your trial ends in ${trialDays} days.
    </div>

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

    <!-- Main Body -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:30px;">
      <tr>
        <td align="center">
          <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:90%; background-color:#ffffff; border-radius:12px; padding:30px;">
            <tr>
              <td>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 12px;">
                  <tr>
                    <td align="center" style="padding:0;">
                      <span style="font-size:32px; font-weight:bold; color:#04af47; line-height:1.2;">WELCOME</span>
                      <span style="font-size:32px; color:#04af47; line-height:1.2; margin-left:8px;">Pro trader</span>
                    </td>
                  </tr>
                </table>

                <!-- Credentials Box -->
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffffff; border:2px solid #04af47; border-radius:12px; margin:16px 0; box-shadow:0 4px 8px rgba(0,0,0,0.1);">
                  <tr>
                    <td style="padding:24px; font-size:14px; line-height:1.6;">
                      <strong style="color:#111; font-size:15px;">Your Login Credentials</strong>
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
                        <tr>
                          <td style="padding:8px 0; color:#555; font-weight:600;">Trial Period:</td>
                          <td style="padding:8px 0; color:#111;">${trialDays} days</td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                </table>

                <!-- CTA -->
                <p style="margin:20px 0 0; text-align:center;">
                  <a href="${LOGIN_URL}" style="display:inline-block; background-color:#07c05c; color:#ffffff; text-decoration:none; padding:12px 32px; border-radius:6px; font-weight:bold; font-size:15px;" aria-label="Login to FxLabs Prime">
                    Login to FxLabs Prime
                  </a>
                </p>

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
        FxLabs Prime offers market insights for informational and educational use only.  
        This is not financial advice or an offer to trade. Forex, CFD, and crypto trading involve high risk.  
        Data may be delayed or inaccurate; FxLabs Prime is not liable for any losses.  
        By using this service, you agree to our 
        <a href="https://fxlabsprime.com/terms-of-service" target="_blank" rel="noopener noreferrer" style="color:#07c05c; text-decoration:none;">Terms of Service</a> 
        and 
        <a href="https://fxlabsprime.com/privacy-policy" target="_blank" rel="noopener noreferrer" style="color:#07c05c; text-decoration:none;">Privacy Policy</a>.  
        <br/><br/>
        Join us on Telegram community: 
        <a href="https://t.me/fxlabsprime" target="_blank" rel="noopener noreferrer" style="color:#07c05c; text-decoration:none;">@fxlabsprime</a>
      </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}
/**
 * Send email via SendGrid with 1 retry
 */ async function sendEmail(email, password, trialDays) {
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
        subject: "Welcome to FxLabs Prime"
      }
    ],
    from: {
      email: FROM_EMAIL,
      name: FROM_NAME
    },
    content: [
      {
        type: "text/html",
        value: createEmailTemplate(email, password, trialDays)
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
          "Authorization": `Bearer ${SENDGRID_API_KEY}`,
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
      // Retry only on first attempt
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
      // Retry only on first attempt
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
/**
 * Atomically create user and send email
 */ async function createUserAtomically(email, normalizedEmail, region, partnerId, subscriptionEndsAt, trialDays) {
  let authUserId = null;
  let tempPassword = null;
  try {
    // Check if email already exists
    const { data: existingMeta, error: metaCheckError } = await supabase.from("crm_user_metadata").select("email, user_id").eq("email", normalizedEmail).maybeSingle();
    if (metaCheckError) {
      console.error(`❌ Error checking existing user ${email}:`, metaCheckError.message);
      return {
        success: false,
        reason: `Database check failed: ${metaCheckError.message}`
      };
    }
    if (existingMeta) {
      console.log(`⚠️ Email already exists: ${email}`);
      return {
        success: false,
        reason: "User already exists"
      };
    }
    // Generate 8-digit alphanumeric password
    tempPassword = generatePassword();
    console.log(`🔑 Generated password for ${email}: ${tempPassword}`);
    // Create auth user with password
    console.log(`👤 Creating auth user: ${email}`);
    const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
      email,
      password: tempPassword,
      email_confirm: true
    });
    if (authError || !authUser?.user) {
      console.error(`❌ Auth create error for ${email}:`, authError?.message || "No user returned");
      return {
        success: false,
        reason: authError?.message || "User creation failed"
      };
    }
    authUserId = authUser.user.id;
    console.log(`✅ Auth user created with ID: ${authUserId}`);
    // Create metadata entry
    const { data: metaData, error: metaError } = await supabase.from("crm_user_metadata").insert({
      user_id: authUserId,
      email: normalizedEmail,
      region: region,
      crm_partner_id: partnerId,
      subscription_status: "trial",
      subscription_ends_at: subscriptionEndsAt,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).select("email");
    if (metaError) {
      console.error(`❌ Metadata insert error for ${email}:`, metaError.message);
      throw new Error(`Metadata creation failed: ${metaError.message}`);
    }
    if (!metaData || metaData.length === 0) {
      console.error(`❌ Metadata insert returned no data for ${email}`);
      throw new Error("Metadata creation returned no data");
    }
    console.log(`✅ Metadata created for ${email}`);
    // Send welcome email
    const emailResult = await sendEmail(email, tempPassword, trialDays);
    if (!emailResult.success) {
      console.warn(`⚠️ User created but email failed for ${email}: ${emailResult.error}`);
    }
    console.log(`✅ User creation complete for ${email}`);
    return {
      success: true,
      email: metaData[0].email,
      emailSent: emailResult.success,
      emailError: emailResult.error
    };
  } catch (error) {
    console.error(`❌ Error in atomic user creation for ${email}:`, error);
    // Cleanup auth user if created
    if (authUserId) {
      try {
        console.log(`🧹 Attempting to cleanup auth user ${authUserId} for ${email}`);
        const { error: deleteError } = await supabase.auth.admin.deleteUser(authUserId);
        if (deleteError) {
          console.error(`❌ CRITICAL: Failed to cleanup auth user ${authUserId}:`, deleteError.message);
          console.error(`⚠️ Manual intervention required: Delete auth user ${authUserId} for email ${email}`);
        } else {
          console.log(`✅ Successfully cleaned up auth user ${authUserId}`);
        }
      } catch (cleanupError) {
        console.error(`❌ CRITICAL: Exception during cleanup of auth user ${authUserId}:`, cleanupError);
        console.error(`⚠️ Manual intervention required: Delete auth user ${authUserId} for email ${email}`);
      }
    }
    return {
      success: false,
      reason: error instanceof Error ? error.message : "Unknown error"
    };
  }
}
serve(async (req)=>{
  if (req.method !== "POST") {
    return createErrorResponse("Method not allowed", 405);
  }
  try {
    // Validate Admin-Token or Partner-Token
    const adminToken = req.headers.get("Admin-Token");
    const partnerToken = req.headers.get("Partner-Token");
    if (!adminToken && !partnerToken) {
      return createErrorResponse("Admin-Token or Partner-Token header required", 401);
    }
    const token = adminToken || partnerToken;
    let secret;
    try {
      secret = getJWTSecret();
    } catch (error) {
      return createJWTSecretErrorResponse();
    }
    const { payload } = await jwtVerify(token, secret, {
      algorithms: [
        "HS256"
      ],
      issuer: Deno.env.get("CRM_JWT_ISSUER") ?? undefined,
      audience: Deno.env.get("CRM_JWT_AUDIENCE") ?? undefined
    });
    if (payload.role !== "admin" && payload.role !== "partner") {
      return createErrorResponse("Admin or Partner access required", 403);
    }
    const partnerId = payload.role === "partner" ? payload.sub : null;
    // Parse and validate request body
    let body;
    try {
      body = await req.json();
    } catch  {
      return createErrorResponse("Invalid JSON in request body", 400, "INVALID_JSON");
    }
    const validated = createUserSchema.parse(body);
    console.log(`\n📋 Processing ${validated.users.length} user(s)...`);
    const createdUsers = [];
    const existingUsers = [];
    const failedUsers = [];
    // Calculate subscription end date
    const subscriptionEndsAt = new Date(Date.now() + validated.trial_days * 24 * 60 * 60 * 1000).toISOString();
    // Process each user atomically
    for (const userInput of validated.users){
      const { email } = userInput;
      const normalizedEmail = email.trim().toLowerCase();
      console.log(`\n--- Processing ${email} ---`);
      const result = await createUserAtomically(email, normalizedEmail, validated.region, partnerId, subscriptionEndsAt, validated.trial_days);
      if (result.success) {
        createdUsers.push({
          email: result.email,
          email_sent: result.emailSent,
          email_error: result.emailError || null
        });
      } else if (result.reason === "User already exists") {
        existingUsers.push({
          email,
          reason: result.reason
        });
      } else {
        failedUsers.push({
          email,
          reason: result.reason
        });
      }
    }
    const emailsSentCount = createdUsers.filter((u)=>u.email_sent).length;
    console.log(`\n✅ Summary: ${createdUsers.length} created, ${emailsSentCount} emails sent, ${existingUsers.length} existing, ${failedUsers.length} failed\n`);
    const statusCode = createdUsers.length > 0 ? 201 : existingUsers.length > 0 ? 200 : 400;
    return new Response(JSON.stringify({
      message: `Processed ${validated.users.length} user(s)`,
      summary: {
        created: createdUsers.length,
        existing: existingUsers.length,
        failed: failedUsers.length,
        emails_sent: emailsSentCount
      },
      created_users: createdUsers,
      existing_users: existingUsers,
      failed_users: failedUsers,
      trial_days: validated.trial_days,
      region: validated.region
    }), {
      status: statusCode,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createValidationErrorResponse(error);
    }
    if (error?.name === "JWTExpired" || error?.name === "JWSSignatureVerificationFailed") {
      return createErrorResponse("Invalid or expired token", 401);
    }
    if (error?.code === "ERR_JWS_INVALID") {
      return createErrorResponse("Invalid JWT format", 400);
    }
    console.error("❌ Unexpected error:", error);
    return createErrorResponse("Internal server error", 500);
  }
});
