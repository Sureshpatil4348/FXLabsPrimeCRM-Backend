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
 */ function createErrorResponse(
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
// Default trial days from environment (fallback 15)
const rawTrial = Deno.env.get("DEFAULT_TRIAL_DAYS");
const parsedTrial = Number.parseInt(rawTrial ?? "", 10);
const DEFAULT_TRIAL_DAYS =
    Number.isFinite(parsedTrial) && parsedTrial >= 1 ? parsedTrial : 15;
// Input validation schema
const createUserSchema = z.object({
    users: z
        .array(
            z.object({
                email: z.string().email("Invalid email format"),
            })
        )
        .min(1, "At least one user is required"),
    region: z.enum(["India", "International"], {
        errorMap: () => ({
            message: "Region must be 'India' or 'International'",
        }),
    }),
    trial_days: z
        .number()
        .int()
        .min(1, "trial_days must be a positive integer")
        .optional()
        .default(DEFAULT_TRIAL_DAYS),
});
serve(async (req) => {
    if (req.method !== "POST") {
        return createErrorResponse("Method not allowed", 405);
    }
    try {
        // Validate Admin-Token or Partner-Token
        const adminToken = req.headers.get("Admin-Token");
        const partnerToken = req.headers.get("Partner-Token");
        if (!adminToken && !partnerToken) {
            return createErrorResponse(
                "Admin-Token or Partner-Token header required",
                401
            );
        }
        const token = adminToken || partnerToken;
        let secret;
        try {
            secret = getJWTSecret();
        } catch (error) {
            return createJWTSecretErrorResponse();
        }
        const { payload } = await jwtVerify(token, secret, {
            algorithms: ["HS256"],
            issuer: Deno.env.get("JWT_ISSUER") ?? undefined,
            audience: Deno.env.get("JWT_AUDIENCE") ?? undefined,
        });
        if (payload.role !== "admin" && payload.role !== "partner") {
            return createErrorResponse("Admin or Partner access required", 403);
        }
        const partnerId = payload.role === "partner" ? payload.sub : null;
        // Parse and validate request body
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
        const validated = createUserSchema.parse(body);
        const createdUsers = [];
        const existingUsers = [];
        const failedUsers = [];
        // Calculate subscription end date
        const subscriptionEndsAt = new Date(
            Date.now() + validated.trial_days * 24 * 60 * 60 * 1000
        ).toISOString();
        for (const userInput of validated.users) {
            const { email } = userInput;
            const normalizedEmail = email.trim().toLowerCase();
            try {
                // Check if email already exists in crm_user_metadata
                const { data: existingMeta, error: metaCheckError } =
                    await supabase
                        .from("crm_user_metadata")
                        .select("email, user_id")
                        .eq("email", normalizedEmail)
                        .maybeSingle();
                if (existingMeta) {
                    console.log(`Email already exists`);
                    existingUsers.push({
                        email,
                        reason: "User already exists",
                    });
                    continue;
                }
                // Create user in auth.users
                console.log(`Creating auth user`);
                const { data: authUser, error: authError } =
                    await supabase.auth.admin.createUser({
                        email,
                        email_confirm: true,
                    });
                if (authError || !authUser?.user) {
                    console.error(
                        `Auth create error:`,
                        authError?.message || "No user returned"
                    );
                    failedUsers.push({
                        email,
                        reason: authError?.message || "User creation failed",
                    });
                    continue;
                }
                console.log(
                    `Auth user created`
                );
                // Insert into crm_user_metadata
                const { data: metaData, error: metaError } = await supabase
                    .from("crm_user_metadata")
                    .insert({
                        user_id: authUser.user.id,
                        email: normalizedEmail,
                        region: validated.region,
                        crm_partner_id: partnerId,
                        subscription_status: "added",
                        subscription_ends_at: subscriptionEndsAt,
                        created_at: new Date().toISOString(),
                        updated_at: new Date().toISOString(),
                    })
                    .select("email")
                    .single();
                if (metaError) {
                    console.error(
                        `Metadata insert error:`,
                        metaError.message
                    );
                    await supabase.auth.admin.deleteUser(authUser.user.id);
                    failedUsers.push({
                        email,
                        reason: metaError.message,
                    });
                    continue;
                }
                createdUsers.push({
                    email: metaData.email,
                });
            } catch (userError) {
                console.error(`Error processing user`, userError);
                failedUsers.push({
                    email,
                    reason:
                        userError instanceof Error
                            ? userError.message
                            : "Unknown error",
                });
            }
        }
        const statusCode =
            createdUsers.length > 0
                ? 201
                : existingUsers.length > 0
                ? 200
                : 400;
        return new Response(
            JSON.stringify({
                message: `Processed ${validated.users.length} user(s)`,
                summary: {
                    created: createdUsers.length,
                    existing: existingUsers.length,
                    failed: failedUsers.length,
                },
                created_users: createdUsers,
                existing_users: existingUsers,
                failed_users: failedUsers,
                trial_days: validated.trial_days,
                region: validated.region,
            }),
            {
                status: statusCode,
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
            return createErrorResponse("Invalid or expired token", 401);
        }
        if (error?.code === "ERR_JWS_INVALID") {
            return createErrorResponse("Invalid JWT format", 400);
        }
        console.error("Unexpected error:", error);
        return createErrorResponse("Internal server error", 500);
    }
});
