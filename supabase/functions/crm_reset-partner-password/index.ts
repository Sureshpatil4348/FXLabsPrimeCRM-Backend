import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import { z } from "https://esm.sh/zod@3.22.4";
import { hashSync } from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";
// SendGrid & App Config
const SENDGRID_API_KEY = Deno.env.get("CRM_SENDGRID_API_KEY");
const FROM_EMAIL = Deno.env.get("CRM_FROM_EMAIL") || "noreply@fxlabsprime.com";
const FROM_NAME = Deno.env.get("CRM_FROM_NAME") || "FxLabs Prime Partner Team";
const LOGIN_URL = "https://fxlabsprime-crm.netlify.app/login/partner";
// JWT Secret
function getJWTSecret() {
  const secret = Deno.env.get("CRM_CUSTOM_JWT_SECRET");
  if (!secret) throw new Error("CRM_CUSTOM_JWT_SECRET not set");
  return new TextEncoder().encode(secret);
}
function createJWTSecretErrorResponse() {
  return new Response(JSON.stringify({
    error: "JWT secret error",
    code: "JWT_SECRET_ERROR"
  }), {
    status: 500,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
function createErrorResponse(message, status = 500, code = null, details = []) {
  const res = {
    error: message
  };
  if (code) res.code = code;
  if (details.length > 0) res.details = details;
  return new Response(JSON.stringify(res), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
function createValidationErrorResponse(zodError) {
  const details = zodError.issues.map((i)=>({
      field: i.path.join("."),
      message: i.message
    }));
  return createErrorResponse("Validation error", 400, "VALIDATION_ERROR", details);
}
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
// === Validation ===
const resetPartnerPasswordSchema = z.object({
  email: z.string().email("Invalid email format")
});
/**
 * Generate 8-character alphanumeric password (FxLabs Prime standard)
 */ function generatePassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let password = "";
  const array = new Uint8Array(8);
  crypto.getRandomValues(array);
  for(let i = 0; i < 8; i++){
    password += chars[array[i] % chars.length];
  }
  return password;
}
/**
 * Partner password reset email template
 */ function createPartnerPasswordResetEmailTemplate(email, password, fullName) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Partner Password Reset - FxLabs Prime</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    .preheader { display:none !important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; }
    @media only screen and (max-width: 600px) { .container { width: 100% !important; } }
  </style>
</head>
<body style="margin:0; padding:0; background:#f4f4f4; font-family: Arial, sans-serif; color:#222;">
  <div class="preheader">Your FxLabs Prime Partner password has been reset.</div>

  <!-- Header -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#07c05c; padding:16px 20px;">
    <tr>
      <td align="center" style="color:#fff; font-size:18px; font-weight:600;">
        FxLabs Prime - Partner Portal
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
              <h2 style="margin:0 0 12px; color:#111; font-size:20px;">Hello, ${fullName}!</h2>
              <p style="margin:0 0 16px; color:#444;">
                Your <strong>FxLabs Prime Partner Portal</strong> password has been reset by an administrator.
              </p>

              <!-- Credentials -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fc; border:1px solid #e1e5eb; border-radius:8px; margin:16px 0;">
                <tr>
                  <td style="padding:20px;">
                    <strong style="color:#111; font-size:15px;">Your New Login Credentials</strong>
                    <table role="presentation" width="100%" style="margin-top:12px;">
                      <tr>
                        <td style="padding:6px 0; color:#555; font-weight:600;">Email:</td>
                        <td style="padding:6px 0; color:#111;">${email}</td>
                      </tr>
                      <tr>
                        <td style="padding:6px 0; color:#555; font-weight:600;">Password:</td>
                        <td style="padding:6px 0;">
                          <span style="font-family: 'Courier New', monospace; background:#fff; padding:6px 12px; border-radius:4px; font-size:16px; font-weight:bold; color:#07c05c; letter-spacing:2px; border:1px solid #ddd;">
                            ${password}
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA -->
              <p style="text-align:center; margin:20px 0 0;">
                <a href="${LOGIN_URL}" style="background:#07c05c; color:#fff; padding:12px 32px; border-radius:6px; text-decoration:none; font-weight:bold; font-size:15px; display:inline-block;">
                  Login to Partner Portal
                </a>
              </p>

              <!-- Security Notice -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff4e6; border:1px solid #ffcc80; border-radius:8px; margin:20px 0 0;">
                <tr>
                  <td style="padding:14px 16px; font-size:14px; color:#e65100;">
                    <strong>Security Required:</strong> Change this password <strong>immediately</strong> after your first login.
                  </td>
                </tr>
              </table>

              <!-- Unauthorized -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ffebee; border:1px solid #ffcdd2; border-radius:8px; margin:16px 0 0;">
                <tr>
                  <td style="padding:14px 16px; font-size:14px; color:#c62828;">
                    <strong>Did NOT request this?</strong> Contact support immediately via 
                    <a href="https://t.me/Fxlabs_prime" style="color:#c62828; font-weight:600; text-decoration:none;">@Fxlabs_prime</a>
                  </td>
                </tr>
              </table>

              <!-- Support -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9fc; border:1px solid #e1e5eb; border-radius:8px; margin:16px 0 0;">
                <tr>
                  <td style="padding:12px 16px; font-size:14px; color:#555;">
                    <strong>Partner Support:</strong> Telegram: 
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
        FxLabs Prime Partner Portal • Referral & Revenue Management<br/>
        <a href="https://fxlabsprime.com/terms-of-service" style="color:#07c05c; text-decoration:none;">Terms</a> • 
        <a href="https://fxlabsprime.com/privacy-policy" style="color:#07c05c; text-decoration:none;">Privacy</a>
        <br/><br/>
        Support: <a href="https://t.me/Fxlabs_prime" style="color:#07c05c; text-decoration:none;">@Fxlabs_prime</a>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();
}
/**
 * Send email with retry
 */ async function sendPartnerPasswordResetEmail(email, password, fullName) {
  if (!SENDGRID_API_KEY) {
    console.error("SendGrid not configured");
    return {
      success: false,
      error: "Email service not configured"
    };
  }
  const payload = {
    personalizations: [
      {
        to: [
          {
            email
          }
        ],
        subject: "Partner Password Reset - FxLabs Prime"
      }
    ],
    from: {
      email: FROM_EMAIL,
      name: FROM_NAME
    },
    content: [
      {
        type: "text/html",
        value: createPartnerPasswordResetEmailTemplate(email, password, fullName)
      }
    ]
  };
  for(let i = 1; i <= 2; i++){
    try {
      console.log(`Sending partner reset email to ${email} (attempt ${i}/2)`);
      const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SENDGRID_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        console.log(`Partner reset email sent to ${email}`);
        return {
          success: true
        };
      }
      const err = await res.text();
      console.error(`SendGrid error (${res.status}): ${err}`);
      if (i === 1) {
        await new Promise((r)=>setTimeout(r, 1000));
        continue;
      }
      return {
        success: false,
        error: `SendGrid error: ${res.status}`
      };
    } catch (e) {
      console.error("Email exception:", e);
      if (i === 1) {
        await new Promise((r)=>setTimeout(r, 1000));
        continue;
      }
      return {
        success: false,
        error: e instanceof Error ? e.message : "Network error"
      };
    }
  }
  return {
    success: false,
    error: "Failed after retry"
  };
}
// === MAIN HANDLER ===
serve(async (req)=>{
  if (req.method !== "POST") {
    return createErrorResponse("Method not allowed", 405);
  }
  try {
    // === Admin Token Check ===
    const adminToken = req.headers.get("Admin-Token");
    if (!adminToken) {
      return createErrorResponse("Admin-Token required", 401, "MISSING_TOKEN");
    }
    let secret;
    try {
      secret = getJWTSecret();
    } catch  {
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
      return createErrorResponse("Admin access required", 403, "FORBIDDEN");
    }
    // === Parse & Validate Body ===
    let body;
    try {
      body = await req.json();
    } catch  {
      return createErrorResponse("Invalid JSON", 400, "INVALID_JSON");
    }
    const validated = resetPartnerPasswordSchema.parse(body);
    const email = validated.email.trim().toLowerCase();
    console.log(`Partner password reset requested for: ${email}`);
    // === Find Partner in crm_partner ===
    const { data: partner, error: dbError } = await supabase.from("crm_partner").select("id, email, full_name, is_active").eq("email", email).maybeSingle();
    if (dbError) {
      console.error("Database error:", dbError.message);
      return createErrorResponse(`Database error: ${dbError.message}`, 500, "DB_ERROR");
    }
    if (!partner) {
      console.log(`Partner not found: ${email}`);
      return createErrorResponse("Partner not found", 404, "PARTNER_NOT_FOUND");
    }
    if (!partner.is_active) {
      return createErrorResponse("Cannot reset password for inactive partner", 403, "PARTNER_INACTIVE");
    }
    // === Generate New Password & Hash ===
    const newPassword = generatePassword();
    const newPasswordHash = hashSync(newPassword);
    // === Update Password Hash in Database ===
    const { error: updateError } = await supabase.from("crm_partner").update({
      password_hash: newPasswordHash,
      updated_at: new Date().toISOString()
    }).eq("id", partner.id);
    if (updateError) {
      console.error("Password update failed:", updateError.message);
      return createErrorResponse(`Failed to update password: ${updateError.message}`, 500, "UPDATE_ERROR");
    }
    console.log(`Password hash updated for partner: ${email}`);
    // === Send Email ===
    const emailResult = await sendPartnerPasswordResetEmail(email, newPassword, partner.full_name || "Partner");
    if (!emailResult.success) {
      console.warn(`Email failed for partner ${email}: ${emailResult.error}`);
      return new Response(JSON.stringify({
        message: "Password reset successfully but email failed",
        email,
        partner_id: partner.id,
        full_name: partner.full_name,
        email_sent: false,
        email_error: emailResult.error,
        warning: "Partner password updated in DB but email failed. Notify manually."
      }), {
        status: 207,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // === Success ===
    return new Response(JSON.stringify({
      message: "Partner password reset and email sent",
      full_name: partner.full_name,
      email_sent: true
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createValidationErrorResponse(error);
    }
    if (error?.name === "JWTExpired" || error?.name === "JWSSignatureVerificationFailed") {
      return createErrorResponse("Invalid or expired token", 401, "TOKEN_ERROR");
    }
    if (error?.code === "ERR_JWS_INVALID") {
      return createErrorResponse("Invalid JWT format", 400, "INVALID_JWT");
    }
    console.error("Unexpected error:", error);
    return createErrorResponse("Internal server error", 500, "INTERNAL_ERROR");
  }
});
