import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
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
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
serve(async (req)=>{
  if (req.method !== "GET") {
    return createErrorResponse("Method not allowed", 405);
  }
  try {
    // Validate Partner-Token only
    const partnerToken = req.headers.get("Partner-Token");
    if (!partnerToken) {
      return createErrorResponse("Partner-Token header required", 401);
    }
    let secret;
    try {
      secret = getJWTSecret();
    } catch (error) {
      return createJWTSecretErrorResponse();
    }
    const { payload } = await jwtVerify(partnerToken, secret, {
      algorithms: [
        "HS256"
      ],
      issuer: Deno.env.get("CRM_JWT_ISSUER") ?? undefined,
      audience: Deno.env.get("CRM_JWT_AUDIENCE") ?? undefined
    });
    if (payload.role !== "partner") {
      return createErrorResponse("Partner access required", 403);
    }
    if (!payload.sub) {
      return createErrorResponse("Missing subject in token", 401);
    }
    const partnerId = payload.sub;
    // Get partner details
    const { data: partner, error: partnerError } = await supabase.from("crm_partner").select("email, full_name, commission_percent, is_active, created_at, total_revenue, total_converted").eq("id", partnerId).single();
    if (partnerError || !partner) {
      return createErrorResponse("Partner not found", 404);
    }
    if (!partner.is_active) {
      return createErrorResponse("Partner is inactive", 403);
    }
    // Get user stats
    const { data: users, error: usersError } = await supabase.from("crm_user_metadata").select("subscription_status, converted_at, created_at, region, user_id").eq("crm_partner_id", partnerId);
    if (usersError) {
      console.error("Users fetch error:", JSON.stringify(usersError, null, 2));
      throw new Error("Failed to fetch users");
    }
    const totalUsers = users?.length || 0;
    const totalTrial = users?.filter((u)=>u.subscription_status === "trial").length || 0;
    const totalPaid = users?.filter((u)=>u.subscription_status === "paid").length || 0;
    const totalExpired = users?.filter((u)=>u.subscription_status === "expired").length || 0;
    const totalActive = totalUsers - totalExpired;
    const usersByRegion = users?.reduce((acc, u)=>{
      acc[u.region] = (acc[u.region] || 0) + 1;
      return acc;
    }, {}) || {};
    // Get revenue stats
    let payments = [];
    let totalPayments = 0;
    let lastMonthRevenue = 0;
    if (users?.length) {
      const userIds = users.map((u)=>u.user_id);
      const { data: paymentsData, error: paymentsError } = await supabase.from("crm_payment").select("amount, paid_at").in("user_id", userIds);
      if (paymentsError) {
        console.error("Payments fetch error:", JSON.stringify(paymentsError, null, 2));
        throw new Error("Failed to fetch payment data");
      }
      payments = paymentsData || [];
      totalPayments = payments.length;
      const now = new Date();
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      lastMonthRevenue = payments.filter((p)=>new Date(p.paid_at) >= thirtyDaysAgo).reduce((sum, p)=>sum + Number(p.amount), 0) || 0;
    }
    // Get recent signups and conversions
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentSignups = users?.filter((u)=>new Date(u.created_at) >= thirtyDaysAgo).length || 0;
    const lastMonthConversions = users?.filter((u)=>u.converted_at && new Date(u.converted_at) >= thirtyDaysAgo).length || 0;
    // Calculate conversion rate
    const conversionRate = totalUsers > 0 ? Number((partner.total_converted / totalUsers * 100).toFixed(2)) : 0;
    return new Response(JSON.stringify({
      partner: {
        email: partner.email,
        full_name: partner.full_name,
        commission_percent: partner.commission_percent,
        is_active: partner.is_active,
        joined_at: partner.created_at,
        total_revenue: Number(Number(partner.total_revenue).toFixed(2)),
        total_converted: partner.total_converted
      },
      users: {
        total_users: totalUsers,
        total_pending: totalTrial,
        total_active: totalActive,
        total_expired: totalExpired,
        users_by_region: usersByRegion,
        recent_users_30_days: recentSignups,
        last_month_conversions: lastMonthConversions,
        conversion_rate: conversionRate
      },
      revenue: {
        total: Number(Number(partner.total_revenue).toFixed(2)),
        last_month: Number(lastMonthRevenue.toFixed(2)),
        total_payments: totalPayments,
        currency: "usd"
      },
      generated_at: now.toISOString()
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    if (error?.name === "JWTExpired") {
      return createErrorResponse("Partner-Token has expired", 401);
    }
    if (error?.name === "JWSSignatureVerificationFailed") {
      return createErrorResponse("Invalid Partner-Token signature", 401);
    }
    if (error?.code === "ERR_JWS_INVALID") {
      return createErrorResponse("Invalid JWT format", 400);
    }
    console.error("Unexpected error:", JSON.stringify(error, null, 2));
    return createErrorResponse("Internal server error", 500);
  }
});
