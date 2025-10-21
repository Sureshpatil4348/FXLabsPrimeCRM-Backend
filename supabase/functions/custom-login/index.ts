import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.22.4";
import { SignJWT } from "https://esm.sh/jose@4.14.4";
import { compareSync } from "https://deno.land/x/bcrypt@v0.4.1/mod.ts";
// Utility: Get JWT secret
function getJWTSecret() {
    const secret = Deno.env.get("CUSTOM_JWT_SECRET");
    if (!secret)
        throw new Error("CUSTOM_JWT_SECRET environment variable is not set");
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
function createErrorResponse(message, status = 500, code = null, details = []) {
    const errorResponse = {
        error: message,
    };
    if (code) errorResponse.code = code;
    if (details.length > 0) errorResponse.details = details;
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
const supabase = createClient(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
);
// Define schema
const loginSchema = z.object({
    email: z.string().email("Invalid email format"),
    password: z.string().min(1, "Password is required"),
    role: z.enum(["admin", "partner"], {
        errorMap: () => ({
            message: "Role must be 'admin' or 'partner'",
        }),
    }),
});
serve(async (req) => {
    if (req.method !== "POST") {
        return createErrorResponse("Method not allowed", 405);
    }
    try {
        const body = await req.json();
        const validated = loginSchema.parse(body);
        const tableName =
            validated.role === "admin" ? "crm_admin" : "crm_partner";
        const selectColumns =
            validated.role === "admin"
                ? "id, password_hash"
                : "id, password_hash, is_active";
        const { data: user, error } = await supabase
            .from(tableName)
            .select(selectColumns)
            .eq("email", validated.email)
            .single();
        if (error || !user) {
            return createErrorResponse("Email does not exist", 404);
        }
        // Check partner status
        if (validated.role === "partner" && !user.is_active) {
            return createErrorResponse("Account is inactive", 403);
        }
        // Verify password (bcrypt compare)
        const isValid = compareSync(validated.password, user.password_hash);
        if (!isValid) {
            return createErrorResponse("Incorrect password", 401);
        }
        // Generate JWT
        let secret;
        try {
            secret = getJWTSecret();
        } catch {
            return createJWTSecretErrorResponse();
        }
        const token = await new SignJWT({
            sub: user.id,
            role: validated.role,
            jti: crypto.randomUUID(),
        })
            .setProtectedHeader({
                alg: "HS256",
            })
            .setIssuedAt()
            .setExpirationTime("30d")
            .sign(secret);
        const tokenKey =
            validated.role === "admin" ? "Admin-Token" : "Partner-Token";
        return new Response(
            JSON.stringify({
                [tokenKey]: token,
            }),
            {
                status: 200,
                headers: {
                    "Content-Type": "application/json",
                },
            }
        );
    } catch (error) {
        if (error instanceof z.ZodError) {
            return createValidationErrorResponse(error);
        }
        console.error("Login error:", error);
        return createErrorResponse("Internal server error", 500);
    }
});
