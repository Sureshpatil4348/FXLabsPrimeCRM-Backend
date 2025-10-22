import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import { z } from "https://esm.sh/zod@3.22.4";
// JWT utilities
function getJWTSecret() {
    const secret = Deno.env.get("CUSTOM_JWT_SECRET");
    if (!secret) {
        throw new Error("CUSTOM_JWT_SECRET environment variable is not set");
    }
    return new TextEncoder().encode(secret);
}
function createJWTSecretErrorResponse() {
    return new Response(
        JSON.stringify({
            error: "JWT secret configuration error",
            code: "JWT_SECRET_ERROR",
        }),
        {
            status: 500,
            headers: {
                "Content-Type": "application/json",
            },
        }
    );
}
/**
 * Create a standardized error response
 */ function createErrorResponse(message, status = 500, code, details) {
    const errorResponse = {
        error: message,
    };
    if (code) {
        errorResponse.code = code;
    }
    if (details && details.length > 0) {
        errorResponse.details = details;
    }
    return new Response(JSON.stringify(errorResponse), {
        status,
        headers: {
            "Content-Type": "application/json",
        },
    });
}
/**
 * Create a validation error response from Zod errors
 */ function createValidationErrorResponse(zodError, status = 400) {
    const details = zodError.errors.map((error) => ({
        field: error.path.join("."),
        message: error.message,
    }));
    return createErrorResponse(
        "Validation error",
        status,
        "VALIDATION_ERROR",
        details
    );
}
const supabase = createClient(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
);
const DEFAULT_PAGE_SIZE = (() => {
    const n = parseInt(Deno.env.get("DEFAULT_PAGE_SIZE") ?? "");
    return Number.isFinite(n) && n > 0 ? n : 20;
})();
const MAX_PAGE_SIZE = (() => {
    const n = parseInt(Deno.env.get("MAX_PAGE_SIZE") ?? "");
    return Number.isFinite(n) && n > 0 ? n : 100;
})();
// Input validation schema for query parameters
const getPartnersQuerySchema = z.object({
    page: z
        .string()
        .optional()
        .transform((val) => {
            const parsed = parseInt(val || "1");
            return isNaN(parsed) || parsed < 1 ? 1 : parsed;
        }),
    page_size: z
        .string()
        .optional()
        .transform((val) => {
            const parsed = parseInt(val || `${DEFAULT_PAGE_SIZE}`);
            if (isNaN(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE;
            if (parsed > MAX_PAGE_SIZE) return MAX_PAGE_SIZE;
            return parsed;
        }),
    sort_by: z
        .enum(["revenue", "added", "converted", "created"])
        .optional()
        .default("created"),
});
serve(async (req) => {
    if (req.method !== "GET") {
        return createErrorResponse("Method not allowed", 405);
    }
    try {
        // === Auth ===
        const adminToken = req.headers.get("Admin-Token");
        if (!adminToken) {
            return createErrorResponse("Admin-Token required", 401);
        }
        let secret;
        try {
            secret = getJWTSecret();
        } catch (error) {
            return createJWTSecretErrorResponse();
        }
        const { payload } = await jwtVerify(adminToken, secret, {
            algorithms: ["HS256"],
            issuer: Deno.env.get("JWT_ISSUER") ?? undefined,
            audience: Deno.env.get("JWT_AUDIENCE") ?? undefined,
        });
        if (payload.role !== "admin") {
            return createErrorResponse("Admin only", 403);
        }
        // === Parse and validate query params ===
        const url = new URL(req.url);
        const queryParams = {
            page: url.searchParams.get("page") || undefined,
            page_size: url.searchParams.get("page_size") || undefined,
            sort_by: url.searchParams.get("sort_by") || undefined,
        };
        const validationResult = getPartnersQuerySchema.safeParse(queryParams);
        if (!validationResult.success) {
            return createErrorResponse(
                "Invalid query parameters",
                400,
                "VALIDATION_ERROR",
                validationResult.error.issues.map((issue) => ({
                    field: issue.path.join("."),
                    message: issue.message,
                }))
            );
        }
        const {
            page,
            page_size: pageSize,
            sort_by: sortBy,
        } = validationResult.data;
        const from = (page - 1) * pageSize;
        const to = from + pageSize - 1;
        // === Build query ===
        let query = supabase
            .from("crm_partner")
            .select(
                "id, email, full_name, commission_percent, total_revenue, total_added, total_converted, created_at"
            );
        // Apply sorting
        switch (sortBy) {
            case "revenue":
                query = query.order("total_revenue", {
                    ascending: false,
                });
                break;
            case "added":
                query = query.order("total_added", {
                    ascending: false,
                });
                break;
            case "converted":
                query = query.order("total_converted", {
                    ascending: false,
                });
                break;
            case "created":
            default:
                query = query.order("created_at", {
                    ascending: false,
                });
        }
        // === Get total count ===
        const { count, error: countErr } = await supabase
            .from("crm_partner")
            .select("*", {
                count: "exact",
                head: true,
            });
        if (countErr) throw countErr;
        // === Fetch data ===
        const { data: partners, error: dataErr } = await query.range(from, to);
        if (dataErr) throw dataErr;
        const total = count ?? 0;
        const totalPages = Math.ceil(total / pageSize);
        return new Response(
            JSON.stringify({
                partners: partners.map((p) => ({
                    partner_id: p.id,
                    email: p.email,
                    full_name: p.full_name,
                    commission_percent: p.commission_percent,
                    total_revenue: parseFloat(p.total_revenue),
                    total_added: p.total_added,
                    total_converted: p.total_converted,
                    created_at: p.created_at,
                })),
                pagination: {
                    page,
                    page_size: pageSize,
                    total,
                    total_pages: totalPages,
                    has_next: page < totalPages,
                    has_prev: page > 1,
                },
                filters: {
                    sort_by: sortBy,
                },
            }),
            {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                },
            }
        );
    } catch (error) {
        console.error("Error:", error);
        if (
            error?.name === "JWTExpired" ||
            error?.name === "JWSSignatureVerificationFailed"
        ) {
            return createErrorResponse("Invalid Admin-Token", 401);
        }
        return createErrorResponse("Internal error", 500);
    }
});
