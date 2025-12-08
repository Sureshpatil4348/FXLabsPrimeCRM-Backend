import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Initialize Supabase Client
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// === CONFIGURATION: Allowed Origins ===
const allowedOrigins = [
  "http://localhost:3000",
  "https://fxlabs-dev.netlify.app",
  "https://fxlabsprime.com",
  "http://localhost:3001"
];

serve(async (req) => {
  // === DYNAMIC CORS LOGIC ===
  const origin = req.headers.get("origin");
  const isAllowed = origin && allowedOrigins.includes(origin);
  const corsHeaders = {
    'Access-Control-Allow-Origin': isAllowed ? origin : 'http://localhost:3000',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-user-token',
  };

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // =========================================================
    // 1. AUTHENTICATION
    // =========================================================
    const userTokenHeader = req.headers.get('X-User-Token');
    if (!userTokenHeader) {
      throw new Error("Missing 'X-User-Token' header.");
    }

    const token = userTokenHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    
    if (authError || !user) {
      throw new Error("Unauthorized: Invalid User Token");
    }

    console.log(`👤 Processing cancellation for User ID: ${user.id}`);

    // =========================================================
    // 2. FETCH CUSTOMER ID
    // =========================================================
    const { data: metadata, error: metadataError } = await supabase
      .from("crm_user_metadata")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .single();

    if (metadataError || !metadata || !metadata.stripe_customer_id) {
      throw new Error("Stripe customer ID not found for this user.");
    }

    const customerId = metadata.stripe_customer_id;

    // =========================================================
    // 3. STRIPE API HELPER (Native Fetch)
    // =========================================================
    const stripeLiveKey = Deno.env.get("STRIPE_SECRET_KEY_LIVE");
    const stripeTestKey = Deno.env.get("STRIPE_SECRET_KEY_TEST");

    const callStripeAPI = async (endpoint: string, method: string, apiKey: string) => {
      const response = await fetch(`https://api.stripe.com/v1${endpoint}`, {
        method,
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      });
      const data = await response.json();
      return { ok: response.ok, status: response.status, data };
    };

    /**
     * Helper: Analyzes subscriptions to find actionable states.
     * Returns an object separating "Truly Active" from "Already Cancelled".
     */
    const analyzeSubscriptionStatus = async (apiKey: string, cid: string) => {
      // Get all subscriptions (active, canceled, trialing, etc.)
      const params = new URLSearchParams({
        customer: cid,
        status: 'all', 
        limit: '10'
      });
      
      const { ok, data } = await callStripeAPI(`/subscriptions?${params.toString()}`, 'GET', apiKey);

      if (!ok) return { error: data.error, active: null, alreadyCancelled: null };

      const subs = data.data || [];

      // 1. Find a subscription that is Active/Trialing AND NOT scheduled to cancel
      const trulyActive = subs.find((sub: any) => 
        ['active', 'trialing'].includes(sub.status) && !sub.cancel_at_period_end
      );

      // 2. Find a subscription that is "Already Cancelled"
      // This includes: Status is 'canceled' OR (Status is active BUT cancel_at_period_end is true)
      const alreadyCancelled = subs.find((sub: any) => 
        sub.status === 'canceled' || 
        ( ['active', 'trialing'].includes(sub.status) && sub.cancel_at_period_end === true )
      );

      return { error: null, active: trulyActive || null, alreadyCancelled: alreadyCancelled || null };
    };

    // =========================================================
    // 4. FIND TARGET SUBSCRIPTION (Priority: Live -> Test)
    // =========================================================
    
    let targetSub = null;
    let targetKey = null;
    let mode = 'unknown';
    
    // Variables to store "Already Cancelled" evidence if we don't find an active one
    let evidenceOfCancellation = null; 

    // --- CHECK 1: LIVE MODE ---
    if (stripeLiveKey) {
      const { error, active, alreadyCancelled } = await analyzeSubscriptionStatus(stripeLiveKey, customerId);
      
      if (active) {
        targetSub = active;
        targetKey = stripeLiveKey;
        mode = 'live';
      } else if (alreadyCancelled) {
        // We store this. If we don't find an active one in Test mode later, we use this to return the message.
        evidenceOfCancellation = { sub: alreadyCancelled, mode: 'live' };
      }
      
      // Error handling: If customer doesn't exist in Live, we just continue. 
      // If it's a diff error, we log it.
      if (error && (!error.message || !error.message.includes("No such customer"))) {
        console.error("⚠️ Error checking Live:", error.message);
      }
    }

    // --- CHECK 2: TEST MODE (Only if no Active found in Live) ---
    if (!targetSub && stripeTestKey) {
      const { error, active, alreadyCancelled } = await analyzeSubscriptionStatus(stripeTestKey, customerId);

      if (active) {
        targetSub = active;
        targetKey = stripeTestKey;
        mode = 'test';
      } else if (alreadyCancelled && !evidenceOfCancellation) {
        // Only set this if we didn't already find cancellation evidence in Live
        evidenceOfCancellation = { sub: alreadyCancelled, mode: 'test' };
      }
    }

    // =========================================================
    // 5. DECISION: CANCEL OR RETURN MESSAGE?
    // =========================================================

    // CASE A: No Active found, but we found evidence it was already cancelled
    if (!targetSub && evidenceOfCancellation) {
      const sub = evidenceOfCancellation.sub;
      let msg = "User subscription is already cancelled.";
      
      // Make message extensive/specific based on state
      if (sub.status === 'canceled') {
        msg = `Subscription is already fully cancelled (Status: ${sub.status}).`;
      } else if (sub.cancel_at_period_end) {
        const date = new Date(sub.current_period_end * 1000).toLocaleDateString();
        msg = `Subscription is already scheduled to be cancelled. It will remain active until ${date}.`;
      }

      console.log(`ℹ️ Returning 'Already Cancelled': ${msg}`);
      
      return new Response(
        JSON.stringify({
          success: true,
          message: msg,
          is_already_cancelled: true,
          details: {
            status: sub.status,
            cancel_at_period_end: sub.cancel_at_period_end
          }
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    // CASE B: Nothing found at all
    if (!targetSub && !evidenceOfCancellation) {
      return new Response(
        JSON.stringify({
          success: false,
          error: "No subscription history found for this user."
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 404 }
      );
    }

    // CASE C: Active Subscription Found -> EXECUTE CANCELLATION
    if (targetSub && targetKey) {
      console.log(`🗑️ Cancelling subscription: ${targetSub.id} (${mode})`);

      const { ok, data: cancelledSub } = await callStripeAPI(
        `/subscriptions/${targetSub.id}`,
        'DELETE',
        targetKey
      );

      if (!ok) {
        throw new Error(cancelledSub.error?.message || "Failed to cancel subscription via API");
      }

      // Update Database
      await supabase
        .from("crm_user_metadata")
        .update({ subscription_status: 'cancelled' })
        .eq("user_id", user.id);

      return new Response(
        JSON.stringify({
          success: true,
          message: "Stripe subscription cancelled successfully",
          mode: mode,
          subscription_id: cancelledSub.id,
          status: cancelledSub.status,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 }
      );
    }

    throw new Error("Unexpected state.");

  } catch (err) {
    console.error("❌ Execution Error:", err);
    return new Response(
      JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 400 }
    );
  }
});