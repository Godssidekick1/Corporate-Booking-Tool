--
-- PostgreSQL database dump
--

\restrict KFekQu9TLw0dZPFKamX846263OspDlnRXRih0JGXjIXzSC7fWYIj8RTaRhW51Jl

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: check_client_policy_group_overlap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_client_policy_group_overlap() RETURNS trigger
    LANGUAGE plpgsql
    AS $$

declare

  conflict record;

begin

  perform pg_advisory_xact_lock(hashtext(new.client_id::text));



  select existing_group.name as group_name, shared.band_rank as band_rank

    into conflict

  from client_policy_groups link

  join policy_groups existing_group

    on existing_group.id = link.policy_group_id

  join policy_group_band_ranks shared

    on shared.policy_group_id = link.policy_group_id

  join policy_group_band_ranks incoming

    on incoming.policy_group_id = new.policy_group_id

   and incoming.band_rank = shared.band_rank

  where link.client_id = new.client_id

    and link.policy_group_id <> new.policy_group_id

  order by shared.band_rank

  limit 1;



  if conflict.group_name is not null then

    raise exception

      'Policy group overlaps with "%" at band rank % for this client',

      conflict.group_name, conflict.band_rank

      using errcode = '23P01';

  end if;



  return new;

end;

$$;


--
-- Name: check_policy_group_rank_overlap(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_policy_group_rank_overlap() RETURNS trigger
    LANGUAGE plpgsql
    AS $$

declare

  linked_client record;

  conflict      record;

begin

  for linked_client in

    select client_id

    from client_policy_groups

    where policy_group_id = new.policy_group_id

    order by client_id

  loop

    perform pg_advisory_xact_lock(hashtext(linked_client.client_id::text));

  end loop;



  select other_group.name as group_name, link.client_id as client_id

    into conflict

  from client_policy_groups mine

  join client_policy_groups link

    on link.client_id = mine.client_id

   and link.policy_group_id <> new.policy_group_id

  join policy_groups other_group

    on other_group.id = link.policy_group_id

  join policy_group_band_ranks other_ranks

    on other_ranks.policy_group_id = link.policy_group_id

   and other_ranks.band_rank = new.band_rank

  where mine.policy_group_id = new.policy_group_id

  limit 1;



  if conflict.group_name is not null then

    raise exception

      'Band rank % is already covered by "%" for a client using this group',

      new.band_rank, conflict.group_name

      using errcode = '23P01';

  end if;



  return new;

end;

$$;


--
-- Name: check_tier_approver_client(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_tier_approver_client() RETURNS trigger
    LANGUAGE plpgsql
    AS $$

declare

  approver_client uuid;

begin

  if new.approver_user_id is null then

    return new;

  end if;



  select client_id into approver_client

  from employees

  where id = new.approver_user_id;



  if approver_client is distinct from new.client_id then

    raise exception

      'Approver % does not belong to client %', new.approver_user_id, new.client_id

      using errcode = '23514';

  end if;



  return new;

end;

$$;


--
-- Name: current_client_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_client_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$

  select client_id from employees where id = auth.uid()

$$;


--
-- Name: FUNCTION current_client_id(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.current_client_id() IS 'The calling user''s client_id. SECURITY DEFINER so that RLS policies on employees can scope by client without recursing into themselves.';


--
-- Name: current_employee_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_employee_role() RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$

  select role from employees where id = auth.uid()

$$;


--
-- Name: FUNCTION current_employee_role(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.current_employee_role() IS 'The calling user''s role. Exists for the same reason as current_client_id(): a role check written as a subquery on employees re-enters the employees policy.';


--
-- Name: rls_auto_enable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rls_auto_enable() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


--
-- Name: sync_employee_band_fields(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_employee_band_fields() RETURNS trigger
    LANGUAGE plpgsql
    AS $$

DECLARE b RECORD;

BEGIN

  IF NEW.band_id IS NOT NULL AND (

    TG_OP = 'INSERT' OR NEW.band_id IS DISTINCT FROM OLD.band_id

  ) THEN

    SELECT code, rank INTO b FROM bands WHERE id = NEW.band_id;

    IF NOT FOUND THEN

      RAISE EXCEPTION 'Band % does not exist', NEW.band_id;

    END IF;

    NEW.band_code := b.code;

    NEW.band_rank := b.rank;

  END IF;

  RETURN NEW;

END;

$$;


--
-- Name: sync_employees_on_band_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_employees_on_band_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$

begin

  if new.code is distinct from old.code or new.rank is distinct from old.rank then

    -- Match on band_id where it is set, and fall back to the old code for rows

    -- written by paths that only populated the denormalised columns.

    update employees

       set band_code = new.code,

           band_rank = new.rank

     where client_id = new.client_id

       and (

         band_id = new.id

         or (band_id is null and band_code = old.code)

       );

  end if;



  return new;

end;

$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: airlines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.airlines (
    code text NOT NULL,
    name text NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE airlines; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.airlines IS 'Carriers seen in Amadeus search responses, harvested as searches run. A suggestion list for the deal code and form of payment editors - NOT a whitelist, since a carrier nobody has searched yet is legitimately absent.';


--
-- Name: COLUMN airlines.last_seen_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.airlines.last_seen_at IS 'Updated every time this carrier appears in a search. A row whose last_seen_at is months old is a carrier no longer being sold, not a data error.';


--
-- Name: amadeus_session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.amadeus_session (
    id integer DEFAULT 1 NOT NULL,
    session_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT single_row CHECK ((id = 1))
);


--
-- Name: approval_chain_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_chain_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid NOT NULL,
    name text NOT NULL,
    code text,
    description text,
    mode text DEFAULT 'sequential'::text NOT NULL,
    quorum text DEFAULT 'all'::text NOT NULL,
    tiers jsonb DEFAULT '[]'::jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    client_id uuid,
    CONSTRAINT approval_chain_templates_mode_check CHECK ((mode = ANY (ARRAY['sequential'::text, 'parallel'::text]))),
    CONSTRAINT approval_chain_templates_quorum_check CHECK ((quorum = ANY (ARRAY['any'::text, 'all'::text])))
);


--
-- Name: TABLE approval_chain_templates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.approval_chain_templates IS 'A reusable chain of approval steps. Deliberately has NO category: which kind of spend a chain routes is decided where it is assigned, not by the chain itself, so one chain can serve air, hotel and misc without being duplicated.';


--
-- Name: COLUMN approval_chain_templates.tiers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.approval_chain_templates.tiers IS 'Structure only: [{ tier, min_verdict, label? }]. Who fills each step lives in approval_tier_approvers.';


--
-- Name: COLUMN approval_chain_templates.client_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.approval_chain_templates.client_id IS 'NULL = shared across the TMC. Set = offered only to that company (direct mapping).';


--
-- Name: approval_tier_approvers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approval_tier_approvers (
    client_id uuid NOT NULL,
    template_id uuid NOT NULL,
    tier integer NOT NULL,
    approver_type text NOT NULL,
    approver_user_id uuid,
    min_band_rank integer,
    assigned_by uuid,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT approval_tier_approvers_approver_type_check CHECK ((approver_type = ANY (ARRAY['manager'::text, 'any_manager_at'::text, 'finance_role'::text, 'admin'::text, 'self'::text, 'specific_user'::text]))),
    CONSTRAINT approval_tier_approvers_rank_ck CHECK (((approver_type <> 'any_manager_at'::text) OR (min_band_rank IS NOT NULL))),
    CONSTRAINT approval_tier_approvers_specific_user_ck CHECK (((approver_type <> 'specific_user'::text) OR (approver_user_id IS NOT NULL)))
);


--
-- Name: approvals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.approvals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    booking_id uuid NOT NULL,
    approver_id uuid NOT NULL,
    tier integer NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    reason text,
    actioned_at timestamp with time zone,
    escalates_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    verdict text,
    decision_note text,
    chain_template_id uuid,
    CONSTRAINT approvals_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT approvals_verdict_check CHECK ((verdict = ANY (ARRAY['green'::text, 'amber'::text, 'red'::text])))
);


--
-- Name: audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid,
    tmc_id uuid,
    user_id uuid,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: band_approval_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.band_approval_templates (
    client_id uuid NOT NULL,
    band_code text NOT NULL,
    category text NOT NULL,
    template_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_by uuid
);


--
-- Name: TABLE band_approval_templates; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.band_approval_templates IS 'Approval chain for every employee in one band at one client. The middle rung of employee -> band -> client default; most specific wins.';


--
-- Name: bands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    code text NOT NULL,
    label text NOT NULL,
    rank integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: bookings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bookings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    booking_type text NOT NULL,
    status text DEFAULT 'pending_approval'::text NOT NULL,
    policy_status text NOT NULL,
    total_cost numeric(14,2) NOT NULL,
    provider_order_id text,
    pnr text,
    itinerary jsonb NOT NULL,
    traveler_snapshot jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    requested_for uuid,
    trip_id uuid,
    provider text DEFAULT '1A'::text,
    session_id text,
    search_key text,
    amadeus_key text,
    pricing_key text,
    is_ndc boolean DEFAULT false,
    ticket_numbers text[],
    fare_breakdown jsonb,
    policy_verdict text,
    policy_verdict_detail jsonb,
    result_index text,
    resolved_deal_codes jsonb,
    resolved_fop jsonb,
    sell_total numeric(12,2),
    commercials jsonb,
    share_token text,
    CONSTRAINT bookings_policy_verdict_check CHECK (((policy_verdict IS NULL) OR (policy_verdict = ANY (ARRAY['green'::text, 'amber'::text, 'red'::text])))),
    CONSTRAINT bookings_status_check CHECK ((status = ANY (ARRAY['pending_approval'::text, 'approved'::text, 'approval_misconfigured'::text, 'rejected'::text, 'priced'::text, 'passenger_added'::text, 'held'::text, 'ticketed'::text, 'cancelled'::text, 'failed'::text])))
);


--
-- Name: COLUMN bookings.provider_order_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.provider_order_id IS 'Amadeus ReferenceNo, minted at Pricing time.';


--
-- Name: COLUMN bookings.pnr; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.pnr IS 'Amadeus PNR, assigned at Booking time (Hold/Confirm status).';


--
-- Name: COLUMN bookings.amadeus_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.amadeus_key IS 'The working Key used for Booking/Ticket/Cancel/FareRule/SeatMap calls after Pricing -- distinct from search_key. Has a real TTL; expect "Result Session Expired" errors if reused too late.';


--
-- Name: COLUMN bookings.resolved_deal_codes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.resolved_deal_codes IS 'Deal codes resolved when this booking was created, one winner per airline per code type. Recorded for manual GDS entry and reconciliation - nothing is transmitted to the aggregator.';


--
-- Name: COLUMN bookings.resolved_fop; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.resolved_fop IS 'The form of payment resolved when this booking was created. Recorded for settlement and reconciliation - nothing is transmitted to the aggregator.';


--
-- Name: COLUMN bookings.sell_total; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.sell_total IS 'What the corporate is invoiced: airline total + markup - discount + processing fee. Distinct from total_cost, which stays the airline figure.';


--
-- Name: COLUMN bookings.commercials; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.commercials IS 'The frozen pricing pipeline: airline components, an ORDERED array of adjustments, and the totals. An array rather than named keys so deal codes and forms of payment slot in later without a shape change.';


--
-- Name: COLUMN bookings.share_token; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bookings.share_token IS 'Unguessable secret for the public e-ticket at /t/[token]. Issued at ticketing. Clearing it revokes the link without altering the booking.';


--
-- Name: employees; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid,
    tmc_id uuid,
    band_id uuid,
    manager_id uuid,
    full_name text NOT NULL,
    email text NOT NULL,
    role text DEFAULT 'employee'::text NOT NULL,
    department text,
    cost_centre text,
    band_code text,
    band_rank integer,
    traveler_profile jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    invited_by uuid,
    invited_at timestamp with time zone,
    onboarding_method text DEFAULT 'invite'::text NOT NULL,
    first_login_completed boolean DEFAULT false NOT NULL,
    client_group_id uuid,
    auth_user_id uuid,
    top_of_hierarchy boolean DEFAULT false NOT NULL,
    designation text,
    branch_id uuid,
    CONSTRAINT employee_must_have_context CHECK (((client_id IS NOT NULL) OR (tmc_id IS NOT NULL))),
    CONSTRAINT employees_onboarding_method_check CHECK ((onboarding_method = ANY (ARRAY['invite'::text, 'direct_create'::text, 'self_register'::text]))),
    CONSTRAINT employees_top_of_hierarchy_ck CHECK ((NOT (top_of_hierarchy AND (manager_id IS NOT NULL))))
);


--
-- Name: COLUMN employees.client_group_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employees.client_group_id IS 'The client group this employee''s company belongs to. Not a TMC branch — that is a separate concept, not yet built.';


--
-- Name: COLUMN employees.top_of_hierarchy; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employees.top_of_hierarchy IS 'True when nobody is above this person. Distinguishes an intentionally empty manager_id from one never configured.';


--
-- Name: COLUMN employees.designation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employees.designation IS 'Job title, e.g. Head of IT. Distinct from role (permissions) and band (policy limits).';


--
-- Name: COLUMN employees.branch_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.employees.branch_id IS 'The TMC office this employee works out of. TMC-side staff only. Not a permission boundary - client access is employee_client_access.';


--
-- Name: booking_traveller; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.booking_traveller AS
 SELECT b.id AS booking_id,
    COALESCE(b.requested_for, b.employee_id) AS traveller_id,
    e.band_id,
    e.band_code,
    e.band_rank,
    e.client_id AS company_id
   FROM (public.bookings b
     JOIN public.employees e ON ((e.id = COALESCE(b.requested_for, b.employee_id))));


--
-- Name: branches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.branches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid NOT NULL,
    name text NOT NULL,
    branch_no text,
    profit_centre_code text,
    gst_number text,
    gst_name text,
    gst_email text,
    gst_contact text,
    gst_address_1 text,
    gst_address_2 text,
    country text DEFAULT 'India'::text NOT NULL,
    gst_state text,
    gst_city text,
    gst_zip text,
    iata_number text,
    office_id text,
    is_head_office boolean DEFAULT false NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT branches_status_check CHECK ((status = ANY (ARRAY['active'::text, 'inactive'::text])))
);


--
-- Name: bucket_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bucket_clients (
    bucket_id uuid NOT NULL,
    client_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: buckets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.buckets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid NOT NULL,
    name text NOT NULL,
    code text,
    description text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE buckets; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.buckets IS 'An arbitrary curated set of clients, made for distribution - "Tier 1 corporates", "North India desk". Cuts across client_groups on purpose, a client can be in several, and the same bucket serves deal codes and forms of payment at once. Not a client group: that is the client''s own org hierarchy.';


--
-- Name: client_default_approval_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_default_approval_templates (
    client_id uuid NOT NULL,
    category text NOT NULL,
    template_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_by uuid
);


--
-- Name: client_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid NOT NULL,
    name text NOT NULL,
    city text,
    country text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    group_code text,
    contact_first_name text,
    contact_last_name text,
    contact_email text,
    contact_mobile text,
    bill_to_address_1 text,
    bill_to_address_2 text,
    bill_to_state text,
    bill_to_pincode text
);


--
-- Name: TABLE client_groups; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.client_groups IS 'The client''s OWN org structure - Acme Group above Acme India and Acme UK. A hierarchical fact about who a client is, and a client belongs to at most one. Not a bucket: a bucket is an arbitrary curated set used for distribution, and a client can be in many. Not a branch either - a branch is one of the TMC''s own offices.';


--
-- Name: COLUMN client_groups.city; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_groups.city IS 'Part of the bill-to address. Predates the bill_to_ prefix and kept under its original name rather than renamed, which would break every existing reader.';


--
-- Name: COLUMN client_groups.group_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_groups.group_code IS 'Short reference the TMC assigns and uses elsewhere. Unique per TMC where set.';


--
-- Name: COLUMN client_groups.contact_email; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.client_groups.contact_email IS 'Who to reach about this group commercially. NOT a login - it grants nothing and no auth path reads it.';


--
-- Name: client_gst_registrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_gst_registrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    gstin text,
    gst_holder text,
    email text,
    contact text,
    address_1 text,
    address_2 text,
    city text,
    state text,
    country text,
    zip text,
    registration_date date,
    valid_from date,
    valid_to date,
    cost_centre_id uuid,
    is_primary boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT gst_validity_ordered CHECK (((valid_to IS NULL) OR (valid_from IS NULL) OR (valid_to >= valid_from)))
);


