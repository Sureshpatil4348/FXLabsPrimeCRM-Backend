CREATE UNIQUE INDEX crm_admin_email_key ON public.crm_admin USING btree (email)
CREATE UNIQUE INDEX crm_admin_pkey ON public.crm_admin USING btree (id)
CREATE UNIQUE INDEX crm_partner_email_key ON public.crm_partner USING btree (email)
CREATE UNIQUE INDEX crm_partner_pkey ON public.crm_partner USING btree (id)
CREATE INDEX crm_partner_total_converted_idx ON public.crm_partner USING btree (total_converted)
CREATE INDEX crm_partner_total_revenue_idx ON public.crm_partner USING btree (total_revenue)
CREATE UNIQUE INDEX crm_payment_pkey ON public.crm_payment USING btree (id)
CREATE UNIQUE INDEX crm_payment_stripe_payment_id_key ON public.crm_payment USING btree (stripe_payment_id)
CREATE INDEX crm_payment_user_id_idx ON public.crm_payment USING btree (user_id)
CREATE INDEX crm_user_metadata_crm_partner_id_idx ON public.crm_user_metadata USING btree (crm_partner_id)
CREATE UNIQUE INDEX crm_user_metadata_pkey ON public.crm_user_metadata USING btree (id)
CREATE INDEX crm_user_metadata_subscription_ends_at_idx ON public.crm_user_metadata USING btree (subscription_ends_at)
CREATE INDEX crm_user_metadata_subscription_status_idx ON public.crm_user_metadata USING btree (subscription_status)
CREATE INDEX crm_user_metadata_user_id_idx ON public.crm_user_metadata USING btree (user_id)
CREATE UNIQUE INDEX crm_user_metadata_user_id_key ON public.crm_user_metadata USING btree (user_id)
CREATE INDEX crm_payment_paid_at_idx ON public.crm_payment USING btree (paid_at);
CREATE INDEX crm_user_metadata_converted_at_idx ON public.crm_user_metadata USING btree (converted_at) WHERE converted_at IS NOT NULL;
CREATE INDEX crm_user_metadata_partner_status_idx ON public.crm_user_metadata USING btree (crm_partner_id, subscription_status);
CREATE INDEX crm_user_metadata_status_expires_idx ON public.crm_user_metadata USING btree (subscription_status, subscription_ends_at) WHERE subscription_ends_at IS NOT NULL;
