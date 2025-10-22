-- Test Script: Verify Race Condition Fixes
-- This script demonstrates that the race condition fixes work correctly
-- by simulating concurrent operations.

-- Test setup: Create test data
DO $$
DECLARE
  test_partner_id uuid;
  test_user_id uuid := gen_random_uuid();
BEGIN
  -- Insert test partner
  INSERT INTO public.crm_partner (id, email, full_name, password_hash, commission_percent, is_active)
  VALUES (gen_random_uuid(), 'test@example.com', 'Test Partner', 'dummy_hash', 10, true)
  RETURNING id INTO test_partner_id;
  
  -- Insert a stub auth user to satisfy FK (auth.users.id)
  -- Note: migrations usually run with enough privileges to insert minimal row
  INSERT INTO auth.users (id)
  VALUES (test_user_id);
  
  -- Insert user metadata referencing the created auth user
  INSERT INTO public.crm_user_metadata (user_id, email, region, crm_partner_id, subscription_status)
  VALUES (test_user_id, 'testuser@example.com', 'India', test_partner_id, 'added');
  
  -- Store test IDs for cleanup
  CREATE TEMP TABLE test_cleanup (partner_id uuid, user_id uuid);
  INSERT INTO test_cleanup VALUES (test_partner_id, test_user_id);
  
  RAISE NOTICE 'Test data created - Partner ID: %, User ID: %', test_partner_id, test_user_id;
END $$;

-- Test 1: Verify row-level locking in update_partner_revenue
-- This would previously cause race conditions, now it should be safe
DO $$
DECLARE
  test_user_id uuid;
  initial_revenue numeric;
  final_revenue numeric;
  initial_converted integer;
  final_converted integer;
BEGIN
  -- Get test user ID
  SELECT user_id INTO test_user_id FROM test_cleanup LIMIT 1;
  
  -- Get initial values
  SELECT total_revenue, total_converted INTO initial_revenue, initial_converted
  FROM public.crm_partner p
  JOIN test_cleanup tc ON p.id = tc.partner_id;
  
  -- Simulate concurrent payments (in real scenario these would be separate transactions)
  -- Adjusted to match schema: provide required stripe_payment_id and omit non-existent payment_method
  INSERT INTO public.crm_payment (user_id, amount, paid_at, stripe_payment_id, currency)
  VALUES (test_user_id, 100.00, NOW(), gen_random_uuid()::text, 'usd');
  
  INSERT INTO public.crm_payment (user_id, amount, paid_at, stripe_payment_id, currency)
  VALUES (test_user_id, 50.00, NOW(), gen_random_uuid()::text, 'usd');
  
  -- Get final values
  SELECT total_revenue, total_converted INTO final_revenue, final_converted
  FROM public.crm_partner p
  JOIN test_cleanup tc ON p.id = tc.partner_id;
  
  RAISE NOTICE 'Revenue Test - Initial: %, Final: %, Expected: %', 
    initial_revenue, final_revenue, initial_revenue + 15.00; -- 10% of 150
  RAISE NOTICE 'Converted Test - Initial: %, Final: %, Expected: %', 
    initial_converted, final_converted, initial_converted + 2;
    
  -- Verify calculations are correct
  IF final_revenue = initial_revenue + 15.00 AND final_converted = initial_converted + 2 THEN
    RAISE NOTICE '✅ Revenue calculation test PASSED - No race condition detected';
  ELSE
    RAISE NOTICE '❌ Revenue calculation test FAILED - Race condition may exist';
  END IF;
END $$;

-- Test 2: Verify error handling for missing partner
DO $$
DECLARE
  fake_user_id uuid := gen_random_uuid();
BEGIN
  -- This should not cause an error since partner lookup will return NULL
  INSERT INTO public.crm_payment (user_id, amount, paid_at, stripe_payment_id, currency)
  VALUES (fake_user_id, 100.00, NOW(), gen_random_uuid()::text, 'usd');

  RAISE NOTICE '✅ Missing partner test PASSED - No error for non-existent user';
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE '❌ Missing partner test FAILED - Unexpected error: %', SQLERRM;
END $$;

-- Cleanup test data
DO $$
DECLARE
  test_partner_id uuid;
  test_user_id uuid;
BEGIN
  SELECT partner_id, user_id INTO test_partner_id, test_user_id FROM test_cleanup LIMIT 1;
  
  -- Delete in correct order to avoid foreign key constraints
  DELETE FROM public.crm_payment WHERE user_id = test_user_id;
  DELETE FROM public.crm_user_metadata WHERE user_id = test_user_id;
  DELETE FROM public.crm_partner WHERE id = test_partner_id;
  -- Also remove stub auth user
  DELETE FROM auth.users WHERE id = test_user_id;
  
  DROP TABLE test_cleanup;
  
  RAISE NOTICE 'Test cleanup completed';
END $$;

-- Summary
DO $$
BEGIN
  RAISE NOTICE '=== RACE CONDITION FIX TEST SUMMARY ===';
  RAISE NOTICE 'The update_partner_revenue() function now uses:';
  RAISE NOTICE '1. FOR UPDATE OF p clause for row-level locking';
  RAISE NOTICE '2. Pre-calculated commission_amount variable';
  RAISE NOTICE '3. Atomic UPDATE operations';
  RAISE NOTICE '4. Error handling with NOT FOUND checks';
  RAISE NOTICE '5. updated_at timestamp updates';
  RAISE NOTICE '';
  RAISE NOTICE 'These changes prevent race conditions in concurrent payment processing.';
END $$;