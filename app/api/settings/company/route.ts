import { requireUser } from '@/app/lib/auth/session'
import { db } from '@/app/lib/db'
import { route } from '@/app/lib/http/handler'
import * as employees from '@/app/lib/repositories/employees'
import * as clients from '@/app/lib/repositories/clients'
import * as tmcs from '@/app/lib/repositories/tmcs'
import * as dashboard from '@/app/lib/repositories/dashboard'

// ── GET /api/settings/company ────────────────────────────────────────────────
// The company admin's overview of their own company: its profile, how it books
// and approves, its refund rule, its people and this month's travel. Read-only:
// the travel desk configures clients, and the page says to ask them.
//
// A SAFE SUBSET of the client record, chosen field by field: never the
// commercial switches (markup, discount, processing fee), the payment-method
// internals, SAP codes or anything else that is the TMC's own business.
// Figures are the sell side only (what the company pays).
// ─────────────────────────────────────────────────────────────────────────────

export const GET = route(async () => {
  const user = await requireUser()
  const caller = await employees.clientScope(db, user.id)
  if (!caller) return Response.json({ error: 'Employee record not found' }, { status: 404 })
  if (caller.role !== 'admin' || !caller.client_id) {
    return Response.json({ error: 'Only your company’s admins can see this' }, { status: 403 })
  }
  const clientId = caller.client_id
  const tenancy = await clients.tenancy(db, clientId)
  if (!tenancy?.tmc_id) return Response.json({ error: 'Company not found' }, { status: 404 })

  const [c, gst, people, figures, centres, tmc] = await Promise.all([
    clients.settings(db, clientId, tenancy.tmc_id),
    clients.gstRegistrations(db, clientId),
    employees.companyPeople(db, clientId),
    dashboard.companyFigures(db, clientId),
    clients.costCentres(db, clientId),
    tmcs.tmcName(db, tenancy.tmc_id),
  ])
  if (!c) return Response.json({ error: 'Company not found' }, { status: 404 })
  const branch = c.branch_id ? await tmcs.branch(db, c.branch_id) : null
  const primaryGst = gst.find(g => g.is_primary) ?? gst[0] ?? null

  return Response.json({
    ok: true,
    travelDesk: { name: tmc?.name ?? null, branch: branch ? { name: branch.name, city: branch.gst_city ?? null } : null },
    profile: {
      name: c.name, code: c.client_code, status: c.status, industry: c.industry, size: c.size,
      email: c.email, phone: c.phone ?? c.primary_contact_phone,
      address: [c.address_1, c.address_2, c.city, c.state, c.pincode, c.country].filter(Boolean).join(', ') || null,
      timezone: c.timezone, currency: c.currency, bookingMode: c.booking_mode,
      gstin: primaryGst ? { gstin: primaryGst.gstin, state: primaryGst.state ?? null, registrations: gst.length } : null,
    },
    booking: {
      bookingActivation: c.booking_activation, holdActivation: c.hold_activation,
      domesticTicketing: c.dom_ticketing, internationalTicketing: c.intl_ticketing,
      policyControlling: c.policy_controlling,
      personalTrips: c.personal_bookings_allowed, guestBookings: c.guest_bookings_allowed,
      outOfPolicy: c.out_of_policy_handling, reasonRequired: c.out_of_policy_reason_required,
      duplicateCheck: c.duplicate_booking_check,
      fareRiseReapproval: c.fare_rise_reapproval === null ? null : { amount: c.fare_rise_reapproval, unit: c.fare_rise_reapproval_unit },
    },
    approvals: {
      air: c.air_approval_mode, hotel: c.hotel_approval_mode, trip: c.trip_approval_mode,
      withinPolicy: c.within_policy_approval, escalationHours: c.approval_escalation_hours,
    },
    refunds: {
      markupRefunded: c.refund_markup, feeRefunded: c.refund_processing_fee,
      cancellationFee: c.tmc_cancellation_fee === null ? null : { amount: c.tmc_cancellation_fee, unit: c.tmc_cancellation_fee_unit },
      gstRate: c.gst_rate,
    },
    people: { ...people, costCentres: centres.length },
    figures,
  })
})
