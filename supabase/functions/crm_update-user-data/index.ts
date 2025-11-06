import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import { z } from "https://esm.sh/zod@3.22.4";
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
// Validation schema
const updateUserSchema = z.object({
  user_id: z.string().uuid("Invalid user ID format"),
  email: z.string().email("Invalid email format").optional(),
  region: z.enum([
    "India",
    "International"
  ], {
    errorMap: ()=>({
        message: "Region must be 'India' or 'International'"
      })
  }).optional(),
  subscription_ends_at: z.string().datetime("Invalid datetime format").optional(),
  is_blocked: z.boolean({
    errorMap: ()=>({
        message: "is_blocked must be a boolean"
      })
  }).optional()
});
serve(async (req)=>{
  if (req.method !== "PATCH" && req.method !== "PUT") {
    return createErrorResponse("Method not allowed", 405);
  }
  try {
    // Validate Admin-Token only
    const adminToken = req.headers.get("Admin-Token");
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
    // Parse and validate request body
    let body;
    try {
      body = await req.json();
    } catch  {
      return createErrorResponse("Invalid JSON in request body", 400, "INVALID_JSON");
    }
    const validated = updateUserSchema.parse(body);
    // Check if at least one field to update is provided
    if (!validated.email && !validated.region && !validated.subscription_ends_at && validated.is_blocked === undefined) {
      return createErrorResponse("At least one field must be provided for update", 400, "NO_FIELDS_TO_UPDATE");
    }
    console.log(`Processing update for user_id: ${validated.user_id}`);
    // Fetch existing user metadata
    const { data: existingUser, error: fetchError } = await supabase.from("crm_user_metadata").select("user_id, email, region, subscription_ends_at, is_blocked").eq("user_id", validated.user_id).maybeSingle();
    if (fetchError) {
      console.error("Error fetching user:", fetchError.message);
      return createErrorResponse(`Failed to fetch user: ${fetchError.message}`, 500, "FETCH_ERROR");
    }
    if (!existingUser) {
      return createErrorResponse("User not found", 404, "USER_NOT_FOUND");
    }
    // Prepare update object
    const updateData = {
      updated_at: new Date().toISOString()
    };
    let emailChanged = false;
    // Handle email update
    if (validated.email) {
      const normalizedEmail = validated.email.trim().toLowerCase();
      const oldNormalizedEmail = existingUser.email.trim().toLowerCase();
      if (normalizedEmail !== oldNormalizedEmail) {
        // Check if new email already exists (excluding current user)
        const { data: emailExists, error: emailCheckError } = await supabase.from("crm_user_metadata").select("user_id").eq("email", normalizedEmail).neq("user_id", validated.user_id).maybeSingle();
        if (emailCheckError) {
          console.error("Error checking email:", emailCheckError.message);
          return createErrorResponse(`Failed to check email: ${emailCheckError.message}`, 500, "EMAIL_CHECK_ERROR");
        }
        if (emailExists) {
          return createErrorResponse("Email already exists for another user", 409, "EMAIL_EXISTS");
        }
        // Update auth email
        const { error: authEmailError } = await supabase.auth.admin.updateUserById(validated.user_id, {
          email: validated.email
        });
        if (authEmailError) {
          console.error("Error updating auth email:", authEmailError.message);
          return createErrorResponse(`Failed to update auth email: ${authEmailError.message}`, 500, "AUTH_EMAIL_UPDATE_ERROR");
        }
        updateData.email = normalizedEmail;
        emailChanged = true;
        console.log(`Email updated from ${oldNormalizedEmail} to ${normalizedEmail}`);
      }
    }
    // Handle region update
    if (validated.region && validated.region !== existingUser.region) {
      updateData.region = validated.region;
      console.log(`Region updated from ${existingUser.region} to ${validated.region}`);
    }
    // Handle subscription_ends_at update
    if (validated.subscription_ends_at) {
      const newDate = new Date(validated.subscription_ends_at);
      const oldDate = existingUser.subscription_ends_at ? new Date(existingUser.subscription_ends_at) : null;
      if (!oldDate || newDate.getTime() !== oldDate.getTime()) {
        updateData.subscription_ends_at = validated.subscription_ends_at;
        console.log(`Subscription end date updated from ${existingUser.subscription_ends_at} to ${validated.subscription_ends_at}`);
      }
    }
    // Handle is_blocked update
    if (validated.is_blocked !== undefined && validated.is_blocked !== existingUser.is_blocked) {
      updateData.is_blocked = validated.is_blocked;
      console.log(`User block status updated from ${existingUser.is_blocked} to ${validated.is_blocked}`);
    }
    // Check if there are actual changes to make
    if (Object.keys(updateData).length === 1) {
      // Only updated_at field
      return new Response(JSON.stringify({
        message: "No changes detected",
        user_id: validated.user_id
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // Update user metadata
    const { data: updatedUser, error: updateError } = await supabase.from("crm_user_metadata").update(updateData).eq("user_id", validated.user_id).select("user_id, email, region, subscription_ends_at, is_blocked, updated_at").single();
    if (updateError) {
      console.error("Error updating user metadata:", updateError.message);
      return createErrorResponse(`Failed to update user: ${updateError.message}`, 500, "UPDATE_ERROR");
    }
    console.log(`User ${validated.user_id} updated successfully`);
    return new Response(JSON.stringify({
      message: "User updated successfully",
      user: updatedUser,
      changes: {
        email_changed: emailChanged,
        region_changed: !!updateData.region,
        subscription_extended: !!updateData.subscription_ends_at,
        block_status_changed: updateData.is_blocked !== undefined
      }
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
    if (error?.code === "ERR_JWS_INVALID") {
      return createErrorResponse("Invalid JWT format", 400);
    }
    console.error("Unexpected error:", error);
    return createErrorResponse("Internal server error", 500);
  }
});
