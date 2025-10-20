import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
const JWT_SECRET = Deno.env.get("CUSTOM_JWT_SECRET");
serve(async (req)=>{
  if (req.method !== "GET") {
    return new Response(JSON.stringify({
      error: "Method not allowed"
    }), {
      status: 405,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
  try {
    // Validate Admin-Token only
    const adminToken = req.headers.get("Admin-Token");
    if (!adminToken) {
      return new Response(JSON.stringify({
        error: "Admin-Token header required"
      }), {
        status: 401,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jwtVerify(adminToken, secret, {
      algorithms: [
        "HS256"
      ]
    });
    if (payload.role !== "admin") {
      return new Response(JSON.stringify({
        error: "Admin access required"
      }), {
        status: 403,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // Get URL params
    const url = new URL(req.url);
    const page = parseInt(url.searchParams.get("page") || "1");
    const limit = parseInt(url.searchParams.get("limit") || "20");
    const status = url.searchParams.get("status"); // Filter by subscription_status
    const region = url.searchParams.get("region"); // Filter by region
    // Validate pagination
    if (page < 1 || limit < 1 || limit > 100) {
      return new Response(JSON.stringify({
        error: "Invalid pagination parameters"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
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
        crm_partner:crm_partner_id(email, full_name)
      `, {
      count: "exact"
    }).order("created_at", {
      ascending: false
    }).range(offset, offset + limit - 1);
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
    // Get payment totals for each user
    const usersWithPayments = await Promise.all((users || []).map(async (user)=>{
      const { data: payments } = await supabase.from("crm_payment").select("amount").eq("user_id", user.user_id);
      const totalSpent = payments?.reduce((sum, p)=>sum + Number(p.amount), 0) || 0;
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
        partner: user.crm_partner ? {
          email: user.crm_partner.email,
          full_name: user.crm_partner.full_name
        } : null
      };
    }));
    // Calculate pagination info
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
        region: region || null
      }
    }), {
      status: 200,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    if (error?.name === "JWTExpired") {
      return new Response(JSON.stringify({
        error: "Admin-Token has expired"
      }), {
        status: 401,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    if (error?.name === "JWSSignatureVerificationFailed") {
      return new Response(JSON.stringify({
        error: "Invalid Admin-Token signature"
      }), {
        status: 401,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    if (error?.code === "ERR_JWS_INVALID") {
      return new Response(JSON.stringify({
        error: "Invalid JWT format"
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    console.error("Unexpected error:", error);
    return new Response(JSON.stringify({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error"
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});
