// GENERATED FILE -- DO NOT EDIT BY HAND.
//
// Written by scripts/generate-db-types.mjs from the live database schema.
// Re-run after any schema change:  node scripts/generate-db-types.mjs
//
// 41 tables, 1 view(s), 451 columns.

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

export interface Tables {
  airlines: {
    code: string
    name: string
    first_seen_at: string
    last_seen_at: string
  }
  amadeus_session: {
    id: number
    session_id: string
    expires_at: string
    updated_at: string
  }
  approval_chain_templates: {
    id: string
    tmc_id: string
    name: string
    code: string | null
    description: string | null
    mode: string
    quorum: string
    tiers: Json
    version: number
    updated_by: string | null
    created_at: string
    client_id: string | null
  }
  approval_tier_approvers: {
    client_id: string
    template_id: string
    tier: number
    approver_type: string
    approver_user_id: string | null
    min_band_rank: number | null
    assigned_by: string | null
    assigned_at: string
  }
  approvals: {
    id: string
    client_id: string
    booking_id: string
    approver_id: string
    tier: number
    status: string
    reason: string | null
    actioned_at: string | null
    escalates_at: string | null
    created_at: string
    verdict: string | null
    decision_note: string | null
    chain_template_id: string | null
  }
  audit_log: {
    id: string
    client_id: string | null
    tmc_id: string | null
    user_id: string | null
    action: string
    entity_type: string
    entity_id: string
    metadata: Json
    created_at: string
  }
  band_approval_templates: {
    client_id: string
    band_code: string
    category: string
    template_id: string
    assigned_at: string
    assigned_by: string | null
  }
  bands: {
    id: string
    client_id: string
    code: string
    label: string
    rank: number
    created_at: string
  }
  bookings: {
    id: string
    client_id: string
    employee_id: string
    booking_type: string
    status: string
    policy_status: string
    total_cost: number
    provider_order_id: string | null
    pnr: string | null
    itinerary: Json
    traveler_snapshot: Json
    created_at: string
    updated_at: string
    requested_for: string | null
    trip_id: string | null
    provider: string | null
    session_id: string | null
    search_key: string | null
    amadeus_key: string | null
    pricing_key: string | null
    is_ndc: boolean | null
    ticket_numbers: string[] | null
    fare_breakdown: Json | null
    policy_verdict: string | null
    policy_verdict_detail: Json | null
    result_index: string | null
    resolved_deal_codes: Json | null
    resolved_fop: Json | null
    sell_total: number | null
    commercials: Json | null
    share_token: string | null
  }
  branches: {
    id: string
    tmc_id: string
    name: string
    branch_no: string | null
    profit_centre_code: string | null
    gst_number: string | null
    gst_name: string | null
    gst_email: string | null
    gst_contact: string | null
    gst_address_1: string | null
    gst_address_2: string | null
    country: string
    gst_state: string | null
    gst_city: string | null
    gst_zip: string | null
    iata_number: string | null
    office_id: string | null
    is_head_office: boolean
    status: string
    created_by: string | null
    created_at: string
    updated_at: string
  }
  bucket_clients: {
    bucket_id: string
    client_id: string
    created_at: string
  }
  buckets: {
    id: string
    tmc_id: string
    name: string
    code: string | null
    description: string | null
    created_by: string | null
    created_at: string
  }
  client_default_approval_templates: {
    client_id: string
    category: string
    template_id: string
    assigned_at: string
    assigned_by: string | null
  }
  client_groups: {
    id: string
    tmc_id: string
    name: string
    city: string | null
    country: string | null
    created_at: string
    group_code: string | null
    contact_first_name: string | null
    contact_last_name: string | null
    contact_email: string | null
    contact_mobile: string | null
    bill_to_address_1: string | null
    bill_to_address_2: string | null
    bill_to_state: string | null
    bill_to_pincode: string | null
  }
  client_gst_registrations: {
    id: string
    client_id: string
    gstin: string | null
    gst_holder: string | null
    email: string | null
    contact: string | null
    address_1: string | null
    address_2: string | null
    city: string | null
    state: string | null
    country: string | null
    zip: string | null
    registration_date: string | null
    valid_from: string | null
    valid_to: string | null
    cost_centre_id: string | null
    is_primary: boolean
    created_at: string
  }
  client_mandatory_info: {
    id: string
    client_id: string
    code: string
    description: string | null
    type: string | null
    gds_entry: string | null
    value_prefix: string | null
    is_mandatory: boolean
    created_at: string
  }
  client_policy_groups: {
    client_id: string
    policy_group_id: string
    assigned_at: string
    assigned_by: string | null
  }
  clients: {
    id: string
    tmc_id: string | null
    name: string
    status: string
    settings: Json
    created_at: string
    setup_completed: boolean
    setup_completed_at: string | null
    size: string | null
    currency: string
    country: string | null
    timezone: string
    booking_mode: string
    client_group_id: string | null
    managed_by: string | null
    registered_address: string | null
    industry: string | null
    primary_contact_phone: string | null
    branch_id: string | null
    client_code: string | null
    sap_customer_code: string | null
    sap_group_code: string | null
    email: string | null
    phone: string | null
    address_1: string | null
    address_2: string | null
    city: string | null
    state: string | null
    pincode: string | null
    collections_name: string | null
    collections_email: string | null
    collections_mobile: string | null
    booking_activation: boolean
    hold_activation: boolean
    dom_ticketing: boolean
    intl_ticketing: boolean
    hold_auto_issue: boolean
    sbt_ticketing: boolean
    policy_controlling: boolean
    personal_bookings_allowed: boolean
    agency_fop_allowed: boolean
    corporate_fop_allowed: boolean
    discount_active: boolean
    processing_fee_active: boolean
    air_approval_mode: string
    hotel_approval_mode: string
    bta_cta_allowed: boolean
    bta_cta_manual_allowed: boolean
    fop_priority: string[]
    markup_active: boolean
  }
  commercial_rule_assignments: {
    id: string
    tmc_id: string
    rule_id: string
    kind: string
    client_id: string | null
    client_group_id: string | null
    bucket_id: string | null
    created_by: string | null
    created_at: string
  }
  commercial_rules: {
    id: string
    tmc_id: string
    kind: string
    category_id: string
    airline_code: string | null
    cabin: string | null
    rbd_spec: string | null
    fare_type: string
    calc_type: string
    calc_on: string
    rate: number
    calc_basis: string | null
    exclude_tax_codes: string[] | null
    include_ssr: boolean | null
    valid_from: string | null
    valid_to: string | null
    active: boolean
    notes: string | null
    created_by: string | null
    created_at: string
    updated_at: string
  }
  cost_centres: {
    id: string
    client_id: string
    code: string
    name: string
    created_at: string
  }
  deal_code_assignments: {
    id: string
    tmc_id: string
    deal_code_id: string
    kind: string
    client_id: string | null
    client_group_id: string | null
    bucket_id: string | null
    created_by: string | null
    created_at: string
  }
  deal_code_categories: {
    id: string
    tmc_id: string
    code: string
    label: string
    active: boolean
    created_at: string
  }
  deal_code_category_types: {
    category_id: string
    code_type: string
    allowed: boolean
  }
  deal_codes: {
    id: string
    tmc_id: string
    category_id: string
    airline_code: string
    code: string
    code_type: string
    flight_spec: string | null
    sales_from: string | null
    sales_to: string | null
    travel_from: string | null
    travel_to: string | null
    active: boolean
    notes: string | null
    created_by: string | null
    created_at: string
    updated_at: string
  }
  employee_approval_templates: {
    employee_id: string
    category: string
    template_id: string
    assigned_at: string
    assigned_by: string | null
  }
  employee_client_access: {
    employee_id: string
    client_id: string
    granted_by: string | null
    granted_at: string
  }
  employee_permissions: {
    employee_id: string
    permission_key: string
    granted_by: string | null
    granted_at: string
  }
  employees: {
    id: string
    client_id: string | null
    tmc_id: string | null
    band_id: string | null
    manager_id: string | null
    full_name: string
    email: string
    role: string
    department: string | null
    cost_centre: string | null
    band_code: string | null
    band_rank: number | null
    traveler_profile: Json
    status: string
    created_at: string
    invited_by: string | null
    invited_at: string | null
    onboarding_method: string
    first_login_completed: boolean
    client_group_id: string | null
    auth_user_id: string | null
    top_of_hierarchy: boolean
    designation: string | null
    branch_id: string | null
  }
  fop_assignments: {
    id: string
    tmc_id: string
    fop_id: string
    kind: string
    client_id: string | null
    client_group_id: string | null
    bucket_id: string | null
    created_by: string | null
    created_at: string
    is_active: boolean
  }
  fop_gds_entries: {
    id: string
    tmc_id: string
    code: string
    label: string
    active: boolean
    created_at: string
  }
  fop_payment_types: {
    id: string
    tmc_id: string
    code: string
    label: string
    requires_card: boolean
    active: boolean
    created_at: string
  }
  forms_of_payment: {
    id: string
    tmc_id: string
    label: string
    fop_type: string
    payer: string
    card_type: string | null
    last4: string | null
    expiry_month: number | null
    expiry_year: number | null
    gds_alias: string | null
    branch_id: string | null
    owner_client_id: string | null
    owner_employee_id: string | null
    airline_code: string | null
    rbd_spec: string | null
    active: boolean
    notes: string | null
    created_by: string | null
    created_at: string
    updated_at: string
    fop_code: string | null
    gds_entry_id: string | null
    payment_type_id: string | null
    is_default: boolean
  }
  platform_admins: {
    user_id: string
    email: string | null
    note: string | null
    created_at: string
  }
  policy_group_band_ranks: {
    policy_group_id: string
    band_rank: number
  }
  policy_groups: {
    id: string
    name: string
    description: string | null
    created_at: string
    tmc_id: string
    code: string | null
  }
  policy_rules: {
    id: string
    client_id: string | null
    tmc_id: string | null
    band_id: string | null
    travel_type: string
    limit_key: string
    limit_value: number | null
    locked: boolean
    version: number
    updated_by: string | null
    created_at: string
    policy_group_id: string | null
    deleted_at: string | null
    band_code: string | null
    limit_bool: boolean | null
  }
  price_quotes: {
    id: string
    client_id: string
    employee_id: string
    amadeus_key: string
    reference_no: string
    pricing_key: string
    provider: string
    result_index: string | null
    airline_components: Json
    commercials: Json
    sell_total: number
    created_at: string
    expires_at: string
  }
  tmcs: {
    id: string
    name: string
    status: string
    settings: Json
    created_at: string
  }
  trip_expenses: {
    id: string
    trip_id: string
    client_id: string
    created_by: string
    expense_type: string
    amount: number
    currency: string
    description: string | null
    receipt_url: string | null
    expense_date: string | null
    created_at: string
    updated_at: string
  }
  trips: {
    id: string
    client_id: string
    created_by: string
    name: string | null
    description: string | null
    travel_date: string | null
    status: string
    created_at: string
    updated_at: string
  }
}

export interface Views {
  booking_traveller: {
    booking_id: string | null
    traveller_id: string | null
    band_id: string | null
    band_code: string | null
    band_rank: number | null
    company_id: string | null
  }
}

export type TableName = keyof Tables
export type Row<T extends TableName> = Tables[T]
export type ViewRow<V extends keyof Views> = Views[V]
