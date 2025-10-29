import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import { z } from "https://esm.sh/zod@3.22.4";
// JWT utilities
function getJWTSecret() {
  const secret = Deno.env.get("CRM_CUSTOM_JWT_SECRET");
  if (!secret) {
    throw new Error("CUSTOM_JWT_SECRET environment variable is not set");
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
/**
 * Create a standardized error response
 */ function createErrorResponse(message, status = 500, code, details) {
  const errorResponse = {
    error: message
  };
  if (code) {
    errorResponse.code = code;
  }
  if (details && details.length > 0) {
    errorResponse.details = details;
  }
  return new Response(JSON.stringify(errorResponse), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
/**
 * Create a validation error response from Zod errors
 */ function createValidationErrorResponse(zodError, status = 400) {
  const details = zodError.issues.map((issue)=>({
      field: issue.path.join("."),
      message: issue.message
    }));
  return createErrorResponse("Validation error", status, "VALIDATION_ERROR", details);
}
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
// Input validation schema
const querySchema = z.object({
  partner_email: z.string().email("Invalid email format").optional(),
  page: z.number().int().min(1).optional().default(1)
});
serve(async (req)=>{
  if (req.method !== "GET") {
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
    // Parse request parameters
    const url = new URL(req.url);
    const partnerEmailParam = url.searchParams.get("partner_email");
    const pageParam = url.searchParams.get("page");
    const validated = querySchema.parse({
      partner_email: partnerEmailParam || undefined,
      page: pageParam ? parseInt(pageParam) : 1
    });
    // Determine partner email and ID
    let targetPartnerEmail = null;
    let targetPartnerId = null;
    if (payload.role === "partner") {
      // For partners, get their email from the database using their ID
      const { data: partnerData, error: partnerLookupError } = await supabase.from("crm_partner").select("email, id").eq("id", payload.sub).single();
      if (partnerLookupError || !partnerData) {
        return createErrorResponse("Partner not found", 404);
      }
      targetPartnerEmail = partnerData.email;
      targetPartnerId = partnerData.id;
      // Partners can only view their own users
      if (validated.partner_email && validated.partner_email !== targetPartnerEmail) {
        return createErrorResponse("Partners can only view their own users", 403);
      }
    } else if (payload.role === "admin") {
      // Admins can query by partner_email if provided
      if (validated.partner_email) {
        // Look up partner ID from email
        const { data: partnerData, error: partnerLookupError } = await supabase.from("crm_partner").select("id, email").eq("email", validated.partner_email).single();
        if (partnerLookupError || !partnerData) {
          return createErrorResponse("Partner not found with provided email", 404);
        }
        targetPartnerId = partnerData.id;
        targetPartnerEmail = partnerData.email;
      }
    }
    // Pagination
    const envDefault = parseInt(Deno.env.get("CRM_DEFAULT_PAGE_SIZE") ?? "20");
    const limit = Number.isFinite(envDefault) && envDefault > 0 ? envDefault : 20;
    const page = validated.page;
    const offset = (page - 1) * limit;
    // Build user query
    let query = supabase.from("crm_user_metadata").select("email, region, subscription_status, subscription_ends_at, created_at, converted_at, user_id", {
      count: "exact"
    }).order("created_at", {
      ascending: false
    }).range(offset, offset + limit - 1);
    if (targetPartnerId) {
      query = query.eq("crm_partner_id", targetPartnerId);
    }
    const { data: users, error: usersError, count } = await query;
    if (usersError) {
      console.error("Users fetch error:", usersError);
      throw new Error("Failed to fetch users");
    }
    // Fetch payment data for users
    const userIds = users?.map((u)=>u.user_id) || [];
    let payments = [];
    if (userIds.length > 0) {
      const res = await supabase.from("crm_payment").select("user_id, amount").in("user_id", userIds);
      payments = res.data || [];
      if (res.error) {
        console.error("Payments fetch error:", res.error);
        throw new Error("Failed to fetch payment data");
      }
    }
    // Aggregate total payments per user
    const paymentMap = payments?.reduce((acc, p)=>{
      acc[p.user_id] = (acc[p.user_id] || 0) + Number(p.amount);
      return acc;
    }, {}) || {};
    // Get partner info if specific partner
    let partnerInfo = null;
    if (targetPartnerId) {
      const { data: partner, error: partnerError } = await supabase.from("crm_partner").select("email, full_name, commission_percent, total_revenue, total_converted, is_active").eq("id", targetPartnerId).single();
      if (!partnerError && partner) {
        partnerInfo = {
          email: partner.email,
          full_name: partner.full_name,
          commission_percent: partner.commission_percent,
          total_revenue: Number(Number(partner.total_revenue ?? 0).toFixed(2)),
          total_converted: partner.total_converted,
          is_active: partner.is_active
        };
      }
    }
    // Calculate pagination info
    const totalUsers = count || 0;
    const totalPages = Math.ceil(totalUsers / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;
    return new Response(JSON.stringify({
      partner_info: partnerInfo,
      users: users?.map((u)=>({
          email: u.email,
          region: u.region,
          subscription_status: u.subscription_status,
          subscription_ends_at: u.subscription_ends_at,
          created_at: u.created_at,
          converted_at: u.converted_at,
          total_payments: Number((paymentMap[u.user_id] || 0).toFixed(2))
        })) || [],
      pagination: {
        current_page: page,
        total_pages: totalPages,
        total_users: totalUsers,
        per_page: limit,
        has_next_page: hasNextPage,
        has_previous_page: hasPreviousPage
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
    if (error?.name === "JWTExpired") {
      return createErrorResponse("Token has expired", 401);
    }
    if (error?.name === "JWSSignatureVerificationFailed") {
      return createErrorResponse("Invalid token signature", 401);
    }
    if (error?.code === "ERR_JWS_INVALID") {
      return createErrorResponse("Invalid JWT format", 400);
    }
    console.error("Unexpected error:", error);
    return createErrorResponse("Internal server error", 500);
  }
});
