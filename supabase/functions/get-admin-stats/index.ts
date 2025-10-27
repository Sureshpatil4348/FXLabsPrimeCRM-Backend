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
 */ function createErrorResponse(message, status = 500, code = null, details = []) {
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
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
serve(async (req)=>{
  if (req.method !== "GET") {
    return createErrorResponse("Method not allowed", 405);
  }
  try {
    // Validate Admin-Token
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
    // Get current date for calculations
    const now = new Date();
    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    // 1. Get revenue + user_id (reuse for commissions)
    const { data: revenueData, error: revenueError } = await supabase.from("crm_payment").select("amount, paid_at, user_id").eq("currency", "usd");
    if (revenueError) {
      console.error("Revenue fetch error:", revenueError);
      throw new Error("Failed to fetch revenue data");
    }
    const totalRevenue = revenueData?.reduce((sum, payment)=>sum + Number(payment.amount), 0) || 0;
    const lastMonthRevenue = revenueData?.filter((payment)=>new Date(payment.paid_at) >= oneMonthAgo).reduce((sum, payment)=>sum + Number(payment.amount), 0) || 0;
    const totalPayments = revenueData?.length || 0;
    const averagePaymentAmount = totalPayments > 0 ? totalRevenue / totalPayments : 0;
    // 2. Get user stats
    const { data: userData, error: userError } = await supabase.from("crm_user_metadata").select("subscription_status, region, created_at");
    if (userError) {
      console.error("User fetch error:", userError);
      throw new Error("Failed to fetch user data");
    }
    const totalUsers = userData?.length || 0;
    const totalAdded = userData?.filter((u)=>u.subscription_status === "added").length || 0;
    const totalActive = userData?.filter((u)=>u.subscription_status === "active").length || 0;
    const totalExpired = userData?.filter((u)=>u.subscription_status === "expired").length || 0;
    const recentSignups = userData?.filter((u)=>new Date(u.created_at) >= oneMonthAgo).length || 0;
    // Initialize all regions with 0
    const totalUsersByRegion = {
      "India": 0,
      "International": 0,
      "null": 0
    };
    // Count users by region
    userData?.forEach((u)=>{
      const region = u.region || "null";
      if (region in totalUsersByRegion) {
        totalUsersByRegion[region]++;
      } else {
        totalUsersByRegion[region] = 1;
      }
    });
    // 3. Get partner stats
    const { data: partnerData, error: partnerError } = await supabase.from("crm_partner").select("id, is_active");
    if (partnerError) {
      console.error("Partner fetch error:", partnerError);
      throw new Error("Failed to fetch partner data");
    }
    const totalPartners = partnerData?.length || 0;
    const activePartners = partnerData?.filter((p)=>p.is_active).length || 0;
    // 4. Get partner commission paid
    const payments = revenueData || [];
    const userIds = payments.map((p)=>p.user_id).filter(Boolean);
    let metadata = [];
    if (userIds.length > 0) {
      const { data: md, error: metadataError } = await supabase.from("crm_user_metadata").select("user_id, crm_partner_id").in("user_id", userIds).not("crm_partner_id", "is", null);
      if (metadataError) {
        console.error("Metadata fetch error:", metadataError);
        throw new Error("Failed to fetch metadata");
      }
      metadata = md || [];
    }
    const partnerIds = metadata.map((m)=>m.crm_partner_id);
    let partners = [];
    if (partnerIds.length > 0) {
      const { data: ps, error: partnersError } = await supabase.from("crm_partner").select("id, commission_percent").in("id", partnerIds);
      if (partnersError) {
        console.error("Partners fetch error:", partnersError);
        throw new Error("Failed to fetch partners");
      }
      partners = ps || [];
    }
    const partnerMap = new Map(partners.map((p)=>[
        p.id,
        p.commission_percent
      ]));
    const metadataMap = new Map(metadata.map((m)=>[
        m.user_id,
        m.crm_partner_id
      ]));
    const totalCommissionPaid = payments.reduce((sum, payment)=>{
      const partnerId = metadataMap.get(payment.user_id);
      if (!partnerId) return sum;
      const percent = partnerMap.get(partnerId) ?? 0;
      return sum + Number(payment.amount) * (percent / 100);
    }, 0);
    const lastMonthCommission = payments.reduce((sum, payment)=>{
      if (new Date(payment.paid_at) < oneMonthAgo) return sum;
      const partnerId = metadataMap.get(payment.user_id);
      if (!partnerId) return sum;
      const percent = partnerMap.get(partnerId) ?? 0;
      return sum + Number(payment.amount) * (percent / 100);
    }, 0);
    return new Response(JSON.stringify({
      revenue: {
        total: Number(totalRevenue.toFixed(2)),
        last_month: Number(lastMonthRevenue.toFixed(2)),
        total_payments: totalPayments,
        average_payment_amount: Number(averagePaymentAmount.toFixed(2)),
        currency: "usd"
      },
      users: {
        total_users: totalUsers,
        total_added: totalAdded,
        total_active: totalActive,
        total_expired: totalExpired,
        total_users_by_region: totalUsersByRegion,
        recent_users_30_days: recentSignups
      },
      partners: {
        total_partners: totalPartners,
        active_partners: activePartners,
        total_commission_paid: Number(totalCommissionPaid.toFixed(2)),
        last_month_commission: Number(lastMonthCommission.toFixed(2))
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
      return createErrorResponse("Admin-Token has expired", 401);
    }
    if (error?.name === "JWSSignatureVerificationFailed") {
      return createErrorResponse("Invalid Admin-Token signature", 401);
    }
    if (error?.code === "ERR_JWS_INVALID") {
      return createErrorResponse("Invalid JWT format", 400);
    }
    if (error?.name === "JWTInvalid" || error?.name === "JWSInvalid" || error?.name === "JWTClaimValidationFailed") {
      return createErrorResponse("Invalid Admin-Token", 401);
    }
    console.error("Unexpected error:", error);
    return createErrorResponse("Internal server error", 500);
  }
});
