import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.22.4";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import { genSaltSync, hashSync, compareSync } from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";
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
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
// Input validation schema
const createAdminSchema = z.object({
  full_name: z.string().min(1, "Full name is required").max(255, "Full name too long"),
  email: z.string().email("Invalid email format").max(255, "Email too long"),
  password: z.string().min(8, "Password must be at least 8 characters").max(72, "Password too long (max 72 chars for bcrypt)"),
  current_admin_password: z.string().min(1, "Current admin password is required")
});
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
/**
 * Verify current admin's password
 */ async function verifyCurrentAdminPassword(adminId, providedPassword) {
  try {
    const { data: currentAdmin, error: fetchError } = await supabase.from("crm_admin").select("id, password_hash").eq("id", adminId).maybeSingle();
    if (fetchError) {
      console.error("Database error fetching current admin:", fetchError.message);
      return {
        valid: false,
        reason: `Database error: ${fetchError.message}`
      };
    }
    if (!currentAdmin) {
      console.error(`Current admin not found: ${adminId}`);
      return {
        valid: false,
        reason: "Current admin not found"
      };
    }
    if (!currentAdmin.password_hash) {
      console.error(`Admin ${adminId} has no password hash`);
      return {
        valid: false,
        reason: "Admin password not configured"
      };
    }
    // Verify password
    try {
      const isPasswordValid = compareSync(providedPassword, currentAdmin.password_hash);
      if (!isPasswordValid) {
        console.log(`Invalid password attempt for admin ${adminId}`);
        return {
          valid: false,
          reason: "Current admin password is incorrect"
        };
      }
      return {
        valid: true
      };
    } catch (compareError) {
      console.error("Password comparison error:", compareError);
      return {
        valid: false,
        reason: "Password verification failed"
      };
    }
  } catch (error) {
    console.error("Unexpected error in password verification:", error);
    return {
      valid: false,
      reason: error instanceof Error ? error.message : "Password verification failed"
    };
  }
}
/**
 * Atomically create an admin with proper validation and error handling
 */ async function createAdminAtomically(fullName, email, passwordHash) {
  const normalizedEmail = email.trim().toLowerCase();
  try {
    // Step 1: Check if admin already exists with proper error handling
    const { data: existing, error: checkError } = await supabase.from("crm_admin").select("id, email").eq("email", normalizedEmail).maybeSingle();
    if (checkError) {
      console.error(`Error checking existing admin for ${email}:`, checkError.message);
      return {
        success: false,
        reason: `Database check failed: ${checkError.message}`
      };
    }
    if (existing) {
      console.log(`Admin already exists with email: ${email}`);
      return {
        success: false,
        reason: "Admin with this email already exists"
      };
    }
    // Step 2: Insert admin
    console.log(`Creating admin: ${email}`);
    const { data: inserted, error: insertError } = await supabase.from("crm_admin").insert({
      email: normalizedEmail,
      full_name: fullName.trim(),
      password_hash: passwordHash,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }).select("email, full_name");
    if (insertError) {
      console.error(`Admin insert error for ${email}:`, insertError.message, insertError.code);
      // Handle specific database errors
      if (insertError.code === "23505") {
        return {
          success: false,
          reason: "Admin with this email already exists"
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
      console.error(`Admin insert returned no data for ${email}`);
      return {
        success: false,
        reason: "Admin creation returned no data"
      };
    }
    console.log(`Successfully created admin: ${email}`);
    return {
      success: true,
      admin: inserted[0]
    };
  } catch (error) {
    console.error(`Unexpected error creating admin ${email}:`, error);
    return {
      success: false,
      reason: error instanceof Error ? error.message : "Unknown error during admin creation"
    };
  }
}
serve(async (req)=>{
  if (req.method !== "POST") {
    return createErrorResponse("Method not allowed", 405);
  }
  try {
    // === 1. Validate Admin-Token ===
    const adminToken = req.headers.get("Admin-Token");
    if (!adminToken) {
      return createErrorResponse("Admin-Token header required", 401, "MISSING_TOKEN");
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
      return createErrorResponse("Admin access required", 403, "INSUFFICIENT_PERMISSIONS");
    }
    // Get current admin's ID from JWT payload
    const currentAdminId = payload.sub;
    if (!currentAdminId) {
      return createErrorResponse("Invalid admin token: user ID not found", 401, "INVALID_TOKEN_PAYLOAD");
    }
    // === 2. Parse and validate request body ===
    let body;
    try {
      body = await req.json();
    } catch  {
      return createErrorResponse("Invalid JSON in request body", 400, "INVALID_JSON");
    }
    const validated = createAdminSchema.parse(body);
    // === 3. Verify current admin's password ===
    const passwordCheck = await verifyCurrentAdminPassword(currentAdminId, validated.current_admin_password);
    if (!passwordCheck.valid) {
      const statusCode = passwordCheck.reason === "Current admin password is incorrect" ? 403 : 500;
      const errorCode = passwordCheck.reason === "Current admin password is incorrect" ? "INCORRECT_PASSWORD" : "PASSWORD_VERIFICATION_ERROR";
      return createErrorResponse(passwordCheck.reason || "Password verification failed", statusCode, errorCode);
    }
    // === 4. Hash new admin's password ===
    const { hash: passwordHash, error: hashError } = hashPassword(validated.password);
    if (hashError || !passwordHash) {
      console.error("Password hashing failed:", hashError);
      return createErrorResponse("Failed to process password", 500, "PASSWORD_HASH_ERROR");
    }
    // === 5. Create admin atomically ===
    const result = await createAdminAtomically(validated.full_name, validated.email, passwordHash);
    if (!result.success) {
      if (result.reason === "Admin with this email already exists") {
        return createErrorResponse(result.reason, 409, "DUPLICATE_EMAIL");
      }
      console.error("Admin creation failed:", result.reason);
      return createErrorResponse(result.reason || "Failed to create admin", 500, "ADMIN_CREATION_FAILED");
    }
    // === 6. Success ===
    return new Response(JSON.stringify({
      message: `Admin ${result.admin.full_name} with Email - ${result.admin.email} has been created successfully`,
      admin: {
        email: result.admin.email,
        full_name: result.admin.full_name
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
