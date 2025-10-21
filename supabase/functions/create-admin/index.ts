import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.22.4";
import { jwtVerify } from "https://esm.sh/jose@4.14.4";
import {
    genSaltSync,
    hashSync,
    compareSync,
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
function createErrorResponse(message, status = 500, code = null, details = []) {
    const errorResponse = {
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
const supabase = createClient(
    Deno.env.get("SUPABASE_URL"),
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
);
// Input validation schema
const createAdminSchema = z.object({
    full_name: z.string().min(1, "Full name is required"),
    email: z.string().email("Invalid email format"),
    password: z.string().min(8, "Password must be at least 8 characters"),
    current_admin_password: z
        .string()
        .min(1, "Current admin password is required"),
});
serve(async (req) => {
    if (req.method !== "POST") {
        return createErrorResponse("Method not allowed", 405);
    }
    try {
        // === 1. Validate Admin-Token ===
        const adminToken = req.headers.get("Admin-Token");
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
        });
        if (payload.role !== "admin") {
            return createErrorResponse("Admin access required", 403);
        }
        // Get current admin's ID from JWT payload
        const currentAdminId = payload.sub;
        if (!currentAdminId) {
            return createErrorResponse(
                "Invalid admin token: user ID not found",
                401
            );
        }
        // === 2. Parse and validate request body ===
        const body = await req.json();
        const validated = createAdminSchema.parse(body);
        // === 3. Fetch and verify current admin's password ===
        const { data: currentAdmin, error: fetchError } = await supabase
            .from("crm_admin")
            .select("id, password_hash")
            .eq("id", currentAdminId)
            .single();
        if (fetchError || !currentAdmin) {
            return createErrorResponse("Current admin not found", 404);
        }
        // Verify the current admin's password
        const isPasswordValid = compareSync(
            validated.current_admin_password,
            currentAdmin.password_hash
        );
        if (!isPasswordValid) {
            return createErrorResponse(
                "Current admin password is incorrect",
                403
            );
        }
        // === 4. Check if new admin email already exists ===
        const { data: existing, error: checkError } = await supabase
            .from("crm_admin")
            .select("id")
            .eq("email", validated.email)
            .single();
        if (!checkError && existing) {
            return createErrorResponse(
                "Admin with this email already exists",
                409
            );
        }
        // === 5. Hash password and insert ===
        const salt = genSaltSync(12);
        const passwordHash = hashSync(validated.password, salt);
        const { data: inserted, error: insertError } = await supabase
            .from("crm_admin")
            .insert({
                email: validated.email,
                full_name: validated.full_name,
                password_hash: passwordHash,
            })
            .select("email, full_name")
            .single();
        if (insertError) {
            console.error("Insert error:", insertError);
            return createErrorResponse("Failed to create admin", 500);
        }
        // === 6. Success ===
        return new Response(
            JSON.stringify({
                message: `Admin ${inserted.full_name} with Email - ${inserted.email} has been created successfully`,
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
