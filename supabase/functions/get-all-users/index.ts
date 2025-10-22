import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
// JWT utilities
function getJWTSecret() {
    const secret = Deno.env.get("CUSTOM_JWT_SECRET");
    if (!secret) {
        throw new Error("CUSTOM_JWT_SECRET environment variable is not set");
    }
    return new TextEncoder().encode(secret);
}
function createJWTSecretErrorResponse() {
    return new Response(
        JSON.stringify({
            error: "JWT secret configuration error",
            code: "JWT_SECRET_ERROR",
        }),
        {
            status: 500,
            headers: {
                "Content-Type": "application/json",
            },
        }
    );
}
/**
 * Create a standardized error response
 */ function createErrorResponse(message, status = 500, code, details) {
    const errorResponse = {
        error: message,
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
            "Content-Type": "application/json",
        },
    });
}
const supabase = createClient(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
);
// Pagination configuration from environment (with safe fallbacks)
const DEFAULT_PAGE_SIZE = (() => {
    const n = parseInt(Deno.env.get("DEFAULT_PAGE_SIZE") ?? "");
    return Number.isFinite(n) && n > 0 ? n : 20;
})();
const MAX_PAGE_SIZE = (() => {
    const n = parseInt(Deno.env.get("MAX_PAGE_SIZE") ?? "");
    return Number.isFinite(n) && n > 0 ? n : 100;
})();
serve(async (req) => {
    if (req.method !== "GET") {
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
            algorithms: ["HS256"],
            issuer: Deno.env.get("JWT_ISSUER") ?? undefined,
            audience: Deno.env.get("JWT_AUDIENCE") ?? undefined,
        });
        if (payload.role !== "admin") {
            return createErrorResponse("Admin access required", 403);
        }
        // Get URL params
        const url = new URL(req.url);
        const page = parseInt(url.searchParams.get("page") || "1");
        const reqLimit = parseInt(url.searchParams.get("limit") || "");
        const limit =
            Number.isFinite(reqLimit) && reqLimit > 0
                ? reqLimit
                : DEFAULT_PAGE_SIZE;
        const status = url.searchParams.get("status"); // Filter by subscription_status
        const region = url.searchParams.get("region"); // Filter by region
        // Validate pagination
        if (page < 1 || limit < 1 || limit > MAX_PAGE_SIZE) {
            return createErrorResponse("Invalid pagination parameters", 400);
        }
        const offset = (page - 1) * limit;
        // Build query
        let query = supabase
            .from("crm_user_metadata")
            .select(
                `
        user_id,
        email,
        region,
        subscription_status,
        subscription_ends_at,
        stripe_customer_id,
        converted_at,
        created_at,
        crm_partner:crm_partner_id(email, full_name)
      `,
                {
                    count: "exact",
                }
            )
            .order("created_at", {
                ascending: false,
            })
            .range(offset, offset + limit - 1);
        // Apply filters
        if (status) {
            query = query.eq("subscription_status", status);
        }
        if (region) {
            query = query.eq("region", region);
        }
        const { data: users, error: usersError, count } = await query;
        if (usersError) {
            console.error("Users fetch error:", usersError);
            throw new Error("Failed to fetch users");
        }
        // Get payment totals for all users in a single query (fix N+1 problem)
        // Before: N+1 queries (1 for users + N for each user's payments)
        // After: 2 queries total (1 for users + 1 for all payments)
        const userIds = (users || []).map((user) => user.user_id);
        let allPayments = [];
        if (userIds.length > 0) {
            const { data: paymentsData, error: paymentsError } = await supabase
                .from("crm_payment")
                .select("user_id, amount")
                .in("user_id", userIds);
            if (paymentsError) {
                console.error("Payments fetch error:", paymentsError);
                throw new Error("Failed to fetch payment data");
            }
            allPayments = paymentsData || [];
        }
        // Group payments by user_id and calculate totals
        const paymentTotals = new Map();
        allPayments?.forEach((payment) => {
            const currentTotal = paymentTotals.get(payment.user_id) || 0;
            paymentTotals.set(
                payment.user_id,
                currentTotal + Number(payment.amount)
            );
        });
        // Map users with their payment totals
        const usersWithPayments = (users || []).map((user) => {
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
                partner: user.crm_partner
                    ? {
                          email: user.crm_partner.email,
                          full_name: user.crm_partner.full_name,
                      }
                    : null,
            };
        });
        // Calculate pagination info
        const totalUsers = count || 0;
        const totalPages = Math.ceil(totalUsers / limit);
        const hasNextPage = page < totalPages;
        const hasPreviousPage = page > 1;
        return new Response(
            JSON.stringify({
                users: usersWithPayments,
                pagination: {
                    current_page: page,
                    total_pages: totalPages,
                    total_users: totalUsers,
                    per_page: limit,
                    has_next_page: hasNextPage,
                    has_previous_page: hasPreviousPage,
                },
                filters_applied: {
                    status: status || null,
                    region: region || null,
                },
            }),
            {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                },
            }
        );
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
