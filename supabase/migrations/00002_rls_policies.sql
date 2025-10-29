-- ============================================
-- CRM System RLS Policies
-- (Admin/Partner auth handled in edge functions)
-- ============================================

BEGIN;

-- Enable RLS on all tables
ALTER TABLE public.crm_admin ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_partner ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_user_metadata ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- CRM_ADMIN POLICIES
-- ============================================================================
-- Admins authenticate separately, so only service role can access
-- Your edge functions will use service role to query this table

CREATE POLICY "Service role has full access to crm_admin"
ON public.crm_admin
FOR ALL
TO service_role
USING (true);

-- ============================================================================
-- CRM_PARTNER POLICIES
-- ============================================================================
-- Partners authenticate separately, so only service role can access
-- Your edge functions will use service role to query this table

CREATE POLICY "Service role has full access to crm_partner"
ON public.crm_partner
FOR ALL
TO service_role
USING (true);

-- ============================================================================
-- CRM_PAYMENT POLICIES
-- ============================================================================

-- Users can view their own payments
CREATE POLICY "Users can view own payments"
ON public.crm_payment
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Service role can manage all payments (for webhooks, admin operations)
CREATE POLICY "Service role can manage payments"
ON public.crm_payment
FOR ALL
TO service_role
USING (true);

-- ============================================================================
-- CRM_USER_METADATA POLICIES
-- ============================================================================

-- Users can view their own metadata
CREATE POLICY "Users can view own metadata"
ON public.crm_user_metadata
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Users can update limited fields of their own metadata (if needed)
-- Remove this policy if users shouldn't update their metadata at all
CREATE POLICY "Users can update own metadata"
ON public.crm_user_metadata
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

-- Service role can fully manage all user metadata
-- (for admin operations, partner operations, webhooks)
CREATE POLICY "Service role can manage user metadata"
ON public.crm_user_metadata
FOR ALL
TO service_role
USING (true);

COMMIT;

-- ============================================
-- Verification
-- ============================================
SELECT 
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd
FROM pg_policies
WHERE schemaname = 'public' 
AND tablename LIKE 'crm_%'
ORDER BY tablename, policyname;