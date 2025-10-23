import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.22.4";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import { genSaltSync, hashSync } from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";
// Utility: Get JWT secret
function getJWTSecret() {
  const secret = Deno.env.get("CRM_CUSTOM_JWT_SECRET");
  if (!secret) {
    throw new Error("CUSTOM_JWT_SECRET environment variable is not set");
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
      field: issue.path?.join(".") || "",
      message: issue.message
    }));
  return createErrorResponse("Validation error", status, "VALIDATION_ERROR", details);
}
// Initialize Supabase client
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Supabase env vars not set");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
// Input validation schema
const createPartnerSchema = z.object({
  full_name: z.string().min(1, "Full name is required").max(255, "Full name too long"),
  email: z.string().email("Invalid email format").max(255, "Email too long"),
  password: z.string().min(8, "Password must be at least 8 characters").max(72, "Password too long (max 72 chars for bcrypt)"),
  commission_percent: z.number().int().min(0, "Commission must be ≥ 0").max(50, "Commission must be ≤ 50").optional().default(10)
});
/**
 * Atomically create a partner with proper validation and error handling
 */ async function createPartnerAtomically(fullName, email, passwordHash, commissionPercent) {
  const normalizedEmail = email.trim().toLowerCase();
  try {
    // Step 1: Check if partner already exists with proper error handling
    const { data: existing, error: checkError } = await supabase.from("crm_partner").select("id, email").eq("email", normalizedEmail).maybeSingle();
    if (checkError) {
      console.error(`Error checking existing partner for ${email}:`, checkError.message);
      return {
        success: false,
        reason: `Database check failed: ${checkError.message}`
      };
    }
    if (existing) {
      console.log(`Partner already exists with email: ${email}`);
      return {
        success: false,
        reason: "Partner with this email already exists"
      };
    }
    // Step 2: Insert partner
    console.log(`Creating partner: ${email}`);
    const { data: inserted, error: insertError } = await supabase.from("crm_partner").insert({
      email: normalizedEmail,
      full_name: fullName.trim(),
      password_hash: passwordHash,
      commission_percent: commissionPercent,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).select("email, full_name");
    if (insertError) {
      console.error(`Partner insert error for ${email}:`, insertError.message, insertError.code);
      // Handle specific database errors
      if (insertError.code === "23505") {
        return {
          success: false,
          reason: "Partner with this email already exists"
        };
      }
      if (insertError.code === "23502") {
        return {
          success: false,
          reason: "Required field is missing"
        };
      }
      return {
        success: false,
        reason: `Database error: ${insertError.message}`
      };
    }
    // Step 3: Verify data was inserted
    if (!inserted || inserted.length === 0) {
      console.error(`Partner insert returned no data for ${email}`);
      return {
        success: false,
        reason: "Partner creation returned no data"
      };
    }
    console.log(`Successfully created partner: ${email}`);
    return {
      success: true,
      partner: inserted[0]
    };
  } catch (error) {
    console.error(`Unexpected error creating partner ${email}:`, error);
    return {
      success: false,
      reason: error instanceof Error ? error.message : "Unknown error during partner creation"
    };
  }
}
/**
 * Securely hash password with proper error handling
 */ function hashPassword(password) {
  try {
    const cost = Number.parseInt(Deno.env.get("BCRYPT_COST") ?? "12", 10);
    const finalCost = cost >= 10 && cost <= 15 ? cost : 12;
    const salt = genSaltSync(finalCost);
    const hash = hashSync(password, salt);
    if (!hash || hash.length < 20) {
      return {
        hash: null,
        error: "Password hashing produced invalid result"
      };
    }
    return {
      hash,
      error: null
    };
  } catch (error) {
    console.error("Password hashing error:", error);
    return {
      hash: null,
      error: error instanceof Error ? error.message : "Password hashing failed"
    };
  }
}
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
    // === 3. Hash password ===
    const { hash: passwordHash, error: hashError } = hashPassword(validated.password);
    if (hashError || !passwordHash) {
      console.error("Password hashing failed:", hashError);
      return createErrorResponse("Failed to process password", 500, "PASSWORD_HASH_ERROR");
    }
    // === 4. Create partner atomically ===
    const result = await createPartnerAtomically(validated.full_name, validated.email, passwordHash, validated.commission_percent);
    if (!result.success) {
      if (result.reason === "Partner with this email already exists") {
        return createErrorResponse(result.reason, 409, "DUPLICATE_EMAIL");
      }
      console.error("Partner creation failed:", result.reason);
      return createErrorResponse(result.reason || "Failed to create partner", 500, "PARTNER_CREATION_FAILED");
    }
    // === 5. Success ===
    return new Response(JSON.stringify({
      message: `Partner ${result.partner.full_name} with Email - ${result.partner.email} has been created successfully`,
      partner: {
        email: result.partner.email,
        full_name: result.partner.full_name
      }
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
      return createErrorResponse("Invalid or expired Admin-Token", 401, "INVALID_TOKEN");
    }
    if (error?.code === "ERR_JWS_INVALID") {
      return createErrorResponse("Invalid JWT format", 400, "INVALID_JWT_FORMAT");
    }
    console.error("Unexpected error:", error);
    return createErrorResponse("Internal server error", 500, "INTERNAL_ERROR");
  }
});
