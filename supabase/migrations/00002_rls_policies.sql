-- Enable RLS on all tables
ALTER TABLE public.crm_admin ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_partner ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_payment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crm_user_metadata ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- CRM_ADMIN POLICIES
-- ============================================================================

-- Admins can view all admin records
CREATE POLICY "Admins can view all admins"
ON public.crm_admin
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.crm_admin
    WHERE id = auth.uid()
  )
);

-- Admins can insert new admins
CREATE POLICY "Admins can insert admins"
ON public.crm_admin
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.crm_admin
    WHERE id = auth.uid()
  )
);

-- Admins can update admin records
CREATE POLICY "Admins can update admins"
ON public.crm_admin
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.crm_admin
    WHERE id = auth.uid()
  )
);

-- ============================================================================
-- CRM_PARTNER POLICIES
-- ============================================================================

-- Partners can view their own record
CREATE POLICY "Partners can view own record"
ON public.crm_partner
FOR SELECT
TO authenticated
USING (id = auth.uid());

-- Admins can view all partners
CREATE POLICY "Admins can view all partners"
ON public.crm_partner
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.crm_admin
    WHERE id = auth.uid()
  )
);

-- Admins can insert partners
CREATE POLICY "Admins can insert partners"
ON public.crm_partner
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.crm_admin
    WHERE id = auth.uid()
  )
);

-- Admins can update partners
CREATE POLICY "Admins can update partners"
ON public.crm_partner
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.crm_admin
    WHERE id = auth.uid()
  )
);

-- Partners can update their own record (limited fields)
CREATE POLICY "Partners can update own profile"
ON public.crm_partner
FOR UPDATE
TO authenticated
USING (id = auth.uid())
WITH CHECK (id = auth.uid());

-- ============================================================================
-- CRM_PAYMENT POLICIES
-- ============================================================================

-- Users can view their own payments
CREATE POLICY "Users can view own payments"
ON public.crm_payment
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Admins can view all payments
CREATE POLICY "Admins can view all payments"
ON public.crm_payment
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.crm_admin
    WHERE id = auth.uid()
  )
);

-- Partners can view payments from their referred users
CREATE POLICY "Partners can view their users payments"
ON public.crm_payment
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.crm_user_metadata um
    WHERE um.user_id = crm_payment.user_id
    AND um.crm_partner_id = auth.uid()
  )
);

-- Service role can insert payments (for backend/webhook operations)
CREATE POLICY "Service role can insert payments"
ON public.crm_payment
FOR INSERT
TO service_role
WITH CHECK (true);

-- ============================================================================
-- CRM_USER_METADATA POLICIES
-- ============================================================================

-- Users can view their own metadata
CREATE POLICY "Users can view own metadata"
ON public.crm_user_metadata
FOR SELECT
TO authenticated
USING (user_id = auth.uid());

-- Admins can view all user metadata
CREATE POLICY "Admins can view all user metadata"
ON public.crm_user_metadata
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.crm_admin
    WHERE id = auth.uid()
  )
);

-- Partners can view their referred users' metadata
CREATE POLICY "Partners can view their users metadata"
ON public.crm_user_metadata
FOR SELECT
TO authenticated
USING (crm_partner_id = auth.uid());

-- Admins can insert user metadata
CREATE POLICY "Admins can insert user metadata"
ON public.crm_user_metadata
FOR INSERT
TO authenticated
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.crm_admin
    WHERE id = auth.uid()
  )
);

-- Partners can insert user metadata for their referrals
CREATE POLICY "Partners can insert their user metadata"
ON public.crm_user_metadata
FOR INSERT
TO authenticated
WITH CHECK (crm_partner_id = auth.uid());

-- Admins can update all user metadata
CREATE POLICY "Admins can update user metadata"
ON public.crm_user_metadata
FOR UPDATE
TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.crm_admin
    WHERE id = auth.uid()
  )
);

-- Service role can update user metadata (for backend operations)
CREATE POLICY "Service role can update user metadata"
ON public.crm_user_metadata
FOR UPDATE
TO service_role
USING (true);

-- Users can update their own metadata (limited)
CREATE POLICY "Users can update own metadata"
ON public.crm_user_metadata
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());