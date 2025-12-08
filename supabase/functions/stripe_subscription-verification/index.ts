import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.22.4";

// Allowed origins list
const allowedOrigins = [
    "https://fxlabsprime-crm-qa.netlify.app",
    "https://fxlabsprime-crm-dev.netlify.app",
    "https://crm.fxlabsprime.com",
    "http://localhost:3000",
    "http://localhost:3001",
];

// Base CORS headers (without origin)
const baseCorsHeaders = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
        "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    "Access-Control-Allow-Credentials": "true",
};

// Rate limit: 10 per hour per IP
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW = 3600 * 1000; // 1 hour in ms
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

// Utility: Get CORS headers with dynamic origin
function getCorsHeaders(req: Request) {
    const origin = req.headers.get("Origin");
    const isAllowedOrigin = origin && allowedOrigins.includes(origin);
    return {
        ...baseCorsHeaders,
        ...(isAllowedOrigin && {
            "Access-Control-Allow-Origin": origin,
        }),
    };
}

// Utility: Get client IP
function getClientIP(req: Request): string {
    return (
        req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
        req.headers.get("cf-connecting-ip") ||
        "unknown"
    );
}

// Utility: Check rate limit
function checkRateLimit(clientIP: string): {
    allowed: boolean;
    retryAfter?: number;
} {
    const now = Date.now();
    const limitData = rateLimitStore.get(clientIP);

    if (!limitData || now > limitData.resetTime) {
        rateLimitStore.set(clientIP, {
            count: 1,
            resetTime: now + RATE_LIMIT_WINDOW,
        });
        return { allowed: true };
    }

    if (limitData.count >= RATE_LIMIT_MAX) {
        const retryAfter = Math.ceil((limitData.resetTime - now) / 1000);
        return { allowed: false, retryAfter };
    }

    limitData.count++;
    return { allowed: true };
}

// Utility: Standard error response
function createErrorResponse(
    message: string,
    status = 500,
    code: string | null = null,
    details: unknown[] = [],
    corsHeaders: Record<string, string>,
    retryAfter?: number
) {
    const errorResponse: Record<string, unknown> = {
        error: message,
    };
    if (code) errorResponse.code = code;
    if (details.length > 0) errorResponse.details = details;

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...corsHeaders,
    };

    if (retryAfter) {
        headers["Retry-After"] = retryAfter.toString();
    }

    return new Response(JSON.stringify(errorResponse), {
        status,
        headers,
    });
}

// Utility: Zod validation errors
function createValidationErrorResponse(
    zodError: z.ZodError,
    corsHeaders: Record<string, string>,
    status = 400
) {
    const details = zodError.issues.map((issue) => ({
        field: issue.path.join("."),
        message: issue.message,
    }));
    return createErrorResponse(
        "Validation error",
        status,
        "VALIDATION_ERROR",
        details,
        corsHeaders
    );
}

// Initialize Supabase client
const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

// Define schema
const subscriptionCheckSchema = z.object({
    email: z.string().email("Invalid email format"),
});

serve(async (req: Request) => {
    // Get dynamic CORS headers based on request origin
    const corsHeaders = getCorsHeaders(req);

    // Handle preflight (OPTIONS) request
    if (req.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: corsHeaders,
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
        // Check rate limit
        const clientIP = getClientIP(req);
        const rateLimitCheck = checkRateLimit(clientIP);

        if (!rateLimitCheck.allowed) {
            return createErrorResponse(
                "Rate limit exceeded: 10 requests per hour",
                429,
                "RATE_LIMIT_EXCEEDED",
                [],
                corsHeaders,
                rateLimitCheck.retryAfter
            );
        }

        // Parse request body
        let body: unknown;
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

        // Validate input
        const validated = subscriptionCheckSchema.parse(body);

        // Query user metadata
        const { data: userMetadata, error } = await supabase
            .from("crm_user_metadata")
            .select("id, subscription_status, subscription_ends_at, is_blocked")
            .eq("email", validated.email)
            .single();

        if (error) {
            if (error.code === "PGRST116") {
                // No rows found
                return createErrorResponse(
                    "User not found",
                    404,
                    "USER_NOT_FOUND",
                    [],
                    corsHeaders
                );
            }
            console.error("Database error:", error);
            return createErrorResponse(
                "Internal server error",
                500,
                null,
                [],
                corsHeaders
            );
        }

        if (!userMetadata) {
            return createErrorResponse(
                "User not found",
                404,
                "USER_NOT_FOUND",
                [],
                corsHeaders
            );
        }

        // Check if user is blocked
        if (userMetadata.is_blocked) {
            return createErrorResponse(
                "User account is blocked",
                403,
                "ACCOUNT_BLOCKED",
                [],
                corsHeaders
            );
        }

        // Determine if subscription has ended
        const now = new Date();
        const subscriptionEndsAt = userMetadata.subscription_ends_at
            ? new Date(userMetadata.subscription_ends_at)
            : null;
        const hasEnded = subscriptionEndsAt ? now > subscriptionEndsAt : false;

        const response = {
            email: validated.email,
            subscription_status: userMetadata.subscription_status,
        };

        return new Response(JSON.stringify(response), {
            status: 200,
            headers: {
                "Content-Type": "application/json",
                ...corsHeaders,
            },
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return createValidationErrorResponse(error, corsHeaders);
        }

        console.error("Subscription check error:", error);
        return createErrorResponse(
            "Internal server error",
            500,
            null,
            [],
            corsHeaders
        );
    }
});
