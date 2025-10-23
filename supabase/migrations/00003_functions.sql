-- =============================================
-- CRM FUNCTIONS & TRIGGERS (with crm_ prefix)
-- =============================================

-- 1. crm_set_converted_at
CREATE OR REPLACE FUNCTION public.crm_set_converted_at()
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

CREATE TRIGGER crm_trigger_set_converted_at
AFTER INSERT ON public.crm_payment
FOR EACH ROW EXECUTE FUNCTION public.crm_set_converted_at();


-------------------------------------------------------------------

-- 2. crm_update_partner_revenue
CREATE OR REPLACE FUNCTION public.crm_update_partner_revenue()
RETURNS TRIGGER AS $$
DECLARE
  partner_id uuid;
  commission_percent integer;
  commission_amount numeric;
BEGIN
  SELECT um.crm_partner_id, p.commission_percent
  INTO partner_id, commission_percent
  FROM public.crm_user_metadata um
  JOIN public.crm_partner p ON um.crm_partner_id = p.id
  WHERE um.user_id = NEW.user_id AND um.converted_at IS NULL
  FOR UPDATE OF p;

  IF partner_id IS NOT NULL THEN
    commission_amount := NEW.amount * commission_percent / 100.0;
    
    UPDATE public.crm_partner
    SET total_revenue = total_revenue + commission_amount,
        total_converted = total_converted + 1,
        updated_at = NOW()
    WHERE id = partner_id;
    
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Partner with id % not found during revenue update', partner_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER crm_trigger_update_partner_revenue
AFTER INSERT ON public.crm_payment
FOR EACH ROW EXECUTE FUNCTION public.crm_update_partner_revenue();


-------------------------------------------------------------------

-- 3. crm_update_updated_at
CREATE OR REPLACE FUNCTION public.crm_update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER crm_trigger_update_updated_at
BEFORE UPDATE ON public.crm_user_metadata
FOR EACH ROW EXECUTE FUNCTION public.crm_update_updated_at();


-------------------------------------------------------------------

-- 4. crm_increment_total_added
CREATE OR REPLACE FUNCTION public.crm_increment_total_added()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.crm_partner_id IS NOT NULL THEN
    UPDATE public.crm_partner
    SET total_added = total_added + 1,
        updated_at = NOW()
    WHERE id = NEW.crm_partner_id;
    
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Partner with id % not found during total_added increment', NEW.crm_partner_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

CREATE TRIGGER crm_trigger_increment_total_added
AFTER INSERT ON public.crm_user_metadata
FOR EACH ROW EXECUTE FUNCTION public.crm_increment_total_added();


-------------------------------------------------------------------

-- 5. crm_prevent_invalid_status_transition
CREATE OR REPLACE FUNCTION public.crm_prevent_invalid_status_transition()
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

CREATE TRIGGER crm_trigger_prevent_invalid_status_transition
BEFORE UPDATE ON public.crm_user_metadata
FOR EACH ROW EXECUTE FUNCTION public.crm_prevent_invalid_status_transition();


-------------------------------------------------------------------

-- 6. crm_update_expired_subscriptions
CREATE OR REPLACE FUNCTION public.crm_update_expired_subscriptions()
RETURNS void AS $$
BEGIN
  UPDATE public.crm_user_metadata
  SET subscription_status = 'expired',
      updated_at = NOW()
  WHERE subscription_ends_at < NOW() AND subscription_status = 'active';
END;
$$ LANGUAGE plpgsql;

-- Optional: Schedule with pg_cron (run once)
-- SELECT cron.schedule('crm_update_expired_subscriptions', '0 0 * * *', $$SELECT public.crm_update_expired_subscriptions()$$);