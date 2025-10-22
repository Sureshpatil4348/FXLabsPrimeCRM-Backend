import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.22.4";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import {
    genSaltSync,
    hashSync,
} from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";
// Utility: Get JWT secret
function getJWTSecret() {
    const secret = Deno.env.get("CUSTOM_JWT_SECRET");
    if (!secret) {
        throw new Error("CUSTOM_JWT_SECRET environment variable is not set");
    }
    return new TextEncoder().encode(secret);
}
// Utility: JWT Secret error
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
// Utility: Standard error response
function createErrorResponse(
    message: string,
    status: number = 500,
    code: string | null = null,
    details: any[] = []
) {
    const errorResponse: any = {
        error: message,
    };
    if (code) {
        errorResponse.code = code;
    }
    if (details.length > 0) {
        errorResponse.details = details;
    }
    return new Response(JSON.stringify(errorResponse), {
        status,
        headers: {
            "Content-Type": "application/json",
        },
    });
}
// Utility: Zod validation errors
function createValidationErrorResponse(zodError, status = 400) {
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
// Initialize Supabase client
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error("Supabase env vars not set");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
// Input validation schema
const createPartnerSchema = z.object({
    full_name: z.string().min(1, "Full name is required"),
    email: z.string().email("Invalid email format"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    commission_percent: z
        .number()
        .int()
        .min(0, "Commission must be ≥ 0")
        .max(50, "Commission must be ≤ 50")
        .optional()
        .default(10),
});
serve(async (req) => {
    if (req.method !== "POST") {
        return createErrorResponse("Method not allowed", 405);
    }
    try {
        // === 1. Validate Admin-Token ===
        const adminToken =
            req.headers.get("Admin-Token") ??
            req.headers.get("Authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
        if (!adminToken) {
            return createErrorResponse("Admin-Token header required", 401);
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
            return createErrorResponse("Admin access required", 403);
        }
        // === 2. Parse and validate request body ===
        let body;
        try {
            body = await req.json();
        } catch {
            return createErrorResponse(
                "Invalid JSON in request body",
                400,
                "INVALID_JSON"
            );
        }
        const validated = createPartnerSchema.parse(body);
        // === 3. Check if partner email already exists ===
        const normalizedEmail = validated.email.trim().toLowerCase();
        const { data: existing } = await supabase
            .from("crm_partner")
            .select("id")
            .eq("email", normalizedEmail)
            .maybeSingle();
        if (existing) {
            return createErrorResponse(
                "Partner with this email already exists",
                409
            );
        }
        // === 4. Hash password and insert ===
        const cost =
            Number.parseInt(Deno.env.get("BCRYPT_COST") ?? "12", 10) || 12;
        const salt = genSaltSync(cost);
        const passwordHash = hashSync(validated.password, salt);
        const { data: inserted, error: insertError } = await supabase
            .from("crm_partner")
            .insert({
                email: normalizedEmail,
                full_name: validated.full_name,
                password_hash: passwordHash,
                commission_percent: validated.commission_percent,
                is_active: true,
            })
            .select("email, full_name")
            .single();
        if (insertError) {
            if (insertError.code === "23505") {
                return createErrorResponse(
                    "Partner with this email already exists",
                    409
                );
            }
            console.error("Insert error:", insertError);
            return createErrorResponse("Failed to create partner", 500);
        }
        // === 5. Success ===
        return new Response(
            JSON.stringify({
                message: `Partner ${inserted.full_name} with Email - ${inserted.email} has been created successfully`,
            }),
            {
                status: 201,
                headers: {
                    "Content-Type": "application/json",
                },
            }
        );
    } catch (error) {
        if (error instanceof z.ZodError) {
            return createValidationErrorResponse(error);
        }
        if (
            error?.name === "JWTExpired" ||
            error?.name === "JWSSignatureVerificationFailed"
        ) {
            return createErrorResponse("Invalid or expired Admin-Token", 401);
        }
        console.error("Unexpected error:", error);
        return createErrorResponse("Internal server error", 500);
    }
});
