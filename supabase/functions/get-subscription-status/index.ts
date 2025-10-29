import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Max-Age": "86400"
};
serve(async (req)=>{
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: corsHeaders
    });
  }
  try {
    // Get authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({
        subscription_status: "expired"
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // Extract token
    const token = authHeader.replace("Bearer ", "");
    // Create Supabase client with service role key
    const supabaseClient = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "");
    // Verify JWT and get user
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);
    if (authError || !user) {
      console.error("Auth verification failed:", authError);
      return new Response(JSON.stringify({
        subscription_status: "expired"
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // Use user.id from JWT (no request body needed)
    const userId = user.id;
    // Query crm_user_metadata for subscription info
    const { data: metadata, error: dbError } = await supabaseClient.from("crm_user_metadata").select("subscription_status, subscription_ends_at").eq("user_id", userId).single();
    if (dbError) {
      console.error("Database error:", dbError);
      return new Response(JSON.stringify({
        subscription_status: "expired"
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    if (!metadata) {
      // No metadata found - treat as expired
      return new Response(JSON.stringify({
        subscription_status: "expired"
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // Get current subscription status
    const { subscription_status, subscription_ends_at } = metadata;
    const now = new Date();
    // Step 1: If already "expired", return immediately
    if (subscription_status === "expired") {
      return new Response(JSON.stringify({
        subscription_status: "expired"
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // Step 2: Check if subscription has expired based on subscription_ends_at
    const subscriptionEndDate = new Date(subscription_ends_at);
    if (subscriptionEndDate < now) {
      // Subscription has expired - UPDATE the database with race condition prevention
      const { data: updateData, error: updateError } = await supabaseClient.from("crm_user_metadata").update({
        subscription_status: "expired",
        updated_at: now.toISOString()
      }).eq("user_id", userId).neq("subscription_status", "expired") // Only update if not already expired
      .select("subscription_status").single();
      if (updateError) {
        console.error("Error updating subscription status:", updateError);
      // Continue anyway - we'll still tell the frontend it's expired
      } else if (updateData) {
        console.log(`Updated subscription status to expired for user ${userId}`);
      }
      return new Response(JSON.stringify({
        subscription_status: "expired"
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
    // Subscription is still active - return "active" regardless of trial/paid status
    return new Response(JSON.stringify({
      subscription_status: "active"
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  } catch (error) {
    console.error("Function error:", error);
    return new Response(JSON.stringify({
      subscription_status: "expired"
    }), {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json"
      }
    });
  }
});
