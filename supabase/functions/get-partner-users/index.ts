import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import { z } from "https://esm.sh/zod@3.22.4";
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
const JWT_SECRET = Deno.env.get("CUSTOM_JWT_SECRET");
// Input validation schema
const querySchema = z.object({
  partner_id: z.string().uuid("Invalid partner_id format").optional(),
  page: z.number().int().min(1).optional().default(1)
});
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
    // Validate Admin-Token or Partner-Token
    const adminToken = req.headers.get("Admin-Token");
    const partnerToken = req.headers.get("Partner-Token");
    if (!adminToken && !partnerToken) {
      return new Response(JSON.stringify({
        error: "Admin-Token or Partner-Token header required"
      }), {
        status: 401,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    const token = adminToken || partnerToken;
    const secret = new TextEncoder().encode(JWT_SECRET);
    const { payload } = await jwtVerify(token, secret, {
      algorithms: [
        "HS256"
      ]
    });
    if (payload.role !== "admin" && payload.role !== "partner") {
      return new Response(JSON.stringify({
        error: "Admin or Partner access required"
      }), {
        status: 403,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // Parse request body
    const url = new URL(req.url);
    const partnerIdParam = url.searchParams.get("partner_id");
    const pageParam = url.searchParams.get("page");
    const validated = querySchema.parse({
      partner_id: partnerIdParam || undefined,
      page: pageParam ? parseInt(pageParam) : 1
    });
    // Determine partner_id
    let targetPartnerId = null;
    if (payload.role === "partner") {
      targetPartnerId = payload.sub;
      if (validated.partner_id && validated.partner_id !== targetPartnerId) {
        return new Response(JSON.stringify({
          error: "Partners can only view their own users"
        }), {
          status: 403,
          headers: {
            "Content-Type": "application/json"
          }
        });
      }
    } else if (payload.role === "admin") {
      targetPartnerId = validated.partner_id || null;
    }
    // Pagination
    const limit = 20;
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
    const { data: payments, error: paymentsError } = await supabase.from("crm_payment").select("user_id, amount").in("user_id", userIds);
    if (paymentsError) {
      console.error("Payments fetch error:", paymentsError);
      throw new Error("Failed to fetch payment data");
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
          total_revenue: Number(partner.total_revenue.toFixed(2)),
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
      return new Response(JSON.stringify({
        error: "Validation error",
        details: error.errors.map((e)=>({
            path: e.path.join("."),
            message: e.message
          }))
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    if (error?.name === "JWTExpired") {
      return new Response(JSON.stringify({
        error: "Token has expired"
      }), {
        status: 401,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    if (error?.name === "JWSSignatureVerificationFailed") {
      return new Response(JSON.stringify({
        error: "Invalid token signature"
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
