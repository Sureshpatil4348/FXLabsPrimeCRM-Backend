import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
const JWT_SECRET = Deno.env.get("CUSTOM_JWT_SECRET");
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
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
    // === Auth ===
    const adminToken = req.headers.get("Admin-Token");
    if (!adminToken) {
      return new Response(JSON.stringify({
        error: "Admin-Token required"
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
        error: "Admin only"
      }), {
        status: 403,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // === Parse query params ===
    const url = new URL(req.url);
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(url.searchParams.get("page_size") || `${DEFAULT_PAGE_SIZE}`)));
    const sortBy = url.searchParams.get("sort_by") || "created";
    // Validate sort_by
    const validSorts = [
      "revenue",
      "added",
      "converted",
      "created"
    ];
    if (!validSorts.includes(sortBy)) {
      return new Response(JSON.stringify({
        error: `sort_by must be one of: ${validSorts.join(", ")}`
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    const from = (page - 1) * pageSize;
    const to = from + pageSize - 1;
    // === Build query ===
    let query = supabase.from("crm_partner").select("id, email, full_name, commission_percent, total_revenue, total_added, total_converted, created_at");
    // Apply sorting
    switch(sortBy){
      case "revenue":
        query = query.order("total_revenue", {
          ascending: false
        });
        break;
      case "added":
        query = query.order("total_added", {
          ascending: false
        });
        break;
      case "converted":
        query = query.order("total_converted", {
          ascending: false
        });
        break;
      case "created":
      default:
        query = query.order("created_at", {
          ascending: false
        });
    }
    // === Get total count ===
    const { count, error: countErr } = await supabase.from("crm_partner").select("*", {
      count: "exact",
      head: true
    });
    if (countErr) throw countErr;
    // === Fetch data ===
    const { data: partners, error: dataErr } = await query.range(from, to);
    if (dataErr) throw dataErr;
    const total = count ?? 0;
    const totalPages = Math.ceil(total / pageSize);
    return new Response(JSON.stringify({
      partners: partners.map((p)=>({
          partner_id: p.id,
          email: p.email,
          full_name: p.full_name,
          commission_percent: p.commission_percent,
          total_revenue: parseFloat(p.total_revenue),
          total_added: p.total_added,
          total_converted: p.total_converted,
          created_at: p.created_at
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
      return new Response(JSON.stringify({
        error: "Invalid Admin-Token"
      }), {
        status: 401,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    return new Response(JSON.stringify({
      error: "Internal error"
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});
