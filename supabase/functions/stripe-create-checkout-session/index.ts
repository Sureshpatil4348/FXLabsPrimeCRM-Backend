/*
  TEST MODE:
  STRIPE_SECRET_KEY_TEST            → sk_test_...
  STRIPE_PRICE_TEST_3M              → price_1Test3M...
  STRIPE_PRICE_TEST_1Y              → price_1Test1Y...
  
  LIVE MODE:
  STRIPE_SECRET_KEY_LIVE            → sk_live_...
  STRIPE_PRICE_INTERNATIONAL_3M     → price_1Intl3M...
  STRIPE_PRICE_INTERNATIONAL_1Y     → price_1Intl1Y...
*/

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { z } from "https://esm.sh/zod@3.22.4";
import Stripe from "https://esm.sh/stripe@14.11.0?target=deno";

// Allowed origins list
const allowedOrigins = [
  "https://fxlabs-qa.netlify.app",
  "https://fxlabs-dev.netlify.app",
  "https://fxlabsprime.com",
  "http://localhost:3000",
  "http://localhost:3001"
];

// Base CORS headers (without origin)
const baseCorsHeaders = {
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Max-Age": "86400",
  "Access-Control-Allow-Credentials": "true"
};

// Plan configuration mapping
const PLAN_CONFIG = {
  test_3m: {
    priceId: Deno.env.get("STRIPE_PRICE_TEST_3M"),
    secretKey: Deno.env.get("STRIPE_SECRET_KEY_TEST"),
    name: "Test 3 Month Plan",
    currency: "usd",
    mode: "test"
  },
  test_1y: {
    priceId: Deno.env.get("STRIPE_PRICE_TEST_1Y"),
    secretKey: Deno.env.get("STRIPE_SECRET_KEY_TEST"),
    name: "Test 1 Year Plan",
    currency: "usd",
    mode: "test"
  },
  international_3m: {
    priceId: Deno.env.get("STRIPE_PRICE_INTERNATIONAL_3M"),
    secretKey: Deno.env.get("STRIPE_SECRET_KEY_LIVE"),
    name: "International 3 Month Plan",
    currency: "usd",
    mode: "live"
  },
  international_1y: {
    priceId: Deno.env.get("STRIPE_PRICE_INTERNATIONAL_1Y"),
    secretKey: Deno.env.get("STRIPE_SECRET_KEY_LIVE"),
    name: "International 1 Year Plan",
    currency: "usd",
    mode: "live"
  }
};

// Utility: Get CORS headers with dynamic origin
function getCorsHeaders(req) {
  const origin = req.headers.get("Origin");
  const isAllowedOrigin = origin && allowedOrigins.includes(origin);
  return {
    ...baseCorsHeaders,
    ...(isAllowedOrigin && {
      "Access-Control-Allow-Origin": origin
    })
  };
}

// Utility: Standard error response
function createErrorResponse(
  message,
  status = 500,
  code = null,
  details = [],
  corsHeaders
) {
  const errorResponse = { error: message };
  if (code) errorResponse.code = code;
  if (details.length > 0) errorResponse.details = details;

  return new Response(JSON.stringify(errorResponse), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders
    }
  });
}

// Utility: Zod validation errors
function createValidationErrorResponse(zodError, corsHeaders, status = 400) {
  const details = zodError.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message
  }));
  return createErrorResponse(
    "Validation error",
    status,
    "VALIDATION_ERROR",
    details,
    corsHeaders
  );
}

// Define schema
const checkoutSchema = z.object({
  planId: z.enum(
    ["test_3m", "test_1y", "international_3m", "international_1y"],
    {
      errorMap: () => ({
        message:
          "Invalid plan ID. Must be one of: test_3m, test_1y, international_3m, international_1y"
      })
    }
  ),
  successUrl: z.string().url("Valid success URL is required").optional(),
  cancelUrl: z.string().url("Valid cancel URL is required").optional(),
  customerEmail: z.string().email("Invalid email format").optional(),
  metadata: z.record(z.string()).optional()
});

serve(async (req) => {
  // Get dynamic CORS headers based on request origin
  const corsHeaders = getCorsHeaders(req);

  // Handle preflight (OPTIONS) request
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders
    });
  }

  if (req.method !== "POST") {
    return createErrorResponse(
      "Method not allowed",
      405,
      "METHOD_NOT_ALLOWED",
      [],
      corsHeaders
    );
  }

  try {
    // Parse and validate request body
    let body;
    try {
      body = await req.json();
    } catch {
      return createErrorResponse(
        "Invalid JSON in request body",
        400,
        "INVALID_JSON",
        [],
        corsHeaders
      );
    }

    const validated = checkoutSchema.parse(body);

    // Get plan configuration
    const planConfig = PLAN_CONFIG[validated.planId];
    
    // Validate Stripe API key for this plan
    if (!planConfig.secretKey) {
      console.error(`Stripe secret key not configured for plan: ${validated.planId} (mode: ${planConfig.mode})`);
      return createErrorResponse(
        "Payment service configuration error",
        500,
        "STRIPE_CONFIG_ERROR",
        [],
        corsHeaders
      );
    }
    
    if (!planConfig.priceId) {
      console.error(`Price ID not configured for plan: ${validated.planId}`);
      return createErrorResponse(
        "Plan configuration error",
        500,
        "PLAN_CONFIG_ERROR",
        [],
        corsHeaders
      );
    }

    // Initialize Stripe with the appropriate key for this plan
    const stripe = new Stripe(planConfig.secretKey, {
      apiVersion: "2023-10-16",
      httpClient: Stripe.createFetchHttpClient()
    });

    // Determine success and cancel URLs
    const origin = req.headers.get("Origin") || allowedOrigins[0];
    const successUrl =
      validated.successUrl ||
      `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl = validated.cancelUrl || `${origin}/checkout/cancel`;

    // Create checkout session
    const sessionParams = {
      mode: "subscription",
      line_items: [
        {
          price: planConfig.priceId,
          quantity: 1
        }
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      allow_promotion_codes: true,
      billing_address_collection: "required",
      payment_method_types: ["card"],
      metadata: {
        planId: validated.planId,
        planName: planConfig.name,
        ...(validated.metadata || {})
      }
    };

    // Add customer email if provided
    if (validated.customerEmail) {
      sessionParams.customer_email = validated.customerEmail;
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    if (!session.url) {
      throw new Error("Stripe session created but no URL returned");
    }

    return new Response(
      JSON.stringify({
        sessionId: session.id,
        sessionUrl: session.url
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders
        }
      }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return createValidationErrorResponse(error, corsHeaders);
    }

    // Handle Stripe-specific errors
    if (error instanceof Stripe.errors.StripeError) {
      console.error("Stripe error:", error.type, error.message);
      return createErrorResponse(
        "Payment service error",
        400,
        "STRIPE_ERROR",
        [
          {
            message: error.message,
            type: error.type
          }
        ],
        corsHeaders
      );
    }

    console.error("Checkout session error:", error);
    return createErrorResponse(
      "Internal server error",
      500,
      "INTERNAL_ERROR",
      [],
      corsHeaders
    );
  }
});