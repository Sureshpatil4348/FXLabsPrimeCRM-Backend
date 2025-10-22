-- Note: Primary keys and UNIQUE constraints defined in 00001_initial_schema.sql
-- already create their backing indexes (e.g. *_pkey, *_email_key, *_user_id_key, *_stripe_payment_id_key).
-- Therefore, we do NOT recreate those here to avoid 42P07 relation exists errors.

-- Partner metrics indexes
CREATE INDEX IF NOT EXISTS crm_partner_total_converted_idx ON public.crm_partner USING btree (total_converted);
CREATE INDEX IF NOT EXISTS crm_partner_total_revenue_idx ON public.crm_partner USING btree (total_revenue);

-- Payments indexes
CREATE INDEX IF NOT EXISTS crm_payment_user_id_idx ON public.crm_payment USING btree (user_id);
CREATE INDEX IF NOT EXISTS crm_payment_paid_at_idx ON public.crm_payment USING btree (paid_at);
CREATE INDEX IF NOT EXISTS crm_payment_stripe_customer_id_idx ON public.crm_payment USING btree (stripe_customer_id);
CREATE INDEX IF NOT EXISTS crm_payment_user_paid_at_idx ON public.crm_payment USING btree (user_id, paid_at DESC);

-- User metadata single-column indexes
CREATE INDEX IF NOT EXISTS crm_user_metadata_crm_partner_id_idx ON public.crm_user_metadata USING btree (crm_partner_id);
CREATE INDEX IF NOT EXISTS crm_user_metadata_email_idx ON public.crm_user_metadata USING btree (email);
CREATE INDEX IF NOT EXISTS crm_user_metadata_subscription_ends_at_idx ON public.crm_user_metadata USING btree (subscription_ends_at);
CREATE INDEX IF NOT EXISTS crm_user_metadata_subscription_status_idx ON public.crm_user_metadata USING btree (subscription_status);
CREATE INDEX IF NOT EXISTS crm_user_metadata_converted_at_idx ON public.crm_user_metadata USING btree (converted_at) WHERE converted_at IS NOT NULL;

-- User metadata composite indexes based on common query patterns
CREATE INDEX IF NOT EXISTS crm_user_metadata_partner_status_idx ON public.crm_user_metadata USING btree (crm_partner_id, subscription_status);
CREATE INDEX IF NOT EXISTS crm_user_metadata_status_expires_idx ON public.crm_user_metadata USING btree (subscription_status, subscription_ends_at) WHERE subscription_ends_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_user_metadata_status_region_idx ON public.crm_user_metadata USING btree (subscription_status, region);
CREATE INDEX IF NOT EXISTS crm_user_metadata_partner_converted_idx ON public.crm_user_metadata USING btree (crm_partner_id, converted_at) WHERE converted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS crm_user_metadata_status_created_idx ON public.crm_user_metadata USING btree (subscription_status, created_at);

-- Note: For production deployments with large tables, consider using CREATE INDEX CONCURRENTLY
-- in a separate migration to avoid table locks. Example:
-- CREATE INDEX CONCURRENTLY IF NOT EXISTS crm_payment_user_paid_at_idx ON public.crm_payment USING btree (user_id, paid_at DESC);
-- This requires running outside of a transaction block.