--
-- Name: TABLE client_gst_registrations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.client_gst_registrations IS 'Every GST registration a client bills under. Which one applies to a booking is decided by cost centre and validity window, with is_primary as the fallback.';


--
-- Name: client_mandatory_info; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_mandatory_info (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    code text NOT NULL,
    description text,
    type text,
    gds_entry text,
    value_prefix text,
    is_mandatory boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE client_mandatory_info; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.client_mandatory_info IS 'Entries a booking for this client must carry, and the GDS command they go into. Recorded for manual entry and reconciliation - nothing here is sent to the aggregator.';


--
-- Name: client_policy_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.client_policy_groups (
    client_id uuid NOT NULL,
    policy_group_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_by uuid
);


--
-- Name: clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid,
    name text NOT NULL,
    status text DEFAULT '''pending_setup''::text'::text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    setup_completed boolean DEFAULT false NOT NULL,
    setup_completed_at timestamp with time zone,
    size text,
    currency character(3) DEFAULT 'INR'::bpchar NOT NULL,
    country text,
    timezone text DEFAULT 'Asia/Kolkata'::text NOT NULL,
    booking_mode text DEFAULT 'sbt'::text NOT NULL,
    client_group_id uuid,
    managed_by uuid,
    registered_address text,
    industry text,
    primary_contact_phone text,
    branch_id uuid,
    client_code text,
    sap_customer_code text,
    sap_group_code text,
    email text,
    phone text,
    address_1 text,
    address_2 text,
    city text,
    state text,
    pincode text,
    collections_name text,
    collections_email text,
    collections_mobile text,
    booking_activation boolean DEFAULT true NOT NULL,
    hold_activation boolean DEFAULT true NOT NULL,
    dom_ticketing boolean DEFAULT true NOT NULL,
    intl_ticketing boolean DEFAULT true NOT NULL,
    hold_auto_issue boolean DEFAULT false NOT NULL,
    sbt_ticketing boolean DEFAULT true NOT NULL,
    policy_controlling boolean DEFAULT true NOT NULL,
    personal_bookings_allowed boolean DEFAULT false NOT NULL,
    agency_fop_allowed boolean DEFAULT true NOT NULL,
    corporate_fop_allowed boolean DEFAULT true NOT NULL,
    discount_active boolean DEFAULT true NOT NULL,
    processing_fee_active boolean DEFAULT true NOT NULL,
    air_approval_mode text DEFAULT 'before_booking'::text NOT NULL,
    hotel_approval_mode text DEFAULT 'before_booking'::text NOT NULL,
    bta_cta_allowed boolean DEFAULT true NOT NULL,
    bta_cta_manual_allowed boolean DEFAULT false NOT NULL,
    fop_priority text[] DEFAULT '{corporate,agency,bta_cta,bta_cta_manual}'::text[] NOT NULL,
    markup_active boolean DEFAULT true NOT NULL,
    CONSTRAINT clients_air_approval_mode_check CHECK ((air_approval_mode = ANY (ARRAY['before_booking'::text, 'not_required'::text]))),
    CONSTRAINT clients_fop_priority_valid CHECK (((fop_priority @> ARRAY['agency'::text, 'corporate'::text, 'bta_cta'::text, 'bta_cta_manual'::text]) AND (array_length(fop_priority, 1) = 4))),
    CONSTRAINT clients_hotel_approval_mode_check CHECK ((hotel_approval_mode = ANY (ARRAY['before_booking'::text, 'not_required'::text]))),
    CONSTRAINT companies_booking_mode_check CHECK ((booking_mode = ANY (ARRAY['sbt'::text, 'cbt'::text, 'both'::text]))),
    CONSTRAINT companies_size_check CHECK ((size = ANY (ARRAY['1-50'::text, '51-200'::text, '201-1000'::text, '1001+'::text])))
);


--
-- Name: COLUMN clients.registered_address; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clients.registered_address IS 'Legacy single-line address, kept as a fallback display. New writes use address_1/address_2/city/state/pincode.';


--
-- Name: COLUMN clients.branch_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clients.branch_id IS 'The TMC branch that services this client. Drives which branch-scoped form of payment applies.';


--
-- Name: COLUMN clients.client_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clients.client_code IS 'Short reference the TMC assigns and quotes on invoices. Unique per TMC where set.';


--
-- Name: COLUMN clients.discount_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clients.discount_active IS 'Off: no discount is applied to this client, even where a discount rule reaches them. Defaults on — the assignment is the deliberate act. Sibling of markup_active and processing_fee_active.';


--
-- Name: COLUMN clients.processing_fee_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clients.processing_fee_active IS 'Off: no processing fee is charged to this client, even where a fee rule reaches them. Defaults on — the assignment is the deliberate act. Sibling of markup_active and discount_active.';


--
-- Name: COLUMN clients.bta_cta_allowed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clients.bta_cta_allowed IS 'BTA/CTA: the traveller pays with their own card, already stored against them here.';


--
-- Name: COLUMN clients.bta_cta_manual_allowed; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clients.bta_cta_manual_allowed IS 'BTA/CTA manual: the traveller types card details at the gateway. Nothing is stored here.';


--
-- Name: COLUMN clients.fop_priority; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clients.fop_priority IS 'Preference order over all four payment types, most preferred first. Always holds all four; the *_allowed booleans decide which are in play.';


--
-- Name: COLUMN clients.markup_active; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.clients.markup_active IS 'Off: no markup is applied to this client''s fares, and they see the airline figure. Siblings discount_active and processing_fee_active, added recorded-only in 20260915000000, become live with this migration.';


--
-- Name: commercial_rule_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commercial_rule_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid NOT NULL,
    rule_id uuid NOT NULL,
    kind text NOT NULL,
    client_id uuid,
    client_group_id uuid,
    bucket_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commercial_rule_assignments_kind_check CHECK ((kind = ANY (ARRAY['client'::text, 'client_group'::text, 'bucket'::text]))),
    CONSTRAINT commercial_rule_assignments_target_matches_kind CHECK ((((kind = 'client'::text) AND (client_id IS NOT NULL) AND (client_group_id IS NULL) AND (bucket_id IS NULL)) OR ((kind = 'client_group'::text) AND (client_group_id IS NOT NULL) AND (client_id IS NULL) AND (bucket_id IS NULL)) OR ((kind = 'bucket'::text) AND (bucket_id IS NOT NULL) AND (client_id IS NULL) AND (client_group_id IS NULL))))
);


--
-- Name: commercial_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.commercial_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid NOT NULL,
    kind text NOT NULL,
    category_id uuid NOT NULL,
    airline_code text,
    cabin text,
    rbd_spec text,
    fare_type text NOT NULL,
    calc_type text NOT NULL,
    calc_on text NOT NULL,
    rate numeric(12,4) NOT NULL,
    calc_basis text,
    exclude_tax_codes text[],
    include_ssr boolean,
    valid_from date,
    valid_to date,
    active boolean DEFAULT true NOT NULL,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT commercial_rules_cabin_check CHECK (((cabin IS NULL) OR (cabin = ANY (ARRAY['Y'::text, 'W'::text, 'C'::text, 'F'::text])))),
    CONSTRAINT commercial_rules_calc_basis_check CHECK ((calc_basis = ANY (ARRAY['per_transaction'::text, 'per_sector'::text]))),
    CONSTRAINT commercial_rules_calc_on_check CHECK ((calc_on = ANY (ARRAY['bf'::text, 'yq'::text, 'yr'::text, 'bf_yq'::text, 'bf_yq_yr'::text, 'tf'::text, 'other_tax'::text]))),
    CONSTRAINT commercial_rules_calc_type_check CHECK ((calc_type = ANY (ARRAY['percent'::text, 'fixed'::text]))),
    CONSTRAINT commercial_rules_fare_type_check CHECK ((fare_type = ANY (ARRAY['all'::text, 'retail'::text, 'corporate'::text, 'soo'::text, 'side_trip'::text]))),
    CONSTRAINT commercial_rules_fee_fields_match_kind CHECK ((((kind = 'processing_fee'::text) AND (calc_basis IS NOT NULL) AND (exclude_tax_codes IS NOT NULL) AND (include_ssr IS NOT NULL)) OR ((kind <> 'processing_fee'::text) AND (calc_basis IS NULL) AND (exclude_tax_codes IS NULL) AND (include_ssr IS NULL)))),
    CONSTRAINT commercial_rules_kind_check CHECK ((kind = ANY (ARRAY['markup'::text, 'discount'::text, 'processing_fee'::text]))),
    CONSTRAINT commercial_rules_rate_check CHECK ((rate >= (0)::numeric)),
    CONSTRAINT commercial_rules_window_ordered CHECK (((valid_from IS NULL) OR (valid_to IS NULL) OR (valid_from <= valid_to)))
);


--
-- Name: TABLE commercial_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.commercial_rules IS 'Markup, discount and processing fee in one table. They compose in a fixed order (discount, markup, fee) into one sell price, which is why they are not three tables.';


--
-- Name: COLUMN commercial_rules.rate; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.commercial_rules.rate IS 'Percent when calc_type = percent, an absolute amount when fixed. For processing_fee it is then multiplied by passengers, and by sectors when calc_basis = per_sector.';


--
-- Name: cost_centres; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.cost_centres (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deal_code_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deal_code_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid NOT NULL,
    deal_code_id uuid NOT NULL,
    kind text NOT NULL,
    client_id uuid,
    client_group_id uuid,
    bucket_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deal_code_assignments_kind_check CHECK ((kind = ANY (ARRAY['client'::text, 'client_group'::text, 'bucket'::text]))),
    CONSTRAINT deal_code_assignments_target_matches_kind CHECK ((((kind = 'client'::text) AND (client_id IS NOT NULL) AND (client_group_id IS NULL) AND (bucket_id IS NULL)) OR ((kind = 'client_group'::text) AND (client_group_id IS NOT NULL) AND (client_id IS NULL) AND (bucket_id IS NULL)) OR ((kind = 'bucket'::text) AND (bucket_id IS NOT NULL) AND (client_id IS NULL) AND (client_group_id IS NULL))))
);


--
-- Name: deal_code_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deal_code_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid NOT NULL,
    code text NOT NULL,
    label text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: deal_code_category_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deal_code_category_types (
    category_id uuid NOT NULL,
    code_type text NOT NULL,
    allowed boolean DEFAULT true NOT NULL,
    CONSTRAINT deal_code_category_types_code_type_check CHECK ((code_type = ANY (ARRAY['TC'::text, 'PF'::text, 'DC'::text, 'TR'::text, 'PC'::text])))
);


--
-- Name: deal_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deal_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid NOT NULL,
    category_id uuid NOT NULL,
    airline_code text NOT NULL,
    code text NOT NULL,
    code_type text NOT NULL,
    flight_spec text,
    sales_from date,
    sales_to date,
    travel_from date,
    travel_to date,
    active boolean DEFAULT true NOT NULL,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deal_codes_code_type_check CHECK ((code_type = ANY (ARRAY['TC'::text, 'PF'::text, 'DC'::text, 'TR'::text, 'PC'::text]))),
    CONSTRAINT deal_codes_sales_window_ordered CHECK (((sales_from IS NULL) OR (sales_to IS NULL) OR (sales_from <= sales_to))),
    CONSTRAINT deal_codes_travel_window_ordered CHECK (((travel_from IS NULL) OR (travel_to IS NULL) OR (travel_from <= travel_to)))
);


--
-- Name: employee_approval_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_approval_templates (
    employee_id uuid NOT NULL,
    category text NOT NULL,
    template_id uuid NOT NULL,
    assigned_at timestamp with time zone DEFAULT now() NOT NULL,
    assigned_by uuid
);


--
-- Name: employee_client_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_client_access (
    employee_id uuid NOT NULL,
    client_id uuid NOT NULL,
    granted_by uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: employee_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.employee_permissions (
    employee_id uuid NOT NULL,
    permission_key text NOT NULL,
    granted_by uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fop_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fop_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid NOT NULL,
    fop_id uuid NOT NULL,
    kind text NOT NULL,
    client_id uuid,
    client_group_id uuid,
    bucket_id uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    CONSTRAINT fop_assignments_kind_check CHECK ((kind = ANY (ARRAY['client'::text, 'client_group'::text, 'bucket'::text]))),
    CONSTRAINT fop_assignments_target_matches_kind CHECK ((((kind = 'client'::text) AND (client_id IS NOT NULL) AND (client_group_id IS NULL) AND (bucket_id IS NULL)) OR ((kind = 'client_group'::text) AND (client_group_id IS NOT NULL) AND (client_id IS NULL) AND (bucket_id IS NULL)) OR ((kind = 'bucket'::text) AND (bucket_id IS NOT NULL) AND (client_id IS NULL) AND (client_group_id IS NULL))))
);


--
-- Name: fop_gds_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fop_gds_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid NOT NULL,
    code text NOT NULL,
    label text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: fop_payment_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.fop_payment_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid NOT NULL,
    code text NOT NULL,
    label text NOT NULL,
    requires_card boolean DEFAULT false NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: forms_of_payment; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.forms_of_payment (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tmc_id uuid NOT NULL,
    label text NOT NULL,
    fop_type text NOT NULL,
    payer text NOT NULL,
    card_type text,
    last4 text,
    expiry_month smallint,
    expiry_year smallint,
    gds_alias text,
    branch_id uuid,
    owner_client_id uuid,
    owner_employee_id uuid,
    airline_code text,
    rbd_spec text,
    active boolean DEFAULT true NOT NULL,
    notes text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    fop_code text,
    gds_entry_id uuid,
    payment_type_id uuid,
    is_default boolean DEFAULT false NOT NULL,
    CONSTRAINT fop_card_fields_match_type CHECK ((((fop_type = 'card'::text) AND (card_type IS NOT NULL)) OR ((fop_type = 'cash'::text) AND (card_type IS NULL) AND (last4 IS NULL) AND (expiry_month IS NULL) AND (expiry_year IS NULL)))),
    CONSTRAINT fop_owner_matches_payer CHECK ((((payer = 'agency'::text) AND (owner_client_id IS NULL) AND (owner_employee_id IS NULL)) OR ((payer = 'corporate'::text) AND (owner_client_id IS NOT NULL) AND (owner_employee_id IS NULL)) OR ((payer = 'traveller'::text) AND (owner_employee_id IS NOT NULL) AND (owner_client_id IS NULL)))),
    CONSTRAINT forms_of_payment_card_type_check CHECK ((card_type = ANY (ARRAY['AX'::text, 'VI'::text, 'CA'::text, 'DC'::text]))),
    CONSTRAINT forms_of_payment_expiry_month_check CHECK (((expiry_month >= 1) AND (expiry_month <= 12))),
    CONSTRAINT forms_of_payment_expiry_year_check CHECK (((expiry_year >= 2000) AND (expiry_year <= 2100))),
    CONSTRAINT forms_of_payment_fop_type_check CHECK ((fop_type = ANY (ARRAY['card'::text, 'cash'::text]))),
    CONSTRAINT forms_of_payment_last4_check CHECK ((last4 ~ '^[0-9]{4}$'::text)),
    CONSTRAINT forms_of_payment_payer_check CHECK ((payer = ANY (ARRAY['agency'::text, 'corporate'::text, 'traveller'::text])))
);


--
-- Name: COLUMN forms_of_payment.fop_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.forms_of_payment.fop_code IS 'Short identifier the TMC assigns and refers to elsewhere. Unique per TMC.';


--
-- Name: COLUMN forms_of_payment.is_default; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.forms_of_payment.is_default IS 'The fallback when nothing else reaches a client. At most one per TMC, chosen explicitly — it replaces the older implicit rule that an unassigned form of payment was the default for its scope.';


--
-- Name: platform_admins; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_admins (
    user_id uuid NOT NULL,
    email text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE platform_admins; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.platform_admins IS 'Amadeus staff who can create TMCs and invite their first admins. Above every tenant role, seeded by hand only — no endpoint writes to this table. Not a value on employees.role, deliberately: that column is tenant-scoped and holds the lowest privileges in the system.';


--
-- Name: policy_group_band_ranks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_group_band_ranks (
    policy_group_id uuid NOT NULL,
    band_rank integer NOT NULL,
    CONSTRAINT policy_group_band_ranks_band_rank_check CHECK ((band_rank >= 0))
);


--
-- Name: policy_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tmc_id uuid NOT NULL,
    code text
);


--
-- Name: policy_rules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.policy_rules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid,
    tmc_id uuid,
    band_id uuid,
    travel_type text NOT NULL,
    limit_key text NOT NULL,
    limit_value numeric(12,2),
    locked boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    policy_group_id uuid,
    deleted_at timestamp with time zone,
    band_code text,
    limit_bool boolean,
    CONSTRAINT policy_rules_scope_check CHECK ((((client_id IS NOT NULL) AND (tmc_id IS NULL)) OR ((tmc_id IS NOT NULL) AND (client_id IS NULL))))
);


--
-- Name: TABLE policy_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.policy_rules IS 'Limits belonging to a policy group. One set per group per version — the group''s rank set (policy_group_band_ranks) decides who they cover. Ranks needing different limits are a different group.';


--
-- Name: price_quotes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.price_quotes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    amadeus_key text NOT NULL,
    reference_no text NOT NULL,
    pricing_key text NOT NULL,
    provider text NOT NULL,
    result_index text,
    airline_components jsonb NOT NULL,
    commercials jsonb NOT NULL,
    sell_total numeric(12,2) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: TABLE price_quotes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.price_quotes IS 'The airline-side figures for one priced itinerary, held server-side so the browser never learns the true fare and never decides what we charge. Disposable; expires_at exists for a sweep that is not yet written.';


--
-- Name: tmcs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tmcs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    settings jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE tmcs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.tmcs IS 'Row with id=00000000-0000-0000-0000-000000000001 is the Amadeus platform owner. Direct-licensed companies (no TMC) reference this row. Do not delete.';


--
-- Name: trip_expenses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_expenses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    trip_id uuid NOT NULL,
    client_id uuid NOT NULL,
    created_by uuid NOT NULL,
    expense_type text DEFAULT 'misc'::text NOT NULL,
    amount numeric NOT NULL,
    currency text DEFAULT 'INR'::text NOT NULL,
    description text,
    receipt_url text,
    expense_date date,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: trips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trips (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id uuid NOT NULL,
    created_by uuid NOT NULL,
    name text,
    description text,
    travel_date date,
    status text DEFAULT 'open'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT booking_groups_status_check CHECK ((status = ANY (ARRAY['open'::text, 'active'::text, 'completed'::text, 'cancelled'::text, 'deleted'::text])))
);


--
-- Name: airlines airlines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.airlines
    ADD CONSTRAINT airlines_pkey PRIMARY KEY (code);


--
-- Name: amadeus_session amadeus_session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.amadeus_session
    ADD CONSTRAINT amadeus_session_pkey PRIMARY KEY (id);


--
-- Name: approval_chain_templates approval_chain_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_chain_templates
    ADD CONSTRAINT approval_chain_templates_pkey PRIMARY KEY (id);


--
-- Name: approval_chain_templates approval_chain_templates_tmc_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_chain_templates
    ADD CONSTRAINT approval_chain_templates_tmc_id_name_key UNIQUE (tmc_id, name);


--
-- Name: approval_tier_approvers approval_tier_approvers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_tier_approvers
    ADD CONSTRAINT approval_tier_approvers_pkey PRIMARY KEY (client_id, template_id, tier);


--
-- Name: approvals approvals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_pkey PRIMARY KEY (id);


--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);


--
-- Name: band_approval_templates band_approval_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.band_approval_templates
    ADD CONSTRAINT band_approval_templates_pkey PRIMARY KEY (client_id, band_code, category);


--
-- Name: bands bands_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bands
    ADD CONSTRAINT bands_company_id_code_key UNIQUE (client_id, code);


--
-- Name: bands bands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bands
    ADD CONSTRAINT bands_pkey PRIMARY KEY (id);


--
-- Name: trips booking_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT booking_groups_pkey PRIMARY KEY (id);


--
-- Name: bookings bookings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_pkey PRIMARY KEY (id);


--
-- Name: client_groups branches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_groups
    ADD CONSTRAINT branches_pkey PRIMARY KEY (id);


--
-- Name: branches branches_pkey1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_pkey1 PRIMARY KEY (id);


--
-- Name: client_groups branches_tmc_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_groups
    ADD CONSTRAINT branches_tmc_id_name_key UNIQUE (tmc_id, name);


--
-- Name: branches branches_tmc_id_name_key1; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_tmc_id_name_key1 UNIQUE (tmc_id, name);


--
-- Name: bucket_clients bucket_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bucket_clients
    ADD CONSTRAINT bucket_clients_pkey PRIMARY KEY (bucket_id, client_id);


--
-- Name: buckets buckets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buckets
    ADD CONSTRAINT buckets_pkey PRIMARY KEY (id);


--
-- Name: buckets buckets_tmc_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buckets
    ADD CONSTRAINT buckets_tmc_id_name_key UNIQUE (tmc_id, name);


--
-- Name: client_gst_registrations client_gst_no_overlap; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_gst_registrations
    ADD CONSTRAINT client_gst_no_overlap EXCLUDE USING gist (client_id WITH =, COALESCE(cost_centre_id, '00000000-0000-0000-0000-000000000000'::uuid) WITH =, daterange(valid_from, valid_to, '[]'::text) WITH &&);


--
-- Name: client_gst_registrations client_gst_registrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_gst_registrations
    ADD CONSTRAINT client_gst_registrations_pkey PRIMARY KEY (id);


--
-- Name: client_mandatory_info client_mandatory_info_client_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_mandatory_info
    ADD CONSTRAINT client_mandatory_info_client_id_code_key UNIQUE (client_id, code);


--
-- Name: client_mandatory_info client_mandatory_info_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_mandatory_info
    ADD CONSTRAINT client_mandatory_info_pkey PRIMARY KEY (id);


--
-- Name: commercial_rule_assignments commercial_rule_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commercial_rule_assignments
    ADD CONSTRAINT commercial_rule_assignments_pkey PRIMARY KEY (id);


--
-- Name: commercial_rules commercial_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commercial_rules
    ADD CONSTRAINT commercial_rules_pkey PRIMARY KEY (id);


--
-- Name: clients companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: client_default_approval_templates company_default_approval_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_default_approval_templates
    ADD CONSTRAINT company_default_approval_templates_pkey PRIMARY KEY (client_id, category);


--
-- Name: client_policy_groups company_policy_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_policy_groups
    ADD CONSTRAINT company_policy_groups_pkey PRIMARY KEY (client_id, policy_group_id);


--
-- Name: cost_centres cost_centres_company_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_centres
    ADD CONSTRAINT cost_centres_company_id_code_key UNIQUE (client_id, code);


--
-- Name: cost_centres cost_centres_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_centres
    ADD CONSTRAINT cost_centres_pkey PRIMARY KEY (id);


--
-- Name: deal_code_assignments deal_code_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_code_assignments
    ADD CONSTRAINT deal_code_assignments_pkey PRIMARY KEY (id);


--
-- Name: deal_code_categories deal_code_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_code_categories
    ADD CONSTRAINT deal_code_categories_pkey PRIMARY KEY (id);


--
-- Name: deal_code_categories deal_code_categories_tmc_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_code_categories
    ADD CONSTRAINT deal_code_categories_tmc_id_code_key UNIQUE (tmc_id, code);


--
-- Name: deal_code_category_types deal_code_category_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_code_category_types
    ADD CONSTRAINT deal_code_category_types_pkey PRIMARY KEY (category_id, code_type);


--
-- Name: deal_codes deal_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_codes
    ADD CONSTRAINT deal_codes_pkey PRIMARY KEY (id);


--
-- Name: employee_approval_templates employee_approval_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_approval_templates
    ADD CONSTRAINT employee_approval_templates_pkey PRIMARY KEY (employee_id, category);


--
-- Name: employee_client_access employee_company_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_client_access
    ADD CONSTRAINT employee_company_access_pkey PRIMARY KEY (employee_id, client_id);


--
-- Name: employee_permissions employee_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_permissions
    ADD CONSTRAINT employee_permissions_pkey PRIMARY KEY (employee_id, permission_key);


--
-- Name: employees employees_company_email_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_company_email_unique UNIQUE (client_id, email);


--
-- Name: employees employees_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_pkey PRIMARY KEY (id);


--
-- Name: fop_assignments fop_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fop_assignments
    ADD CONSTRAINT fop_assignments_pkey PRIMARY KEY (id);


--
-- Name: fop_gds_entries fop_gds_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fop_gds_entries
    ADD CONSTRAINT fop_gds_entries_pkey PRIMARY KEY (id);


--
-- Name: fop_gds_entries fop_gds_entries_tmc_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fop_gds_entries
    ADD CONSTRAINT fop_gds_entries_tmc_id_code_key UNIQUE (tmc_id, code);


--
-- Name: fop_payment_types fop_payment_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fop_payment_types
    ADD CONSTRAINT fop_payment_types_pkey PRIMARY KEY (id);


--
-- Name: fop_payment_types fop_payment_types_tmc_id_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fop_payment_types
    ADD CONSTRAINT fop_payment_types_tmc_id_code_key UNIQUE (tmc_id, code);


--
-- Name: forms_of_payment forms_of_payment_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_of_payment
    ADD CONSTRAINT forms_of_payment_pkey PRIMARY KEY (id);


--
-- Name: platform_admins platform_admins_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_pkey PRIMARY KEY (user_id);


--
-- Name: policy_group_band_ranks policy_group_band_ranks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_group_band_ranks
    ADD CONSTRAINT policy_group_band_ranks_pkey PRIMARY KEY (policy_group_id, band_rank);


--
-- Name: policy_groups policy_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_groups
    ADD CONSTRAINT policy_groups_pkey PRIMARY KEY (id);


--
-- Name: policy_groups policy_groups_tmc_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_groups
    ADD CONSTRAINT policy_groups_tmc_id_name_key UNIQUE (tmc_id, name);


--
-- Name: policy_rules policy_rules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_rules
    ADD CONSTRAINT policy_rules_pkey PRIMARY KEY (id);


--
-- Name: price_quotes price_quotes_amadeus_key_reference_no_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_quotes
    ADD CONSTRAINT price_quotes_amadeus_key_reference_no_key UNIQUE (amadeus_key, reference_no);


--
-- Name: price_quotes price_quotes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_quotes
    ADD CONSTRAINT price_quotes_pkey PRIMARY KEY (id);


--
-- Name: tmcs tmcs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tmcs
    ADD CONSTRAINT tmcs_pkey PRIMARY KEY (id);


--
-- Name: trip_expenses trip_expenses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_expenses
    ADD CONSTRAINT trip_expenses_pkey PRIMARY KEY (id);


--
-- Name: airlines_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX airlines_name_idx ON public.airlines USING btree (lower(name));


--
-- Name: approval_chain_templates_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approval_chain_templates_company_idx ON public.approval_chain_templates USING btree (client_id) WHERE (client_id IS NOT NULL);


--
-- Name: approval_chain_templates_tmc_id_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX approval_chain_templates_tmc_id_code_key ON public.approval_chain_templates USING btree (tmc_id, code) WHERE (code IS NOT NULL);


--
-- Name: approvals_booking_tier_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX approvals_booking_tier_idx ON public.approvals USING btree (booking_id, tier);


--
-- Name: band_approval_templates_template_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX band_approval_templates_template_idx ON public.band_approval_templates USING btree (template_id);


--
-- Name: bookings_share_token_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX bookings_share_token_key ON public.bookings USING btree (share_token) WHERE (share_token IS NOT NULL);


--
-- Name: branches_no_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX branches_no_uniq ON public.branches USING btree (tmc_id, branch_no) WHERE (branch_no IS NOT NULL);


--
-- Name: branches_one_head_office; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX branches_one_head_office ON public.branches USING btree (tmc_id) WHERE is_head_office;


--
-- Name: branches_tmc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX branches_tmc_idx ON public.branches USING btree (tmc_id);


--
-- Name: bucket_clients_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX bucket_clients_client_idx ON public.bucket_clients USING btree (client_id);


--
-- Name: buckets_tmc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX buckets_tmc_idx ON public.buckets USING btree (tmc_id);


--
-- Name: client_groups_code_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX client_groups_code_uniq ON public.client_groups USING btree (tmc_id, group_code) WHERE (group_code IS NOT NULL);


--
-- Name: client_gst_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_gst_client_idx ON public.client_gst_registrations USING btree (client_id);


--
-- Name: client_gst_gstin_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX client_gst_gstin_uniq ON public.client_gst_registrations USING btree (client_id, gstin) WHERE (gstin IS NOT NULL);


--
-- Name: client_gst_primary_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX client_gst_primary_uniq ON public.client_gst_registrations USING btree (client_id) WHERE is_primary;


--
-- Name: client_mandatory_info_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX client_mandatory_info_client_idx ON public.client_mandatory_info USING btree (client_id);


--
-- Name: clients_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX clients_branch_idx ON public.clients USING btree (branch_id) WHERE (branch_id IS NOT NULL);


--
-- Name: clients_code_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX clients_code_uniq ON public.clients USING btree (tmc_id, client_code) WHERE (client_code IS NOT NULL);


--
-- Name: commercial_rule_assignments_bucket_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX commercial_rule_assignments_bucket_uniq ON public.commercial_rule_assignments USING btree (rule_id, bucket_id) WHERE (bucket_id IS NOT NULL);


--
-- Name: commercial_rule_assignments_client_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX commercial_rule_assignments_client_uniq ON public.commercial_rule_assignments USING btree (rule_id, client_id) WHERE (client_id IS NOT NULL);


--
-- Name: commercial_rule_assignments_group_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX commercial_rule_assignments_group_uniq ON public.commercial_rule_assignments USING btree (rule_id, client_group_id) WHERE (client_group_id IS NOT NULL);


--
-- Name: commercial_rule_assignments_rule_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commercial_rule_assignments_rule_idx ON public.commercial_rule_assignments USING btree (rule_id);


--
-- Name: commercial_rule_assignments_tmc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commercial_rule_assignments_tmc_idx ON public.commercial_rule_assignments USING btree (tmc_id);


--
-- Name: commercial_rules_airline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commercial_rules_airline_idx ON public.commercial_rules USING btree (tmc_id, airline_code) WHERE (airline_code IS NOT NULL);


--
-- Name: commercial_rules_tmc_kind_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX commercial_rules_tmc_kind_idx ON public.commercial_rules USING btree (tmc_id, kind);


--
-- Name: company_default_approval_templates_template_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX company_default_approval_templates_template_idx ON public.client_default_approval_templates USING btree (template_id);


--
-- Name: cost_centres_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX cost_centres_company_idx ON public.cost_centres USING btree (client_id);


--
-- Name: deal_code_assignments_bucket_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deal_code_assignments_bucket_uniq ON public.deal_code_assignments USING btree (deal_code_id, bucket_id) WHERE (bucket_id IS NOT NULL);


--
-- Name: deal_code_assignments_client_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deal_code_assignments_client_uniq ON public.deal_code_assignments USING btree (deal_code_id, client_id) WHERE (client_id IS NOT NULL);


--
-- Name: deal_code_assignments_deal_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deal_code_assignments_deal_idx ON public.deal_code_assignments USING btree (deal_code_id);


--
-- Name: deal_code_assignments_group_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX deal_code_assignments_group_uniq ON public.deal_code_assignments USING btree (deal_code_id, client_group_id) WHERE (client_group_id IS NOT NULL);


--
-- Name: deal_code_assignments_tmc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deal_code_assignments_tmc_idx ON public.deal_code_assignments USING btree (tmc_id);


--
-- Name: deal_code_categories_tmc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deal_code_categories_tmc_idx ON public.deal_code_categories USING btree (tmc_id);


--
-- Name: deal_codes_airline_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deal_codes_airline_idx ON public.deal_codes USING btree (tmc_id, airline_code);


--
-- Name: deal_codes_tmc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX deal_codes_tmc_idx ON public.deal_codes USING btree (tmc_id);


--
-- Name: employee_approval_templates_template_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_approval_templates_template_idx ON public.employee_approval_templates USING btree (template_id);


--
-- Name: employee_company_access_employee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_company_access_employee_idx ON public.employee_client_access USING btree (employee_id);


--
-- Name: employee_permissions_employee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employee_permissions_employee_idx ON public.employee_permissions USING btree (employee_id);


--
-- Name: employees_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX employees_branch_idx ON public.employees USING btree (branch_id) WHERE (branch_id IS NOT NULL);


--
-- Name: fop_assignments_bucket_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fop_assignments_bucket_uniq ON public.fop_assignments USING btree (fop_id, bucket_id) WHERE (bucket_id IS NOT NULL);


--
-- Name: fop_assignments_client_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fop_assignments_client_uniq ON public.fop_assignments USING btree (fop_id, client_id) WHERE (client_id IS NOT NULL);


--
-- Name: fop_assignments_fop_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fop_assignments_fop_idx ON public.fop_assignments USING btree (fop_id);


--
-- Name: fop_assignments_group_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fop_assignments_group_uniq ON public.fop_assignments USING btree (fop_id, client_group_id) WHERE (client_group_id IS NOT NULL);


--
-- Name: fop_assignments_tmc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fop_assignments_tmc_idx ON public.fop_assignments USING btree (tmc_id);


--
-- Name: fop_branch_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fop_branch_idx ON public.forms_of_payment USING btree (branch_id) WHERE (branch_id IS NOT NULL);


--
-- Name: fop_code_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fop_code_uniq ON public.forms_of_payment USING btree (tmc_id, fop_code) WHERE (fop_code IS NOT NULL);


--
-- Name: fop_gds_entries_tmc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fop_gds_entries_tmc_idx ON public.fop_gds_entries USING btree (tmc_id);


--
-- Name: fop_one_default_per_tmc; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX fop_one_default_per_tmc ON public.forms_of_payment USING btree (tmc_id) WHERE is_default;


--
-- Name: fop_owner_client_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fop_owner_client_idx ON public.forms_of_payment USING btree (owner_client_id) WHERE (owner_client_id IS NOT NULL);


--
-- Name: fop_owner_employee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fop_owner_employee_idx ON public.forms_of_payment USING btree (owner_employee_id) WHERE (owner_employee_id IS NOT NULL);


--
-- Name: fop_payment_types_tmc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fop_payment_types_tmc_idx ON public.fop_payment_types USING btree (tmc_id);


--
-- Name: fop_tmc_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX fop_tmc_idx ON public.forms_of_payment USING btree (tmc_id);


--
-- Name: idx_approvals_approver_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approvals_approver_pending ON public.approvals USING btree (approver_id, status) WHERE (status = 'pending'::text);


--
-- Name: idx_approvals_booking; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approvals_booking ON public.approvals USING btree (booking_id);


--
-- Name: idx_approvals_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approvals_company ON public.approvals USING btree (client_id);


--
-- Name: idx_approvals_escalation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_approvals_escalation ON public.approvals USING btree (escalates_at) WHERE (status = 'pending'::text);


--
-- Name: idx_audit_log_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_company ON public.audit_log USING btree (client_id);


--
-- Name: idx_audit_log_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_entity ON public.audit_log USING btree (entity_type, entity_id);


--
-- Name: idx_audit_log_tmc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_tmc ON public.audit_log USING btree (tmc_id);


--
-- Name: idx_bands_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bands_company ON public.bands USING btree (client_id);


--
-- Name: idx_booking_groups_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_booking_groups_company ON public.trips USING btree (client_id);


--
-- Name: idx_bookings_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_company ON public.bookings USING btree (client_id);


--
-- Name: idx_bookings_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_employee ON public.bookings USING btree (employee_id);


--
-- Name: idx_bookings_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_group ON public.bookings USING btree (trip_id) WHERE (trip_id IS NOT NULL);


--
-- Name: idx_bookings_req_for; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_req_for ON public.bookings USING btree (requested_for) WHERE (requested_for IS NOT NULL);


--
-- Name: idx_bookings_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bookings_status ON public.bookings USING btree (client_id, status);


--
-- Name: idx_branches_tmc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_branches_tmc ON public.client_groups USING btree (tmc_id);


--
-- Name: idx_companies_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_branch ON public.clients USING btree (client_group_id) WHERE (client_group_id IS NOT NULL);


--
-- Name: idx_companies_managed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_managed ON public.clients USING btree (managed_by) WHERE (managed_by IS NOT NULL);


--
-- Name: idx_companies_tmc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_companies_tmc ON public.clients USING btree (tmc_id);


--
-- Name: idx_company_policy_groups_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_policy_groups_company ON public.client_policy_groups USING btree (client_id);


--
-- Name: idx_company_policy_groups_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_policy_groups_group ON public.client_policy_groups USING btree (policy_group_id);


--
-- Name: idx_employee_company_access_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employee_company_access_employee ON public.employee_client_access USING btree (employee_id);


--
-- Name: idx_employee_permissions_employee; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employee_permissions_employee ON public.employee_permissions USING btree (employee_id);


--
-- Name: idx_employees_auth_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_auth_user_id ON public.employees USING btree (auth_user_id);


--
-- Name: idx_employees_band; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_band ON public.employees USING btree (band_id);


--
-- Name: idx_employees_branch; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_branch ON public.employees USING btree (client_group_id) WHERE (client_group_id IS NOT NULL);


--
-- Name: idx_employees_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_company ON public.employees USING btree (client_id);


--
-- Name: idx_employees_company_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_company_id ON public.employees USING btree (client_id);


--
-- Name: idx_employees_email_company; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_employees_email_company ON public.employees USING btree (client_id, email) WHERE (client_id IS NOT NULL);


--
-- Name: idx_employees_manager; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_manager ON public.employees USING btree (manager_id);


--
-- Name: idx_employees_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_status ON public.employees USING btree (client_id, status);


--
-- Name: idx_employees_tmc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_employees_tmc ON public.employees USING btree (tmc_id);


--
-- Name: idx_policy_groups_code_per_tmc; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_policy_groups_code_per_tmc ON public.policy_groups USING btree (tmc_id, code) WHERE (code IS NOT NULL);


--
-- Name: idx_policy_rules_band_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_rules_band_code ON public.policy_rules USING btree (band_code);


--
-- Name: idx_policy_rules_company; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_rules_company ON public.policy_rules USING btree (client_id);


--
-- Name: idx_policy_rules_company_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_rules_company_version ON public.policy_rules USING btree (client_id, policy_group_id, version) WHERE (deleted_at IS NULL);


--
-- Name: idx_policy_rules_current; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_rules_current ON public.policy_rules USING btree (client_id, band_id, travel_type, limit_key, version DESC);


--
-- Name: idx_policy_rules_tmc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_rules_tmc ON public.policy_rules USING btree (tmc_id);


--
-- Name: idx_policy_rules_tmc_version; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_policy_rules_tmc_version ON public.policy_rules USING btree (tmc_id, version) WHERE (deleted_at IS NULL);


--
-- Name: policy_group_band_ranks_rank_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX policy_group_band_ranks_rank_idx ON public.policy_group_band_ranks USING btree (band_rank);


--
-- Name: policy_groups_tmc_id_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX policy_groups_tmc_id_code_key ON public.policy_groups USING btree (tmc_id, code) WHERE (code IS NOT NULL);


--
-- Name: price_quotes_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX price_quotes_expiry_idx ON public.price_quotes USING btree (expires_at);


--
-- Name: approval_tier_approvers approval_tier_approvers_client_check; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER approval_tier_approvers_client_check AFTER INSERT OR UPDATE ON public.approval_tier_approvers DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.check_tier_approver_client();


--
-- Name: bands bands_sync_employees; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER bands_sync_employees AFTER UPDATE ON public.bands FOR EACH ROW EXECUTE FUNCTION public.sync_employees_on_band_change();


--
-- Name: client_policy_groups client_policy_groups_no_overlap; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER client_policy_groups_no_overlap AFTER INSERT OR UPDATE ON public.client_policy_groups DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.check_client_policy_group_overlap();


--
-- Name: policy_group_band_ranks policy_group_band_ranks_no_overlap; Type: TRIGGER; Schema: public; Owner: -
--

CREATE CONSTRAINT TRIGGER policy_group_band_ranks_no_overlap AFTER INSERT OR UPDATE ON public.policy_group_band_ranks DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION public.check_policy_group_rank_overlap();


--
-- Name: employees trg_sync_employee_band; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_employee_band BEFORE INSERT OR UPDATE OF band_id ON public.employees FOR EACH ROW EXECUTE FUNCTION public.sync_employee_band_fields();


--
-- Name: approval_chain_templates approval_chain_templates_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_chain_templates
    ADD CONSTRAINT approval_chain_templates_company_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: approval_chain_templates approval_chain_templates_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_chain_templates
    ADD CONSTRAINT approval_chain_templates_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: approval_chain_templates approval_chain_templates_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_chain_templates
    ADD CONSTRAINT approval_chain_templates_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: approval_tier_approvers approval_tier_approvers_approver_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_tier_approvers
    ADD CONSTRAINT approval_tier_approvers_approver_user_id_fkey FOREIGN KEY (approver_user_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: approval_tier_approvers approval_tier_approvers_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_tier_approvers
    ADD CONSTRAINT approval_tier_approvers_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: approval_tier_approvers approval_tier_approvers_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_tier_approvers
    ADD CONSTRAINT approval_tier_approvers_company_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: approval_tier_approvers approval_tier_approvers_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approval_tier_approvers
    ADD CONSTRAINT approval_tier_approvers_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.approval_chain_templates(id) ON DELETE CASCADE;


--
-- Name: approvals approvals_approver_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_approver_id_fkey FOREIGN KEY (approver_id) REFERENCES public.employees(id) ON DELETE RESTRICT;


--
-- Name: approvals approvals_booking_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES public.bookings(id) ON DELETE CASCADE;


--
-- Name: approvals approvals_chain_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_chain_template_id_fkey FOREIGN KEY (chain_template_id) REFERENCES public.approval_chain_templates(id) ON DELETE SET NULL;


--
-- Name: approvals approvals_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.approvals
    ADD CONSTRAINT approvals_company_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_company_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: audit_log audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: band_approval_templates band_approval_templates_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.band_approval_templates
    ADD CONSTRAINT band_approval_templates_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: band_approval_templates band_approval_templates_band_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.band_approval_templates
    ADD CONSTRAINT band_approval_templates_band_fk FOREIGN KEY (client_id, band_code) REFERENCES public.bands(client_id, code) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: band_approval_templates band_approval_templates_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.band_approval_templates
    ADD CONSTRAINT band_approval_templates_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: band_approval_templates band_approval_templates_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.band_approval_templates
    ADD CONSTRAINT band_approval_templates_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.approval_chain_templates(id) ON DELETE CASCADE;


--
-- Name: bands bands_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bands
    ADD CONSTRAINT bands_company_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: trips booking_groups_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT booking_groups_company_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: trips booking_groups_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT booking_groups_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE RESTRICT;


--
-- Name: bookings bookings_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_company_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: bookings bookings_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE RESTRICT;


--
-- Name: bookings bookings_requested_for_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_requested_for_fkey FOREIGN KEY (requested_for) REFERENCES public.employees(id) ON DELETE RESTRICT;


--
-- Name: bookings bookings_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bookings
    ADD CONSTRAINT bookings_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE SET NULL;


--
-- Name: branches branches_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: client_groups branches_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_groups
    ADD CONSTRAINT branches_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: branches branches_tmc_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.branches
    ADD CONSTRAINT branches_tmc_id_fkey1 FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: bucket_clients bucket_clients_bucket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bucket_clients
    ADD CONSTRAINT bucket_clients_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES public.buckets(id) ON DELETE CASCADE;


--
-- Name: bucket_clients bucket_clients_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bucket_clients
    ADD CONSTRAINT bucket_clients_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: buckets buckets_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buckets
    ADD CONSTRAINT buckets_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: buckets buckets_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.buckets
    ADD CONSTRAINT buckets_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: client_gst_registrations client_gst_registrations_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_gst_registrations
    ADD CONSTRAINT client_gst_registrations_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: client_gst_registrations client_gst_registrations_cost_centre_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_gst_registrations
    ADD CONSTRAINT client_gst_registrations_cost_centre_id_fkey FOREIGN KEY (cost_centre_id) REFERENCES public.cost_centres(id) ON DELETE SET NULL;


--
-- Name: client_mandatory_info client_mandatory_info_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_mandatory_info
    ADD CONSTRAINT client_mandatory_info_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: clients clients_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT clients_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: commercial_rule_assignments commercial_rule_assignments_bucket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commercial_rule_assignments
    ADD CONSTRAINT commercial_rule_assignments_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES public.buckets(id) ON DELETE CASCADE;


--
-- Name: commercial_rule_assignments commercial_rule_assignments_client_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commercial_rule_assignments
    ADD CONSTRAINT commercial_rule_assignments_client_group_id_fkey FOREIGN KEY (client_group_id) REFERENCES public.client_groups(id) ON DELETE CASCADE;


--
-- Name: commercial_rule_assignments commercial_rule_assignments_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commercial_rule_assignments
    ADD CONSTRAINT commercial_rule_assignments_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: commercial_rule_assignments commercial_rule_assignments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commercial_rule_assignments
    ADD CONSTRAINT commercial_rule_assignments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: commercial_rule_assignments commercial_rule_assignments_rule_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commercial_rule_assignments
    ADD CONSTRAINT commercial_rule_assignments_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES public.commercial_rules(id) ON DELETE CASCADE;


--
-- Name: commercial_rule_assignments commercial_rule_assignments_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commercial_rule_assignments
    ADD CONSTRAINT commercial_rule_assignments_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: commercial_rules commercial_rules_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commercial_rules
    ADD CONSTRAINT commercial_rules_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.deal_code_categories(id) ON DELETE RESTRICT;


--
-- Name: commercial_rules commercial_rules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commercial_rules
    ADD CONSTRAINT commercial_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: commercial_rules commercial_rules_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.commercial_rules
    ADD CONSTRAINT commercial_rules_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: clients companies_client_group_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT companies_client_group_fk FOREIGN KEY (client_group_id) REFERENCES public.client_groups(id) ON DELETE SET NULL;


--
-- Name: clients companies_managed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT companies_managed_by_fkey FOREIGN KEY (managed_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: clients companies_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.clients
    ADD CONSTRAINT companies_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE SET NULL;


--
-- Name: client_default_approval_templates company_default_approval_templates_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_default_approval_templates
    ADD CONSTRAINT company_default_approval_templates_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: client_default_approval_templates company_default_approval_templates_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_default_approval_templates
    ADD CONSTRAINT company_default_approval_templates_company_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: client_default_approval_templates company_default_approval_templates_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_default_approval_templates
    ADD CONSTRAINT company_default_approval_templates_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.approval_chain_templates(id) ON DELETE CASCADE;


--
-- Name: client_policy_groups company_policy_groups_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_policy_groups
    ADD CONSTRAINT company_policy_groups_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: client_policy_groups company_policy_groups_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_policy_groups
    ADD CONSTRAINT company_policy_groups_company_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: client_policy_groups company_policy_groups_policy_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.client_policy_groups
    ADD CONSTRAINT company_policy_groups_policy_group_id_fkey FOREIGN KEY (policy_group_id) REFERENCES public.policy_groups(id) ON DELETE CASCADE;


--
-- Name: cost_centres cost_centres_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.cost_centres
    ADD CONSTRAINT cost_centres_company_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: deal_code_assignments deal_code_assignments_bucket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_code_assignments
    ADD CONSTRAINT deal_code_assignments_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES public.buckets(id) ON DELETE CASCADE;


--
-- Name: deal_code_assignments deal_code_assignments_client_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_code_assignments
    ADD CONSTRAINT deal_code_assignments_client_group_id_fkey FOREIGN KEY (client_group_id) REFERENCES public.client_groups(id) ON DELETE CASCADE;


--
-- Name: deal_code_assignments deal_code_assignments_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_code_assignments
    ADD CONSTRAINT deal_code_assignments_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: deal_code_assignments deal_code_assignments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_code_assignments
    ADD CONSTRAINT deal_code_assignments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: deal_code_assignments deal_code_assignments_deal_code_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_code_assignments
    ADD CONSTRAINT deal_code_assignments_deal_code_id_fkey FOREIGN KEY (deal_code_id) REFERENCES public.deal_codes(id) ON DELETE CASCADE;


--
-- Name: deal_code_assignments deal_code_assignments_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_code_assignments
    ADD CONSTRAINT deal_code_assignments_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: deal_code_categories deal_code_categories_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_code_categories
    ADD CONSTRAINT deal_code_categories_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: deal_code_category_types deal_code_category_types_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_code_category_types
    ADD CONSTRAINT deal_code_category_types_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.deal_code_categories(id) ON DELETE CASCADE;


--
-- Name: deal_codes deal_codes_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_codes
    ADD CONSTRAINT deal_codes_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.deal_code_categories(id) ON DELETE RESTRICT;


--
-- Name: deal_codes deal_codes_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_codes
    ADD CONSTRAINT deal_codes_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: deal_codes deal_codes_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deal_codes
    ADD CONSTRAINT deal_codes_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: employee_approval_templates employee_approval_templates_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_approval_templates
    ADD CONSTRAINT employee_approval_templates_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: employee_approval_templates employee_approval_templates_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_approval_templates
    ADD CONSTRAINT employee_approval_templates_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employee_approval_templates employee_approval_templates_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_approval_templates
    ADD CONSTRAINT employee_approval_templates_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.approval_chain_templates(id) ON DELETE CASCADE;


--
-- Name: employee_client_access employee_company_access_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_client_access
    ADD CONSTRAINT employee_company_access_company_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: employee_client_access employee_company_access_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_client_access
    ADD CONSTRAINT employee_company_access_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employee_client_access employee_company_access_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_client_access
    ADD CONSTRAINT employee_company_access_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: employee_permissions employee_permissions_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_permissions
    ADD CONSTRAINT employee_permissions_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: employee_permissions employee_permissions_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employee_permissions
    ADD CONSTRAINT employee_permissions_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: employees employees_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: employees employees_band_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_band_id_fkey FOREIGN KEY (band_id) REFERENCES public.bands(id) ON DELETE RESTRICT;


--
-- Name: employees employees_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_branch_id_fkey FOREIGN KEY (client_group_id) REFERENCES public.client_groups(id) ON DELETE SET NULL;


--
-- Name: employees employees_branch_id_fkey1; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_branch_id_fkey1 FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: employees employees_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_company_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: employees employees_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: employees employees_manager_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_manager_id_fkey FOREIGN KEY (manager_id) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: employees employees_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.employees
    ADD CONSTRAINT employees_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: fop_assignments fop_assignments_bucket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fop_assignments
    ADD CONSTRAINT fop_assignments_bucket_id_fkey FOREIGN KEY (bucket_id) REFERENCES public.buckets(id) ON DELETE CASCADE;


--
-- Name: fop_assignments fop_assignments_client_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fop_assignments
    ADD CONSTRAINT fop_assignments_client_group_id_fkey FOREIGN KEY (client_group_id) REFERENCES public.client_groups(id) ON DELETE CASCADE;


--
-- Name: fop_assignments fop_assignments_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fop_assignments
    ADD CONSTRAINT fop_assignments_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: fop_assignments fop_assignments_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fop_assignments
    ADD CONSTRAINT fop_assignments_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: fop_assignments fop_assignments_fop_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fop_assignments
    ADD CONSTRAINT fop_assignments_fop_id_fkey FOREIGN KEY (fop_id) REFERENCES public.forms_of_payment(id) ON DELETE CASCADE;


--
-- Name: fop_assignments fop_assignments_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fop_assignments
    ADD CONSTRAINT fop_assignments_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: fop_gds_entries fop_gds_entries_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fop_gds_entries
    ADD CONSTRAINT fop_gds_entries_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: fop_payment_types fop_payment_types_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.fop_payment_types
    ADD CONSTRAINT fop_payment_types_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: forms_of_payment forms_of_payment_branch_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_of_payment
    ADD CONSTRAINT forms_of_payment_branch_id_fkey FOREIGN KEY (branch_id) REFERENCES public.branches(id) ON DELETE SET NULL;


--
-- Name: forms_of_payment forms_of_payment_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_of_payment
    ADD CONSTRAINT forms_of_payment_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: forms_of_payment forms_of_payment_gds_entry_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_of_payment
    ADD CONSTRAINT forms_of_payment_gds_entry_id_fkey FOREIGN KEY (gds_entry_id) REFERENCES public.fop_gds_entries(id) ON DELETE RESTRICT;


--
-- Name: forms_of_payment forms_of_payment_owner_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_of_payment
    ADD CONSTRAINT forms_of_payment_owner_client_id_fkey FOREIGN KEY (owner_client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: forms_of_payment forms_of_payment_owner_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_of_payment
    ADD CONSTRAINT forms_of_payment_owner_employee_id_fkey FOREIGN KEY (owner_employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: forms_of_payment forms_of_payment_payment_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_of_payment
    ADD CONSTRAINT forms_of_payment_payment_type_id_fkey FOREIGN KEY (payment_type_id) REFERENCES public.fop_payment_types(id) ON DELETE RESTRICT;


--
-- Name: forms_of_payment forms_of_payment_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.forms_of_payment
    ADD CONSTRAINT forms_of_payment_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: platform_admins platform_admins_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_admins
    ADD CONSTRAINT platform_admins_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: policy_group_band_ranks policy_group_band_ranks_policy_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_group_band_ranks
    ADD CONSTRAINT policy_group_band_ranks_policy_group_id_fkey FOREIGN KEY (policy_group_id) REFERENCES public.policy_groups(id) ON DELETE CASCADE;


--
-- Name: policy_groups policy_groups_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_groups
    ADD CONSTRAINT policy_groups_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: policy_rules policy_rules_band_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_rules
    ADD CONSTRAINT policy_rules_band_id_fkey FOREIGN KEY (band_id) REFERENCES public.bands(id) ON DELETE CASCADE;


--
-- Name: policy_rules policy_rules_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_rules
    ADD CONSTRAINT policy_rules_company_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: policy_rules policy_rules_policy_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_rules
    ADD CONSTRAINT policy_rules_policy_group_id_fkey FOREIGN KEY (policy_group_id) REFERENCES public.policy_groups(id) ON DELETE CASCADE;


--
-- Name: policy_rules policy_rules_tmc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_rules
    ADD CONSTRAINT policy_rules_tmc_id_fkey FOREIGN KEY (tmc_id) REFERENCES public.tmcs(id) ON DELETE CASCADE;


--
-- Name: policy_rules policy_rules_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.policy_rules
    ADD CONSTRAINT policy_rules_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.employees(id) ON DELETE SET NULL;


--
-- Name: price_quotes price_quotes_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_quotes
    ADD CONSTRAINT price_quotes_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.clients(id) ON DELETE CASCADE;


--
-- Name: price_quotes price_quotes_employee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.price_quotes
    ADD CONSTRAINT price_quotes_employee_id_fkey FOREIGN KEY (employee_id) REFERENCES public.employees(id) ON DELETE CASCADE;


--
-- Name: trip_expenses trip_expenses_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_expenses
    ADD CONSTRAINT trip_expenses_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: employees Employees: admin update client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Employees: admin update client" ON public.employees FOR UPDATE USING (((client_id = public.current_client_id()) AND (public.current_employee_role() = 'admin'::text)));


--
-- Name: employees Employees: read own client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Employees: read own client" ON public.employees FOR SELECT USING ((client_id = public.current_client_id()));


--
-- Name: employees Employees: update own row; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Employees: update own row" ON public.employees FOR UPDATE USING ((id = auth.uid())) WITH CHECK ((id = auth.uid()));


--
-- Name: airlines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.airlines ENABLE ROW LEVEL SECURITY;

--
-- Name: amadeus_session; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.amadeus_session ENABLE ROW LEVEL SECURITY;

--
-- Name: approval_chain_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.approval_chain_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: approval_tier_approvers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.approval_tier_approvers ENABLE ROW LEVEL SECURITY;

--
-- Name: approvals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.approvals ENABLE ROW LEVEL SECURITY;

--
-- Name: audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: band_approval_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.band_approval_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: bands; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bands ENABLE ROW LEVEL SECURITY;

--
-- Name: bookings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;

--
-- Name: branches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;

--
-- Name: client_groups branches: tmc staff read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "branches: tmc staff read" ON public.client_groups FOR SELECT USING ((tmc_id = ( SELECT employees.tmc_id
   FROM public.employees
  WHERE (employees.id = auth.uid()))));


--
-- Name: bucket_clients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bucket_clients ENABLE ROW LEVEL SECURITY;

--
-- Name: buckets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.buckets ENABLE ROW LEVEL SECURITY;

--
-- Name: client_default_approval_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_default_approval_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: client_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: client_gst_registrations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_gst_registrations ENABLE ROW LEVEL SECURITY;

--
-- Name: client_mandatory_info; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_mandatory_info ENABLE ROW LEVEL SECURITY;

--
-- Name: client_policy_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.client_policy_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: clients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;

--
-- Name: commercial_rule_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commercial_rule_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: commercial_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.commercial_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: cost_centres; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.cost_centres ENABLE ROW LEVEL SECURITY;

--
-- Name: deal_code_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deal_code_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: deal_code_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deal_code_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: deal_code_category_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deal_code_category_types ENABLE ROW LEVEL SECURITY;

--
-- Name: deal_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deal_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_approval_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee_approval_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_client_access; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee_client_access ENABLE ROW LEVEL SECURITY;

--
-- Name: employee_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employee_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: employees; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.employees ENABLE ROW LEVEL SECURITY;

--
-- Name: fop_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fop_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: fop_gds_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fop_gds_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: fop_payment_types; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.fop_payment_types ENABLE ROW LEVEL SECURITY;

--
-- Name: forms_of_payment; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.forms_of_payment ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_admins; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

--
-- Name: policy_group_band_ranks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.policy_group_band_ranks ENABLE ROW LEVEL SECURITY;

--
-- Name: policy_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.policy_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: policy_rules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.policy_rules ENABLE ROW LEVEL SECURITY;

--
-- Name: price_quotes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.price_quotes ENABLE ROW LEVEL SECURITY;

--
-- Name: approvals rls_approvals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_approvals ON public.approvals USING ((client_id = (current_setting('app.current_company_id'::text, true))::uuid));


--
-- Name: audit_log rls_audit_log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_audit_log ON public.audit_log USING ((client_id = (current_setting('app.current_company_id'::text, true))::uuid));


--
-- Name: bands rls_bands; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_bands ON public.bands USING ((client_id = (current_setting('app.current_company_id'::text, true))::uuid));


--
-- Name: bookings rls_bookings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_bookings ON public.bookings USING ((client_id = (current_setting('app.current_company_id'::text, true))::uuid));


--
-- Name: clients rls_companies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_companies ON public.clients USING ((id = (current_setting('app.current_company_id'::text, true))::uuid));


--
-- Name: employees rls_employees; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY rls_employees ON public.employees USING ((client_id = (current_setting('app.current_company_id'::text, true))::uuid));


--
-- Name: tmcs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tmcs ENABLE ROW LEVEL SECURITY;

--
-- Name: trip_expenses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trip_expenses ENABLE ROW LEVEL SECURITY;

--
-- Name: trip_expenses trip_expenses: delete own client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "trip_expenses: delete own client" ON public.trip_expenses FOR DELETE USING ((client_id = (current_setting('app.current_company_id'::text, true))::uuid));


--
-- Name: trip_expenses trip_expenses: insert own client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "trip_expenses: insert own client" ON public.trip_expenses FOR INSERT WITH CHECK ((client_id = (current_setting('app.current_company_id'::text, true))::uuid));


--
-- Name: trip_expenses trip_expenses: read own client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "trip_expenses: read own client" ON public.trip_expenses FOR SELECT USING ((client_id = (current_setting('app.current_company_id'::text, true))::uuid));


--
-- Name: trip_expenses trip_expenses: update own client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "trip_expenses: update own client" ON public.trip_expenses FOR UPDATE USING ((client_id = (current_setting('app.current_company_id'::text, true))::uuid)) WITH CHECK ((client_id = (current_setting('app.current_company_id'::text, true))::uuid));


--
-- Name: trips; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;

--
-- Name: trips trips: insert own client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "trips: insert own client" ON public.trips FOR INSERT WITH CHECK ((client_id = (current_setting('app.current_company_id'::text, true))::uuid));


--
-- Name: trips trips: read own client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "trips: read own client" ON public.trips FOR SELECT USING ((client_id = (current_setting('app.current_company_id'::text, true))::uuid));


--
-- Name: trips trips: update own client; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "trips: update own client" ON public.trips FOR UPDATE USING ((client_id = (current_setting('app.current_company_id'::text, true))::uuid)) WITH CHECK ((client_id = (current_setting('app.current_company_id'::text, true))::uuid));


--
-- PostgreSQL database dump complete
--

\unrestrict KFekQu9TLw0dZPFKamX846263OspDlnRXRih0JGXjIXzSC7fWYIj8RTaRhW51Jl

