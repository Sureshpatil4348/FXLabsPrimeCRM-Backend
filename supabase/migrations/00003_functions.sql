-- Function: set_converted_at
-- Updates converted_at and subscription_status to 'active' in crm_user_metadata when a payment is recorded.
CREATE OR REPLACE FUNCTION public.set_converted_at()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.crm_user_metadata
  SET converted_at = NEW.paid_at,
      subscription_status = 'active',
      updated_at = NOW()
  WHERE user_id = NEW.user_id AND converted_at IS NULL;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- Trigger: trigger_set_converted_at
CREATE TRIGGER trigger_set_converted_at
AFTER INSERT ON public.crm_payment
FOR EACH ROW EXECUTE FUNCTION public.set_converted_at();


-------------------------------------------------------------------

-- Function: update_partner_revenue
-- Updates total_revenue and total_converted in crm_partner based on payment and commission.
-- Uses row-level locking to prevent race conditions in concurrent payment processing.
CREATE OR REPLACE FUNCTION public.update_partner_revenue()
RETURNS TRIGGER AS $$
DECLARE
  partner_id uuid;
  commission_percent integer;
  commission_amount numeric;
BEGIN
  -- Get crm_partner_id and commission_percent from crm_user_metadata and crm_partner
  -- Use FOR UPDATE to lock the partner row and prevent concurrent modifications
  SELECT um.crm_partner_id, p.commission_percent
  INTO partner_id, commission_percent
  FROM public.crm_user_metadata um
  JOIN public.crm_partner p ON um.crm_partner_id = p.id
  WHERE um.user_id = NEW.user_id AND um.converted_at IS NULL
  FOR UPDATE OF p;

  IF partner_id IS NOT NULL THEN
    -- Calculate commission amount once to avoid repeated calculations
    commission_amount := NEW.amount * commission_percent / 100.0;
    
    -- Perform atomic update with row-level locking
    -- The FOR UPDATE above ensures this row is locked for the duration of the transaction
    UPDATE public.crm_partner
    SET total_revenue = total_revenue + commission_amount,
        total_converted = total_converted + 1,
        updated_at = NOW()
    WHERE id = partner_id;
    
    -- Verify the update was successful
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Partner with id % not found during revenue update', partner_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- Trigger: trigger_update_partner_revenue
CREATE TRIGGER trigger_update_partner_revenue
AFTER INSERT ON public.crm_payment
FOR EACH ROW EXECUTE FUNCTION public.update_partner_revenue();

------------------------------------------------------------------------------------

-- Function: update_updated_at
-- Updates updated_at in crm_user_metadata on any row update.
CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- Trigger: trigger_update_updated_at
CREATE TRIGGER trigger_update_updated_at
BEFORE UPDATE ON public.crm_user_metadata
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

------------------------------------------------------------------------------------

-- Function: increment_total_added
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

-- Trigger: trigger_increment_total_added
CREATE TRIGGER trigger_increment_total_added
AFTER INSERT ON public.crm_user_metadata
FOR EACH ROW EXECUTE FUNCTION public.increment_total_added();


----------------------------------------------------------------------------

-- Function: prevent_invalid_status_transition
-- Prevents invalid subscription_status updates in crm_user_metadata.
CREATE OR REPLACE FUNCTION public.prevent_invalid_status_transition()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.subscription_status = 'expired' AND NEW.subscription_status = 'added' THEN
    RAISE EXCEPTION 'Cannot transition from expired to added';
  END IF;
  IF OLD.subscription_status = 'active' AND NEW.subscription_status = 'added' THEN
    RAISE EXCEPTION 'Cannot transition from active to added';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- Trigger: trigger_prevent_invalid_status_transition
CREATE TRIGGER trigger_prevent_invalid_status_transition
BEFORE UPDATE ON public.crm_user_metadata
FOR EACH ROW EXECUTE FUNCTION public.prevent_invalid_status_transition();


----------------------------------------------------------------------------

-- Function: update_expired_subscriptions
-- Updates subscription_status to 'expired' for users whose subscription_ends_at has passed.
-- Intended to be called by a daily cron job (e.g., via pg_cron).
CREATE OR REPLACE FUNCTION public.update_expired_subscriptions()
RETURNS void AS $$
BEGIN
  UPDATE public.crm_user_metadata
  SET subscription_status = 'expired',
      updated_at = NOW()
  WHERE subscription_ends_at < NOW() AND subscription_status = 'active';
END;
$$ LANGUAGE plpgsql;

-- Example pg_cron setup (run daily at midnight):
-- SELECT cron.schedule('update_expired_subscriptions', '0 0 * * *', $$SELECT public.update_expired_subscriptions()$$);