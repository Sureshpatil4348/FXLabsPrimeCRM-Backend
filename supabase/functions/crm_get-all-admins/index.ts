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
    code: "CRM_JWT_SECRET_ERROR"
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
const DEFAULT_PAGE_SIZE = (()=>{
  const n = parseInt(Deno.env.get("CRM_DEFAULT_PAGE_SIZE") ?? "");
  return Number.isFinite(n) && n > 0 ? n : 20;
})();
const MAX_PAGE_SIZE = (()=>{
  const n = parseInt(Deno.env.get("CRM_MAX_PAGE_SIZE") ?? "");
  return Number.isFinite(n) && n > 0 ? n : 100;
})();
// Input validation schema for query parameters
const getAdminsQuerySchema = z.object({
  page: z.string().optional().transform((val)=>{
    const parsed = parseInt(val || "1");
    return isNaN(parsed) || parsed < 1 ? 1 : parsed;
  }),
  page_size: z.string().optional().transform((val)=>{
    const parsed = parseInt(val || `${DEFAULT_PAGE_SIZE}`);
    if (isNaN(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
    if (parsed > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
    return parsed;
  }),
  sort_by: z.enum([
    "email",
    "full_name",
    "created"
  ]).optional().default("created")
});
serve(async (req)=>{
  if (req.method !== "GET") {
    return createErrorResponse("Method not allowed", 405);
  }
  try {
    // === Auth ===
    const adminToken = req.headers.get("Admin-Token");
    if (!adminToken) {
      return createErrorResponse("Admin-Token required", 401);
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
      return createErrorResponse("Admin only", 403);
    }
    // === Parse and validate query params ===
    const url = new URL(req.url);
    const queryParams = {
      page: url.searchParams.get("page") || undefined,
      page_size: url.searchParams.get("page_size") || undefined,
      sort_by: url.searchParams.get("sort_by") || undefined
    };
    const validationResult = getAdminsQuerySchema.safeParse(queryParams);
    if (!validationResult.success) {
      return createErrorResponse("Invalid query parameters", 400, "VALIDATION_ERROR", validationResult.error.issues.map((issue)=>({
          field: issue.path.join("."),
          message: issue.message
        })));
    }
    const { page, page_size: pageSize, sort_by: sortBy } = validationResult.data;
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    // === Build query ===
    // Note: We exclude password_hash for security
    let query = supabase.from("crm_admin").select("email, full_name, created_at");
    // Apply sorting
    switch(sortBy){
      case "email":
        query = query.order("email", {
          ascending: true
        });
        break;
      case "full_name":
        query = query.order("full_name", {
          ascending: true,
          nullsFirst: false
        });
        break;
      case "created":
      default:
        query = query.order("created_at", {
          ascending: false
        });
    }
    // === Get total count ===
    const { count, error: countErr } = await supabase.from("crm_admin").select("*", {
      count: "exact",
      head: true
    });
    if (countErr) throw countErr;
    // === Fetch data ===
    const { data: admins, error: dataErr } = await query.range(from, to);
    if (dataErr) throw dataErr;
    const total = count ?? 0;
    const totalPages = Math.ceil(total / pageSize);
    return new Response(JSON.stringify({
      admins: admins.map((a)=>({
          email: a.email,
          full_name: a.full_name,
          created_at: a.created_at
        })),
      pagination: {
        page,
        page_size: pageSize,
        total,
        total_pages: totalPages,
        has_next: page < totalPages,
        has_prev: page > 1
      },
      filters: {
        sort_by: sortBy
      }
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    console.error("Error:", error);
    if (error?.name === "JWTExpired" || error?.name === "JWSSignatureVerificationFailed") {
      return createErrorResponse("Invalid Admin-Token", 401);
    }
    return createErrorResponse("Internal error", 500);
  }
});
