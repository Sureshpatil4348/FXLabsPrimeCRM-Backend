import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import { z } from "https://esm.sh/zod@3.22.4";
// ========== SENDGRID CONFIGURATION ==========
const SENDGRID_API_KEY = Deno.env.get("CRM_SENDGRID_API_KEY");
const FROM_EMAIL = Deno.env.get("CRM_FROM_EMAIL") || "noreply@yourdomain.com";
const FROM_NAME = Deno.env.get("CRM_FROM_NAME") || "Your CRM Team";
const LOGIN_URL = "https://crm.fxlabsprime.com/login/admin";
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
  if (details.length > 0) errorResponse.details = details;
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
/**
 * Email template for email change
 */ function createEmailChangeTemplate(oldEmail, newEmail, fullName) {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>Admin Email Updated</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    .preheader { display:none !important; visibility:hidden; opacity:0; color:transparent; height:0; width:0; overflow:hidden; mso-hide:all; }
    @media only screen and (max-width: 600px) { .container { width: 100% !important; } }
  </style>
</head>
<body style="margin:0; padding:0; background-color:#f6f7fb; font-family: Arial, Helvetica, sans-serif; color:#222;">
  <div class="preheader">Your admin email has been updated.</div>

  <!-- Header -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#07c05c; padding:16px 20px;">
    <tr><td align="center" style="color:#fff; font-size:18px; font-weight:600;">FxLabs Prime Admin Portal</td></tr>
  </table>

  <!-- Main Body -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:30px;">
    <tr>
      <td align="center">
        <table role="presentation" class="container" width="600" cellpadding="0" cellspacing="0" style="max-width:600px; width:90%; background-color:#ffffff; border-radius:12px; padding:30px;">
          <tr>
            <td>
              <h2 style="margin:0 0 12px; color:#111;">Hello, ${fullName}!</h2>
              <p style="margin:0 0 16px;">Your admin account email has been successfully updated.</p>

              <!-- Change Summary -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f7fb; border:1px solid #e6e7ec; border-radius:8px; margin:16px 0;">
                <tr>
                  <td style="padding:20px; font-size:14px; line-height:1.6;">
                    <strong style="color:#111; font-size:15px;">Email Change Summary</strong>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">
                      <tr>
                        <td style="padding:8px 0; color:#555; font-weight:600;">Old Email:</td>
                        <td style="padding:8px 0; color:#111;">${oldEmail}</td>
                      </tr>
                      <tr>
                        <td style="padding:8px 0; color:#555; font-weight:600;">New Email:</td>
                        <td style="padding:8px 0; color:#07c05c; font-weight:bold;">${newEmail}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- CTA -->
              <p style="margin:20px 0 0; text-align:center;">
                <a href="${LOGIN_URL}" style="display:inline-block; background-color:#07c05c; color:#ffffff; text-decoration:none; padding:12px 32px; border-radius:6px; font-weight:bold; font-size:15px;">
                  Login with New Email
                </a>
              </p>

              <!-- Security Notice -->
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff7e6; border:1px solid #ffd59e; border-radius:8px; margin:20px 0 0;">
                <tr>
                  <td style="padding:14px 16px; font-size:14px; line-height:1.6; color:#663c00;">
                    <strong>Security Tip:</strong> If you didn’t request this change, contact support immediately.
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
        FxLabs Prime provides automated market insights and notifications for informational and educational purposes only...<br/>
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
 */ async function sendEmailChangeNotification(oldEmail, newEmail, fullName) {
  if (!SENDGRID_API_KEY) {
    console.error("SendGrid API key not configured");
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
            email: newEmail
          }
        ],
        subject: "Your Admin Email Has Been Updated"
      }
    ],
    from: {
      email: FROM_EMAIL,
      name: FROM_NAME
    },
    content: [
      {
        type: "text/html",
        value: createEmailChangeTemplate(oldEmail, newEmail, fullName)
      }
    ]
  };
  for(let attempt = 1; attempt <= 2; attempt++){
    try {
      console.log(`Sending email change notification to ${newEmail} (attempt ${attempt}/2)`);
      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${SENDGRID_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(emailData)
      });
      if (response.ok) {
        console.log(`Email sent to ${newEmail}`);
        return {
          success: true
        };
      }
      const errorText = await response.text();
      console.error(`SendGrid error (${response.status}): ${errorText}`);
      if (attempt === 1) {
        await new Promise((r)=>setTimeout(r, 1000));
        continue;
      }
      return {
        success: false,
        error: `SendGrid error: ${response.status}`
      };
    } catch (error) {
      console.error(`Exception sending email:`, error);
      if (attempt === 1) {
        await new Promise((r)=>setTimeout(r, 1000));
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
// Initialize Supabase
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
// Validation schema - ONLY email & full_name allowed
const updateAdminSchema = z.object({
  existing_email: z.string().email("Invalid existing email format"),
  email: z.string().email("Invalid new email format").optional(),
  full_name: z.string().min(1, "Full name cannot be empty").optional()
}).refine((data)=>data.email || data.full_name, {
  message: "At least one field (email or full_name) must be provided",
  path: [
    "email",
    "full_name"
  ]
});
serve(async (req)=>{
  if (req.method !== "PATCH" && req.method !== "PUT") {
    return createErrorResponse("Method not allowed", 405);
  }
  try {
    // === Validate Admin-Token ===
    const adminToken = req.headers.get("Admin-Token");
    if (!adminToken) {
      return createErrorResponse("Admin-Token header required", 401);
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
      return createErrorResponse("Admin access required", 403);
    }
    // === Parse & validate body ===
    let body;
    try {
      body = await req.json();
    } catch  {
      return createErrorResponse("Invalid JSON in request body", 400, "INVALID_JSON");
    }
    const validated = updateAdminSchema.parse(body);
    const normalizedExistingEmail = validated.existing_email.trim().toLowerCase();
    // === Fetch admin by email ===
    const { data: existingAdmin, error: fetchError } = await supabase.from("crm_admin").select("id, email, full_name").eq("email", normalizedExistingEmail).single();
    if (fetchError || !existingAdmin) {
      console.error("Admin not found or DB error:", fetchError);
      return createErrorResponse("Admin not found with provided email", 404, "ADMIN_NOT_FOUND");
    }
    console.log(`Updating admin: ${existingAdmin.email} (ID: ${existingAdmin.id})`);
    // === Prepare update ===
    const updateData = {
      updated_at: new Date().toISOString()
    };
    let emailChanged = false;
    let oldEmail = existingAdmin.email;
    let newEmail = oldEmail;
    // --- Email Update ---
    if (validated.email) {
      const normalizedNewEmail = validated.email.trim().toLowerCase();
      if (normalizedNewEmail !== existingAdmin.email.toLowerCase()) {
        const { data: emailExists } = await supabase.from("crm_admin").select("id").eq("email", normalizedNewEmail).neq("id", existingAdmin.id).maybeSingle();
        if (emailExists) {
          return createErrorResponse("New email already in use by another admin", 409, "EMAIL_EXISTS");
        }
        updateData.email = normalizedNewEmail;
        emailChanged = true;
        newEmail = normalizedNewEmail;
        console.log(`Email will change: ${oldEmail} → ${newEmail}`);
      }
    }
    // --- Full Name Update ---
    if (validated.full_name && validated.full_name !== existingAdmin.full_name) {
      updateData.full_name = validated.full_name;
      console.log(`Full name updated: ${existingAdmin.full_name} → ${validated.full_name}`);
    }
    // === No changes? ===
    if (Object.keys(updateData).length === 1) {
      return new Response(JSON.stringify({
        message: "No changes detected",
        admin_id: existingAdmin.id
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // === Perform Update ===
    const { data: updatedAdmin, error: updateError } = await supabase.from("crm_admin").update(updateData).eq("id", existingAdmin.id).select("id, email, full_name, updated_at").single();
    if (updateError) {
      console.error("Update error:", updateError);
      return createErrorResponse("Failed to update admin", 500, "UPDATE_ERROR");
    }
    // === Send Email if Email Changed ===
    let emailResult = {
      success: true,
      error: null
    };
    if (emailChanged) {
      emailResult = await sendEmailChangeNotification(oldEmail, newEmail, updatedAdmin.full_name);
      if (!emailResult.success) {
        console.warn(`Email failed: ${emailResult.error}`);
      }
    }
    return new Response(JSON.stringify({
      message: "Admin updated successfully",
      admin: updatedAdmin,
      changes: {
        email_changed: emailChanged,
        full_name_changed: !!updateData.full_name
      },
      email_sent: emailChanged ? emailResult.success : null,
      email_error: emailChanged ? emailResult.error : null
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
      return createErrorResponse("Invalid or expired token", 401);
    }
    console.error("Unexpected error:", error);
    return createErrorResponse("Internal server error", 500);
  }
});
