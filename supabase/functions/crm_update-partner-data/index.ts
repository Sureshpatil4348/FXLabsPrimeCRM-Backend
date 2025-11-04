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
const commissionSlabSchema = z.object({
  min_revenue: z.number().min(0, "Minimum revenue must be non-negative"),
  max_revenue: z.number().min(0, "Maximum revenue must be non-negative").nullable().optional(),
  commission_percent: z.number().min(0, "Commission percent must be non-negative").max(100, "Commission percent cannot exceed 100")
});
const updatePartnerSchema = z.object({
  partner_id: z.string().uuid("Invalid partner ID format"),
  email: z.string().email("Invalid email format").optional(),
  full_name: z.string().min(1, "Full name cannot be empty").optional(),
  is_active: z.boolean().optional(),
  commission_percent: z.number().min(0, "Commission percent must be non-negative").max(100, "Commission percent cannot exceed 100").optional(),
  commission_slabs: z.object({
    slabs: z.array(commissionSlabSchema)
  }).optional()
}).refine((data)=>{
  if (data.commission_slabs) {
    const slabs = data.commission_slabs.slabs;
    for(let i = 0; i < slabs.length; i++){
      const slab = slabs[i];
      if (slab.max_revenue !== null && slab.max_revenue !== undefined) {
        if (slab.max_revenue <= slab.min_revenue) {
          return false;
        }
      }
    }
  }
  return true;
}, {
  message: "Each slab's max_revenue must be greater than min_revenue",
  path: [
    "commission_slabs"
  ]
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
    const validated = updatePartnerSchema.parse(body);
    // Check if at least one field to update is provided
    if (!validated.email && !validated.full_name && validated.is_active === undefined && validated.commission_percent === undefined && !validated.commission_slabs) {
      return createErrorResponse("At least one field must be provided for update", 400, "NO_FIELDS_TO_UPDATE");
    }
    console.log(`Processing update for partner_id: ${validated.partner_id}`);
    // Fetch existing partner data
    const { data: existingPartner, error: fetchError } = await supabase.from("crm_partner").select("id, email, full_name, is_active, commission_percent, commission_slabs").eq("id", validated.partner_id).maybeSingle();
    if (fetchError) {
      console.error("Error fetching partner:", fetchError.message);
      return createErrorResponse(`Failed to fetch partner: ${fetchError.message}`, 500, "FETCH_ERROR");
    }
    if (!existingPartner) {
      return createErrorResponse("Partner not found", 404, "PARTNER_NOT_FOUND");
    }
    // Prepare update object
    const updateData = {
      updated_at: new Date().toISOString()
    };
    let emailChanged = false;
    // Handle email update
    if (validated.email) {
      const normalizedEmail = validated.email.trim().toLowerCase();
      const oldNormalizedEmail = existingPartner.email.trim().toLowerCase();
      if (normalizedEmail !== oldNormalizedEmail) {
        // Check if new email already exists (excluding current partner)
        const { data: emailExists, error: emailCheckError } = await supabase.from("crm_partner").select("id").eq("email", normalizedEmail).neq("id", validated.partner_id).maybeSingle();
        if (emailCheckError) {
          console.error("Error checking email:", emailCheckError.message);
          return createErrorResponse(`Failed to check email: ${emailCheckError.message}`, 500, "EMAIL_CHECK_ERROR");
        }
        if (emailExists) {
          return createErrorResponse("Email already exists for another partner", 409, "EMAIL_EXISTS");
        }
        updateData.email = normalizedEmail;
        emailChanged = true;
        console.log(`Email updated from ${oldNormalizedEmail} to ${normalizedEmail}`);
      }
    }
    // Handle full_name update
    if (validated.full_name && validated.full_name !== existingPartner.full_name) {
      updateData.full_name = validated.full_name;
      console.log(`Full name updated from ${existingPartner.full_name} to ${validated.full_name}`);
    }
    // Handle is_active update
    if (validated.is_active !== undefined && validated.is_active !== existingPartner.is_active) {
      updateData.is_active = validated.is_active;
      console.log(`Active status updated from ${existingPartner.is_active} to ${validated.is_active}`);
    }
    // Handle commission_percent update
    if (validated.commission_percent !== undefined && validated.commission_percent !== existingPartner.commission_percent) {
      updateData.commission_percent = validated.commission_percent;
      console.log(`Commission percent updated from ${existingPartner.commission_percent} to ${validated.commission_percent}`);
    }
    // Handle commission_slabs update
    if (validated.commission_slabs) {
      const existingSlabs = JSON.stringify(existingPartner.commission_slabs);
      const newSlabs = JSON.stringify(validated.commission_slabs);
      if (existingSlabs !== newSlabs) {
        updateData.commission_slabs = validated.commission_slabs;
        console.log(`Commission slabs updated`);
      }
    }
    // Check if there are actual changes to make
    if (Object.keys(updateData).length === 1) {
      // Only updated_at field
      return new Response(JSON.stringify({
        message: "No changes detected",
        partner_id: validated.partner_id
      }), {
        status: 200,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // Update partner data
    const { data: updatedPartner, error: updateError } = await supabase.from("crm_partner").update(updateData).eq("id", validated.partner_id).select("id, email, full_name, is_active, commission_percent, commission_slabs, updated_at").single();
    if (updateError) {
      console.error("Error updating partner:", updateError.message);
      return createErrorResponse(`Failed to update partner: ${updateError.message}`, 500, "UPDATE_ERROR");
    }
    console.log(`Partner ${validated.partner_id} updated successfully`);
    return new Response(JSON.stringify({
      message: "Partner updated successfully",
      partner: updatedPartner,
      changes: {
        email_changed: emailChanged,
        full_name_changed: !!updateData.full_name,
        is_active_changed: updateData.is_active !== undefined,
        commission_percent_changed: updateData.commission_percent !== undefined,
        commission_slabs_changed: !!updateData.commission_slabs
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
