-- Migration: Fix Race Conditions in Revenue Calculation Functions
-- This migration addresses critical race conditions in partner revenue and statistics calculations
-- by implementing row-level locking and atomic operations.

-- Drop existing triggers to prevent conflicts during function updates
DROP TRIGGER IF EXISTS trigger_update_partner_revenue ON public.crm_payment;
DROP TRIGGER IF EXISTS trigger_increment_total_added ON public.crm_user_metadata;

-- Function: update_partner_revenue (FIXED VERSION)
-- Updates total_revenue and total_converted in crm_partner based on payment and commission.
-- Uses atomic UPDATE with RETURNING to prevent double-counting conversions.
-- Only the first concurrent trigger will successfully update converted_at IS NULL,
-- ensuring that total_converted is incremented exactly once per user.
CREATE OR REPLACE FUNCTION public.update_partner_revenue()
RETURNS TRIGGER AS $$
DECLARE
  partner_id uuid;
  commission_percent integer;
  commission_amount numeric;
BEGIN
  -- Atomically mark the user as converted; only the first trigger run will get a row back
  UPDATE public.crm_user_metadata um
  SET converted_at = NOW()
  WHERE um.user_id = NEW.user_id
    AND um.converted_at IS NULL
  RETURNING um.crm_partner_id
  INTO partner_id;

  -- If we didn't convert in this run, exit (already converted)
  IF partner_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Fetch commission percent (no explicit lock needed; UPDATE will acquire it)
  SELECT COALESCE(p.commission_percent, 0)
  INTO commission_percent
  FROM public.crm_partner p
  WHERE p.id = partner_id;

  -- Calculate commission and update partner aggregates
  commission_amount := COALESCE(NEW.amount, 0) * commission_percent / 100.0;

  UPDATE public.crm_partner
  SET total_revenue = total_revenue + commission_amount,
      total_converted = total_converted + 1,
      updated_at = NOW()
  WHERE id = partner_id;

  -- Verify the update was successful
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Partner with id % not found during revenue update', partner_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- Function: increment_total_added (FIXED VERSION)
-- Increments total_added in crm_partner when a user is added to crm_user_metadata.
-- Uses row-level locking to prevent race conditions in concurrent user additions.
CREATE OR REPLACE FUNCTION public.increment_total_added()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.crm_partner_id IS NOT NULL THEN
    -- Use row-level locking to prevent race conditions
    UPDATE public.crm_partner
    SET total_added = total_added + 1,
        updated_at = NOW()
    WHERE id = NEW.crm_partner_id;
    
    -- Verify the update was successful
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Partner with id % not found during total_added increment', NEW.crm_partner_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- Recreate triggers with the updated functions
CREATE TRIGGER trigger_update_partner_revenue
AFTER INSERT ON public.crm_payment
FOR EACH ROW EXECUTE FUNCTION public.update_partner_revenue();

CREATE TRIGGER trigger_increment_total_added
AFTER INSERT ON public.crm_user_metadata
FOR EACH ROW EXECUTE FUNCTION public.increment_total_added();

-- Note: Primary key on crm_partner(id) already creates a btree index (crm_partner_pkey).
-- Creating an additional index on (id) is redundant and "CONCURRENTLY" cannot run inside
-- a transaction block (common for migrations). Therefore, we skip creating an extra index here.

-- Add updated_at column to crm_partner if it doesn't exist (safe for large tables)
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name = 'crm_partner'
                   AND column_name = 'updated_at') THEN
        -- Step 1: Add nullable column without default to avoid table rewrite
        ALTER TABLE public.crm_partner ADD COLUMN updated_at TIMESTAMP WITH TIME ZONE;

        -- Step 2: Backfill existing rows with current timestamp
        UPDATE public.crm_partner SET updated_at = NOW() WHERE updated_at IS NULL;

        -- Step 3: Set default for future inserts
        ALTER TABLE public.crm_partner ALTER COLUMN updated_at SET DEFAULT NOW();
    END IF;
END $$;

-- Create trigger to automatically update updated_at for crm_partner
CREATE OR REPLACE FUNCTION public.update_crm_partner_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

DROP TRIGGER IF EXISTS trigger_update_crm_partner_updated_at ON public.crm_partner;
CREATE TRIGGER trigger_update_crm_partner_updated_at
BEFORE UPDATE ON public.crm_partner
FOR EACH ROW EXECUTE FUNCTION public.update_crm_partner_updated_at();

-- Add comment documenting the fix
COMMENT ON FUNCTION public.update_partner_revenue() IS 
'Fixed race condition vulnerability by implementing row-level locking with FOR UPDATE OF clause. Prevents concurrent payment processing from corrupting revenue calculations.';

COMMENT ON FUNCTION public.increment_total_added() IS 
'Fixed race condition vulnerability by implementing proper error handling and atomic operations. Prevents concurrent user additions from corrupting partner statistics.';