import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.22.4";
import { SignJWT } from "https://esm.sh/jose@4.14.4";
import { compareSync } from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";
// Allowed origins list
const allowedOrigins = [
  "https://fxlabsprime-crm-qa.netlify.app",
  "https://fxlabsprime-crm-dev.netlify.app",
  "https://crm.fxlabsprime.com"
];
// Base CORS headers (without origin)
const baseCorsHeaders = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
  "Access-Control-Allow-Credentials": "true"
};
// Dummy hash for timing attack prevention (bcrypt hash of random string)
const DUMMY_HASH = "$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewfBPj6fM9Kbq";
// Utility: Get CORS headers with dynamic origin
function getCorsHeaders(req) {
  const origin = req.headers.get("Origin");
  const isAllowedOrigin = origin && allowedOrigins.includes(origin);
  return {
    ...baseCorsHeaders,
    ...isAllowedOrigin && {
      "Access-Control-Allow-Origin": origin
    }
  };
}
// Utility: Get JWT secret
function getJWTSecret() {
  const secret = Deno.env.get("CRM_CUSTOM_JWT_SECRET");
  if (!secret) throw new Error("CRM_CUSTOM_JWT_SECRET environment variable is not set");
  return new TextEncoder().encode(secret);
}
// Utility: JWT Secret error
function createJWTSecretErrorResponse(corsHeaders) {
  return new Response(JSON.stringify({
    error: "JWT secret configuration error",
    code: "JWT_SECRET_ERROR"
  }), {
    status: 500,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders
    }
  });
}
// Utility: Standard error response
function createErrorResponse(message, status = 500, code = null, details = [], corsHeaders) {
  const errorResponse = {
    error: message
  };
  if (code) errorResponse.code = code;
  if (details.length > 0) errorResponse.details = details;
  return new Response(JSON.stringify(errorResponse), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders
    }
  });
}
// Utility: Zod validation errors
function createValidationErrorResponse(zodError, corsHeaders, status = 400) {
  const details = zodError.issues.map((issue)=>({
      field: issue.path.join("."),
      message: issue.message
    }));
  return createErrorResponse("Validation error", status, "VALIDATION_ERROR", details, corsHeaders);
}
// Initialize Supabase client
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
// Define schema
const loginSchema = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
  role: z.enum([
    "admin",
    "partner"
  ], {
    errorMap: ()=>({
        message: "Role must be 'admin' or 'partner'"
      })
  })
});
serve(async (req)=>{
  // Get dynamic CORS headers based on request origin
  const corsHeaders = getCorsHeaders(req);
  // Handle preflight (OPTIONS) request
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }
  if (req.method !== "POST") {
    return createErrorResponse("Method not allowed", 405, null, [], corsHeaders);
  }
  try {
    let body;
    try {
      body = await req.json();
    } catch  {
      return createErrorResponse("Invalid JSON in request body", 400, "INVALID_JSON", [], corsHeaders);
    }
    const validated = loginSchema.parse(body);
    const tableName = validated.role === "admin" ? "crm_admin" : "crm_partner";
    const selectColumns = validated.role === "admin" ? "id, password_hash" : "id, password_hash, is_active";
    const { data: user, error } = await supabase.from(tableName).select(selectColumns).eq("email", validated.email).single();
    // Always perform password verification for timing attack prevention
    const passwordHash = user?.password_hash || DUMMY_HASH;
    const isValidPassword = compareSync(validated.password, passwordHash);
    if (error || !user || !isValidPassword) {
      return createErrorResponse("Invalid credentials", 401, "INVALID_CREDENTIALS", [], corsHeaders);
    }
    // Check partner status only after successful authentication
    if (validated.role === "partner" && !user.is_active) {
      return createErrorResponse("Account is inactive", 403, null, [], corsHeaders);
    }
    // Generate JWT
    let secret;
    try {
      secret = getJWTSecret();
    } catch  {
      return createJWTSecretErrorResponse(corsHeaders);
    }
    const token = await new SignJWT({
      sub: user.id,
      role: validated.role,
      jti: crypto.randomUUID()
    }).setProtectedHeader({
      alg: "HS256"
    }).setIssuedAt().setIssuer(Deno.env.get("CRM_JWT_ISSUER") ?? "fxlabsprimecrm").setAudience(Deno.env.get("CRM_JWT_AUDIENCE") ?? "fxlabsprimecrm-clients").setExpirationTime("30d").sign(secret);
    const tokenKey = validated.role === "admin" ? "Admin-Token" : "Partner-Token";
    return new Response(JSON.stringify({
      [tokenKey]: token
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createValidationErrorResponse(error, corsHeaders);
    }
    console.error("Login error:", error);
    return createErrorResponse("Internal server error", 500, null, [], corsHeaders);
  }
});
