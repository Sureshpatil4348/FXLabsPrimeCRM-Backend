import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import { z } from "https://esm.sh/zod@3.22.4";
const supabase = createClient(Deno.env.get("SUPABASE_URL"), Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
const JWT_SECRET = Deno.env.get("CUSTOM_JWT_SECRET");
// Input validation schema
const createUserSchema = z.object({
  users: z.array(z.object({
    email: z.string().email("Invalid email format")
  })).min(1, "At least one user is required"),
  region: z.enum([
    "India",
    "International"
  ], {
    errorMap: ()=>({
        message: "Region must be 'India' or 'International'"
      })
  }),
  trial_days: z.number().int().min(1, "trial_days must be a positive integer").optional().default(15)
});
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
    const partnerId = payload.role === "partner" ? payload.sub : null;
    // Parse and validate request body
    const body = await req.json();
    const validated = createUserSchema.parse(body);
    const createdUsers = [];
    const existingUsers = [];
    const failedUsers = [];
    // Calculate subscription end date
    const subscriptionEndsAt = new Date(Date.now() + validated.trial_days * 24 * 60 * 60 * 1000).toISOString();
    for (const userInput of validated.users){
      const { email } = userInput;
      try {
        // Check if email already exists in crm_user_metadata
        const { data: existingMeta, error: metaCheckError } = await supabase.from("crm_user_metadata").select("email, user_id").eq("email", email).maybeSingle();
        if (existingMeta) {
          console.log(`Email already exists: ${email}`);
          existingUsers.push({
            email,
            reason: "User already exists"
          });
          continue;
        }
        // Create user in auth.users
        console.log(`Creating auth user for ${email}`);
        const { data: authUser, error: authError } = await supabase.auth.admin.createUser({
          email,
          email_confirm: true
        });
        if (authError || !authUser?.user) {
          console.error(`Auth create error for ${email}:`, authError?.message || "No user returned");
          failedUsers.push({
            email,
            reason: authError?.message || "User creation failed"
          });
          continue;
        }
        console.log(`Auth user created for ${email}, user_id: ${authUser.user.id}`);
        // Insert into crm_user_metadata
        const { data: metaData, error: metaError } = await supabase.from("crm_user_metadata").insert({
          user_id: authUser.user.id,
          email,
          region: validated.region,
          crm_partner_id: partnerId,
          subscription_status: "added",
          subscription_ends_at: subscriptionEndsAt,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        }).select("email").single();
        if (metaError) {
          console.error(`Metadata insert error for ${email}:`, metaError.message);
          await supabase.auth.admin.deleteUser(authUser.user.id);
          failedUsers.push({
            email,
            reason: metaError.message
          });
          continue;
        }
        createdUsers.push({
          email: metaData.email
        });
      } catch (userError) {
        console.error(`Error processing ${email}:`, userError);
        failedUsers.push({
          email,
          reason: userError instanceof Error ? userError.message : "Unknown error"
        });
      }
    }
    const statusCode = createdUsers.length > 0 ? 201 : existingUsers.length > 0 ? 200 : 400;
    return new Response(JSON.stringify({
      message: `Processed ${validated.users.length} user(s)`,
      summary: {
        created: createdUsers.length,
        existing: existingUsers.length,
        failed: failedUsers.length
      },
      created_users: createdUsers,
      existing_users: existingUsers,
      failed_users: failedUsers,
      trial_days: validated.trial_days,
      region: validated.region
    }), {
      status: statusCode,
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
    if (error?.name === "JWTExpired" || error?.name === "JWSSignatureVerificationFailed") {
      return new Response(JSON.stringify({
        error: "Invalid or expired token"
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
