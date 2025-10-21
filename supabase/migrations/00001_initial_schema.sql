-- WARNING: This schema is for context only and is not meant to be run.
-- Table order and constraints may not be valid for execution.

CREATE TABLE public.crm_admin (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email ~ '^[^@]+@[^@]+\.[^@]+$'),
  password_hash text NOT NULL,
  full_name text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT crm_admin_pkey PRIMARY KEY (id)
);
CREATE TABLE public.crm_partner (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email ~ '^[^@]+@[^@]+\.[^@]+$'),
  password_hash text NOT NULL,
  full_name text,
  commission_percent integer NOT NULL DEFAULT 10 CHECK (commission_percent >= 0 AND commission_percent <= 50),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  total_revenue numeric NOT NULL DEFAULT 0 CHECK (total_revenue >= 0::numeric),
  total_added bigint NOT NULL DEFAULT 0 CHECK (total_added >= 0),
  total_converted bigint NOT NULL DEFAULT 0 CHECK (total_converted >= 0),
  CONSTRAINT crm_partner_pkey PRIMARY KEY (id)
);
CREATE TABLE public.crm_payment (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  amount numeric NOT NULL CHECK (amount >= 0::numeric),
  currency text NOT NULL DEFAULT 'usd'::text,
  stripe_payment_id text NOT NULL UNIQUE,
  paid_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  stripe_customer_id text,
  CONSTRAINT crm_payment_pkey PRIMARY KEY (id),
  CONSTRAINT crm_payment_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id)
);
CREATE TABLE public.crm_user_metadata (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  crm_partner_id uuid,
  email text NOT NULL CHECK (email ~ '^[^@]+@[^@]+\.[^@]+$'),
  region text CHECK (region = ANY (ARRAY['India'::text, 'International'::text])),
  converted_at timestamp with time zone,
  subscription_status text NOT NULL DEFAULT 'added'::text CHECK (subscription_status = ANY (ARRAY['added'::text, 'active'::text, 'expired'::text])),
  subscription_ends_at timestamp with time zone,
  stripe_customer_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT crm_user_metadata_pkey PRIMARY KEY (id),
  CONSTRAINT crm_user_metadata_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id),
  CONSTRAINT crm_user_metadata_crm_partner_id_fkey FOREIGN KEY (crm_partner_id) REFERENCES public.crm_partner(id)
);