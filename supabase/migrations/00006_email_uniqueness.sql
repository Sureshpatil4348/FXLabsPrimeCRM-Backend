-- Migration: Add Case-Insensitive Email Uniqueness
-- This migration addresses email uniqueness issues by implementing case-insensitive constraints
-- to prevent duplicate emails like "A@x.com" vs "a@x.com"

-- Enable citext extension for case-insensitive text handling
CREATE EXTENSION IF NOT EXISTS citext;

-- Convert email columns to citext for automatic case-insensitive uniqueness
-- This approach is cleaner than manual lower() indexes but requires citext extension

-- Update crm_admin email column to citext
ALTER TABLE public.crm_admin
ALTER COLUMN email TYPE citext;

-- Update crm_partner email column to citext
ALTER TABLE public.crm_partner
ALTER COLUMN email TYPE citext;

-- Update crm_user_metadata email column to citext and add uniqueness
-- Since crm_user_metadata represents actual users, emails should be unique here too
ALTER TABLE public.crm_user_metadata
ALTER COLUMN email TYPE citext;

-- Add unique constraint on crm_user_metadata.email (citext handles case-insensitivity)
-- This prevents duplicate user accounts with different email cases
-- Drop constraint if it exists first to make migration idempotent
ALTER TABLE public.crm_user_metadata
DROP CONSTRAINT IF EXISTS crm_user_metadata_email_key;
ALTER TABLE public.crm_user_metadata
ADD CONSTRAINT crm_user_metadata_email_key UNIQUE (email);

-- Alternative approach using functional indexes (if citext is not preferred):
-- DROP INDEX IF EXISTS crm_admin_email_ci_key;
-- DROP INDEX IF EXISTS crm_partner_email_ci_key;
-- DROP INDEX IF EXISTS crm_user_metadata_email_ci_key;
-- CREATE UNIQUE INDEX crm_admin_email_ci_key ON public.crm_admin (lower(email));
-- CREATE UNIQUE INDEX crm_partner_email_ci_key ON public.crm_partner (lower(email));
-- CREATE UNIQUE INDEX crm_user_metadata_email_ci_key ON public.crm_user_metadata (lower(email));

-- Note: citext approach chosen for simplicity and automatic handling of case-insensitivity
-- in all queries, not just uniqueness constraints.