import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.22.4";
import { SignJWT } from "https://esm.sh/jose@4.14.4";
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
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
async function verifyPassword(password, hash) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashHex = Array.from(new Uint8Array(hashBuffer)).map((b)=>b.toString(16).padStart(2, "0")).join("");
  return hashHex === hash;
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
    const body = await req.json();
    const validated = loginSchema.parse(body);
    // Query the appropriate table
    const tableName = validated.role === "admin" ? "crm_admin" : "crm_partner";
    const selectColumns = validated.role === "admin" ? "id, password_hash" : "id, password_hash, is_active";
    const { data: user, error } = await supabase.from(tableName).select(selectColumns).eq("email", validated.email).single();
    if (error || !user) {
      return new Response(JSON.stringify({
        error: "Email does not exist"
      }), {
        status: 404,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // Check if partner account is inactive
    if (validated.role === "partner" && !user.is_active) {
      return new Response(JSON.stringify({
        error: "Account is inactive"
      }), {
        status: 403,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // Verify password
    const isValid = await verifyPassword(validated.password, user.password_hash);
    if (!isValid) {
      return new Response(JSON.stringify({
        error: "Incorrect password"
      }), {
        status: 401,
        headers: {
          "Content-Type": "application/json"
        }
      });
    }
    // Generate JWT
    const secret = new TextEncoder().encode(Deno.env.get("CUSTOM_JWT_SECRET") || "fallback-secret");
    const token = await new SignJWT({
      sub: user.id,
      role: validated.role,
      jti: crypto.randomUUID()
    }).setProtectedHeader({
      alg: "HS256"
    }).setIssuedAt().setExpirationTime("30d").sign(secret);
    const tokenKey = validated.role === "admin" ? "Admin-Token" : "Partner-Token";
    return new Response(JSON.stringify({
      [tokenKey]: token
    }), {
      status: 200,
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
    console.error("Login error:", error);
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
