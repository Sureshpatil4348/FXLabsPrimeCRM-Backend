import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import { z } from "https://esm.sh/zod@3.22.4";
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
const JWT_SECRET = Deno.env.get("CUSTOM_JWT_SECRET");
// Input validation schema
const createPartnerSchema = z.object({
  full_name: z.string().min(1, "Full name is required"),
  email: z.string().email("Invalid email format"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  commission_percent: z.number().int().min(0, "Commission must be ≥ 0").max(50, "Commission must be ≤ 50").optional().default(10)
});
async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer)).map((b)=>b.toString(16).padStart(2, "0")).join("");
}
serve(async (req)=>{
  if (req.method !== "POST") {
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
    // === 1. Validate Admin-Token ===
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
    // === 2. Parse and validate request body ===
    const body = await req.json();
    const validated = createPartnerSchema.parse(body);
    // === 3. Check if partner email already exists ===
    const { data: existing, error: checkError } = await supabase.from("crm_partner").select("id").eq("email", validated.email).single();
    if (!checkError && existing) {
      return new Response(JSON.stringify({
        error: "Partner with this email already exists"
      }), {
        status: 409,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // === 4. Hash password and insert ===
    const passwordHash = await hashPassword(validated.password);
    const { data: inserted, error: insertError } = await supabase.from("crm_partner").insert({
      email: validated.email,
      full_name: validated.full_name,
      password_hash: passwordHash,
      commission_percent: validated.commission_percent,
      is_active: true
    }).select("email, full_name").single();
    if (insertError) {
      console.error("Insert error:", insertError);
      return new Response(JSON.stringify({
        error: "Failed to create partner"
      }), {
        status: 500,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // === 5. Success ===
    return new Response(JSON.stringify({
      message: `Partner ${inserted.full_name} with Email - ${inserted.email} has been created successfully`
    }), {
      status: 201,
      headers: {
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return new Response(JSON.stringify({
        error: error.errors[0].message
      }), {
        status: 400,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    if (error?.name === "JWTExpired" || error?.name === "JWSSignatureVerificationFailed") {
      return new Response(JSON.stringify({
        error: "Invalid or expired Admin-Token"
      }), {
        status: 401,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    console.error("Unexpected error:", error);
    return new Response(JSON.stringify({
      error: "Internal server error"
    }), {
      status: 500,
      headers: {
        "Content-Type": "application/json"
      }
    });
  }
});
