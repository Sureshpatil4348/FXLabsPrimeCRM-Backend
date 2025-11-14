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
    code: "CRM_JWT_SECRET_ERROR"
  }), {
    status: 500,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
function createErrorResponse(message, status = 500, code, details) {
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
const DEFAULT_PAGE_SIZE = (()=>{
  const n = parseInt(Deno.env.get("CRM_DEFAULT_PAGE_SIZE") ?? "");
  return Number.isFinite(n) && n > 0 ? n : 20;
})();
const MAX_PAGE_SIZE = (()=>{
  const n = parseInt(Deno.env.get("CRM_MAX_PAGE_SIZE") ?? "");
  return Number.isFinite(n) && n > 0 ? n : 100;
})();
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
    // Get URL params
    const url = new URL(req.url);
    const rawPage = url.searchParams.get("page");
    const rawLimit = url.searchParams.get("limit");
    // Parse and validate page
    const parsedPage = rawPage ? Number(rawPage) : 1;
    const page = Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.floor(parsedPage) : 1;
    // Parse and validate limit
    const parsedLimit = rawLimit ? Number(rawLimit) : DEFAULT_PAGE_SIZE;
    const limit = Number.isFinite(parsedLimit) && parsedLimit >= 1 && parsedLimit <= MAX_PAGE_SIZE ? Math.floor(parsedLimit) : parsedLimit > MAX_PAGE_SIZE ? MAX_PAGE_SIZE : DEFAULT_PAGE_SIZE;
    // Get filter parameters
    const status = url.searchParams.get("status");
    const region = url.searchParams.get("region");
    const blocked = url.searchParams.get("blocked"); // 'true', 'false', or null for all
    const searchQuery = url.searchParams.get("search");
    const searchField = url.searchParams.get("search_field"); // 'email', 'region', 'partner_email', 'partner_name', 'all'
    const sortBy = url.searchParams.get("sort_by") || "created_at"; // 'created_at' or 'subscription_ends_at'
    const sortOrder = url.searchParams.get("sort_order") || "desc"; // 'asc' or 'desc'
    const offset = (page - 1) * limit;
    // Build query
    let query = supabase.from("crm_user_metadata").select(`
        user_id,
        email,
        region,
        subscription_status,
        subscription_ends_at,
        stripe_customer_id,
        converted_at,
        created_at,
        is_blocked,
        crm_partner:crm_partner_id(email, full_name)
      `, {
      count: "exact"
    });
    // Apply subscription status filter
    if (status && status !== "all") {
      query = query.eq("subscription_status", status);
    }
    // Apply region filter
    if (region && region !== "all") {
      query = query.eq("region", region);
    }
    // Apply blocked filter
    if (blocked === "blocked") {
      query = query.eq("is_blocked", true);
    } else if (blocked === "unblocked") {
      query = query.eq("is_blocked", false);
    }
    // Apply search filter
    if (searchQuery && searchQuery.trim() !== "") {
      const searchTerm = searchQuery.trim();
      if (searchField === "email" || searchField === "all") {
        query = query.ilike("email", `%${searchTerm}%`);
      } else if (searchField === "region") {
        query = query.ilike("region", `%${searchTerm}%`);
      }
    // Note: For partner_email and partner_name, we'll need to filter after fetching
    // because Supabase doesn't support filtering on joined tables directly in this way
    // We'll handle this in post-processing
    }
    // Apply sorting
    const validSortFields = [
      "created_at",
      "subscription_ends_at"
    ];
    const sortField = validSortFields.includes(sortBy) ? sortBy : "created_at";
    const ascending = sortOrder === "asc";
    query = query.order(sortField, {
      ascending,
      nullsFirst: false
    });
    // Apply pagination
    query = query.range(offset, offset + limit - 1);
    const { data: users, error: usersError, count } = await query;
    if (usersError) {
      console.error("Users fetch error:", usersError);
      throw new Error("Failed to fetch users");
    }
    // Post-process for partner search if needed
    let filteredUsers = users || [];
    if (searchQuery && searchQuery.trim() !== "" && (searchField === "partner_email" || searchField === "partner_name" || searchField === "all")) {
      const searchTerm = searchQuery.trim().toLowerCase();
      filteredUsers = filteredUsers.filter((user)=>{
        if (searchField === "partner_email" || searchField === "all") {
          const partnerEmail = user.crm_partner?.email?.toLowerCase() || "";
          if (partnerEmail.includes(searchTerm)) return true;
        }
        if (searchField === "partner_name" || searchField === "all") {
          const partnerName = user.crm_partner?.full_name?.toLowerCase() || "";
          if (partnerName.includes(searchTerm)) return true;
        }
        // For 'all' search, also check email and region (already filtered by DB, but include for completeness)
        if (searchField === "all") {
          const email = user.email?.toLowerCase() || "";
          const region = user.region?.toLowerCase() || "";
          if (email.includes(searchTerm) || region.includes(searchTerm)) return true;
        }
        return false;
      });
    }
    // Get payment totals for all users in a single query
    const userIds = filteredUsers.map((user)=>user.user_id);
    let allPayments = [];
    if (userIds.length > 0) {
      const { data: paymentsData, error: paymentsError } = await supabase.from("crm_payment").select("user_id, amount").in("user_id", userIds);
      if (paymentsError) {
        console.error("Payments fetch error:", paymentsError);
        throw new Error("Failed to fetch payment data");
      }
      allPayments = paymentsData || [];
    }
    // Group payments by user_id and calculate totals
    const paymentTotals = new Map();
    allPayments?.forEach((payment)=>{
      const currentTotal = paymentTotals.get(payment.user_id) || 0;
      paymentTotals.set(payment.user_id, currentTotal + Number(payment.amount));
    });
    // Map users with their payment totals
    const usersWithPayments = filteredUsers.map((user)=>{
      const totalSpent = paymentTotals.get(user.user_id) || 0;
      return {
        user_id: user.user_id,
        email: user.email,
        region: user.region,
        subscription_status: user.subscription_status,
        subscription_ends_at: user.subscription_ends_at,
        has_paid: !!user.converted_at,
        total_spent: Number(totalSpent.toFixed(2)),
        converted_at: user.converted_at,
        created_at: user.created_at,
        is_blocked: user.is_blocked,
        partner: user.crm_partner ? {
          email: user.crm_partner.email,
          full_name: user.crm_partner.full_name
        } : null
      };
    });
    // Calculate pagination info
    // Note: When filtering by partner fields in post-processing, 
    // the count will be slightly off. For accurate counts with partner filtering,
    // you'd need to restructure the database or use a different approach.
    const totalUsers = count || 0;
    const totalPages = Math.ceil(totalUsers / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;
    return new Response(JSON.stringify({
      users: usersWithPayments,
      pagination: {
        current_page: page,
        total_pages: totalPages,
        total_users: totalUsers,
        per_page: limit,
        has_next_page: hasNextPage,
        has_previous_page: hasPreviousPage
      },
      filters_applied: {
        status: status || null,
        region: region || null,
        blocked: blocked || null,
        search_query: searchQuery || null,
        search_field: searchField || null,
        sort_by: sortBy,
        sort_order: sortOrder
      }
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
    console.error("Unexpected error:", error);
    return createErrorResponse("Internal server error", 500);
  }
});
