import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.22.4";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import { genSaltSync, hashSync } from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";
// ========== SENDGRID CONFIGURATION ==========
const SENDGRID_API_KEY = Deno.env.get("CRM_SENDGRID_API_KEY");
const FROM_EMAIL = Deno.env.get("CRM_FROM_EMAIL");
const FROM_NAME = Deno.env.get("CRM_FROM_NAME");
const LOGIN_URL = "https://crm.fxlabsprime.com/login/partner";
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
  if (code) errorResponse.code = code;
  if (details.length > 0) errorResponse.details = details;
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
// Email Template
function createEmailTemplate(email, password, fullName, slabs) {
  // Format slabs into human-readable rows
  const formatRange = (from, to)=>{
    if (to === null) return `${from.toLocaleString()}+`;
    return `${from.toLocaleString()} – ${to.toLocaleString()}`;
  };
  const slabRows = slabs.map((slab)=>`
        <tr>
          <td style="padding:10px 12px; border-bottom:1px solid #e6e7ec; text-align:left; color:#111;">
            ${formatRange(slab.from, slab.to)}
          </td>
          <td style="padding:10px 12px; border-bottom:1px solid #e6e7ec; text-align:right; color:#07c05c; font-weight:600;">
            ${slab.commission}%
          </td>
        </tr>
      `).join("");
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
    <div class="preheader">Welcome to the FxLabs Prime Partner Program!</div>

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

                <!-- Commission Slabs Table -->
                <p style="margin:20px 0 8px; font-size:15px; color:#111; font-weight:600;">
                  Your Commission Structure
                </p>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fff; border:1px solid #e6e7ec; border-radius:8px; margin-bottom:20px; overflow:hidden;">
                  <thead>
                    <tr style="background:#f6f7fb;">
                      <th style="padding:12px; text-align:left; font-weight:600; color:#111; font-size:14px;">Revenue Range</th>
                      <th style="padding:12px; text-align:right; font-weight:600; color:#111; font-size:14px;">Commission</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${slabRows}
                  </tbody>
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
                      <strong>Warning: Important:</strong> Please change your password after your first login for security.
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
// Send email via SendGrid with retry
async function sendEmail(email, password, fullName, slabs) {
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
        value: createEmailTemplate(email, password, fullName, slabs)
      }
    ]
  };
  for(let attempt = 1; attempt <= 2; attempt++){
    try {
      console.log(`Sending email to ${email} (attempt ${attempt}/2)`);
      const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SENDGRID_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(emailData)
      });
      if (response.ok) {
        console.log(`Email sent successfully to ${email}`);
        return {
          success: true
        };
      }
      const errorText = await response.text();
      console.error(`SendGrid error: ${response.status} - ${errorText}`);
      if (attempt === 1) await new Promise((r)=>setTimeout(r, 1000));
    } catch (error) {
      console.error(`Exception sending email:`, error);
      if (attempt === 1) await new Promise((r)=>setTimeout(r, 1000));
    }
  }
  return {
    success: false,
    error: "Failed after retry"
  };
}
// === Supabase Client ===
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase env vars not set");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
// === Zod Validation Schemas ===
const CommissionSlabSchema = z.object({
  from: z.number().int().min(0, "from must be >= 0"),
  to: z.number().int().min(0).nullable(),
  commission: z.number().min(0, "commission must be >= 0").max(100, "commission cannot exceed 100%")
}).superRefine((slab, ctx)=>{
  if (slab.to !== null && slab.to <= slab.from) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [
        "to"
      ],
      message: "to must be greater than from when not null"
    });
  }
});
const CommissionSlabsSchema = z.object({
  slabs: z.array(CommissionSlabSchema).min(1, "At least one commission slab is required").refine((slabs)=>slabs[0].from === 0, {
    message: "First slab must start at from: 0"
  }).refine((slabs)=>{
    for(let i = 0; i < slabs.length - 1; i++){
      const curr = slabs[i];
      const next = slabs[i + 1];
      if (curr.to === null) return false;
      if (curr.to + 1 !== next.from) return false;
    }
    return true;
  }, {
    message: "Slabs must be contiguous (no gaps)"
  }).refine((slabs)=>slabs[slabs.length - 1].to === null, {
    message: "Last slab must have to: null"
  }).refine((slabs)=>{
    const seen = new Set();
    for (const slab of slabs){
      if (slab.to === null) continue;
      for(let i = slab.from; i <= slab.to; i++){
        if (seen.has(i)) return false;
        seen.add(i);
      }
    }
    return true;
  }, {
    message: "Slabs must not overlap"
  })
}).transform((data)=>data);
const createPartnerSchema = z.object({
  full_name: z.string().min(1, "Full name is required"),
  email: z.string().email("Invalid email format").regex(/^[^@]+@[^@]+\.[^@]+$/, "Invalid email format"),
  commission_slabs: CommissionSlabsSchema.optional().default({
    slabs: [
      {
        from: 0,
        to: null,
        commission: 2
      }
    ]
  })
});
// === Main Handler ===
serve(async (req)=>{
  if (req.method !== "POST") {
    return createErrorResponse("Method not allowed", 405, "METHOD_NOT_ALLOWED");
  }
  try {
    // === 1. Admin Auth ===
    const adminToken = req.headers.get("Admin-Token") ?? req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!adminToken) {
      return createErrorResponse("Admin-Token header required", 401, "UNAUTHORIZED");
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
    // === 2. Parse & Validate Body ===
    let body;
    try {
      body = await req.json();
    } catch  {
      return createErrorResponse("Invalid JSON in request body", 400, "INVALID_JSON");
    }
    const parsed = createPartnerSchema.safeParse(body);
    if (!parsed.success) {
      return createValidationErrorResponse(parsed.error);
    }
    const { full_name, email: rawEmail, commission_slabs } = parsed.data;
    // === 3. Normalize & Check Duplicate ===
    const email = rawEmail.trim().toLowerCase();
    const { data: existing } = await supabase.from("crm_partner").select("id").eq("email", email).maybeSingle();
    if (existing) {
      return createErrorResponse("Partner with this email already exists", 409, "DUPLICATE_EMAIL");
    }
    // === 4. Generate & Hash Password ===
    const generatedPassword = generatePassword();
    console.log(`Generated password for ${email}: ${generatedPassword}`);
    const cost = Number.parseInt(Deno.env.get("BCRYPT_COST") ?? "12", 10) || 12;
    const salt = genSaltSync(cost);
    const passwordHash = hashSync(generatedPassword, salt);
    // === 5. Insert Partner ===
    const { data: inserted, error: insertError } = await supabase.from("crm_partner").insert({
      email,
      full_name,
      password_hash: passwordHash,
      commission_slabs: commission_slabs,
      is_active: true
    }).select("email, full_name").single();
    if (insertError) {
      console.error("Insert error:", insertError);
      if (insertError.code === "23505") {
        return createErrorResponse("Partner with this email already exists", 409, "DUPLICATE_EMAIL");
      }
      return createErrorResponse("Failed to create partner", 500, "DB_INSERT_FAILED");
    }
    // === 6. Send Welcome Email ===
    const emailResult = await sendEmail(email, generatedPassword, full_name, commission_slabs.slabs);
    if (!emailResult.success) {
      console.warn(`Partner created but email failed: ${emailResult.error}`);
    }
    // === 7. Success Response ===
    return new Response(JSON.stringify({
      message: `Partner ${inserted.full_name} created successfully`,
      email_sent: emailResult.success,
      email_error: emailResult.error || null
    }), {
      status: 201,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    console.error("Unexpected error:", error);
    if (error instanceof z.ZodError) {
      return createValidationErrorResponse(error);
    }
    if (error?.name === "JWTExpired" || error?.name === "JWSSignatureVerificationFailed") {
      return createErrorResponse("Invalid or expired Admin-Token", 401, "INVALID_TOKEN");
    }
    return createErrorResponse("Internal server error", 500, "INTERNAL_ERROR");
  }
});
