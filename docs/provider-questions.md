# Questions for the flight provider

Open questions for the provider's team. Each says what we do today without
the answer, so nothing waits on it, and what we would change once answered.

## 1. Special meals per flight
Today we offer the 19 standard IATA special-meal codes (VGML, AVML, KSML, …)
on every full-service fare that includes a meal, and send the chosen code as
`PassengerDetails[].MealCode` on AddPassengerDetails. Not every flight loads
every code, so a traveller can ask for a meal the flight does not carry.

- Is there an endpoint that lists the special meals a given flight (or fare)
  accepts? If so: its path, request (search key, pricing key, result index?)
  and a sample response.
- Does AddPassengerDetails or Booking refuse a code the flight does not carry,
  or accept it silently?

**Until then:** the most asked-for meals are listed first, the rest under
"More options (not every flight carries these)". The ticket says "requested",
never "confirmed".

## 2. Meals on low-cost carriers
Low-cost carriers sell meals. The booking request has `SSRInfo` and
`SSRAmount`, which we send empty.

- Which endpoint lists a low-cost flight's paid meals (and baggage) with
  prices, and how are they then sent on the booking (`SSRInfo` / `SSRAmount`
  shape)?

**Until then:** no meal selector on a low-cost flight: "Meals on this airline
are sold on board or as a paid add-on, so they can't be pre-ordered here."

## 3. What `SSRDetails` says after booking
Booking, Ticket and GetBookingDetails responses carry `SSRDetails`, which we
do not read.

- What does it contain? Does it show each requested meal's status from the
  airline (for example confirmed / waitlisted / not available)? A sample
  response with a meal requested would answer this.

**Then:** the ticket would show "Meal confirmed" or "Meal not available"
instead of "requested".

## 4. The same passenger on the same flight
A booking failed on 2026-11-17: the third booking of the same passenger on the
same Air India flight was refused, after two had gone through. Our duplicate
check is a warning the booker can confirm past.

- What are the airline's rules for duplicate bookings (same name, same flight,
  same day)? Is the limit per airline, per PNR, or per provider account?
- Is there an error code that means "duplicate booking", so we can explain it
  precisely?

**Until then:** we ask "already on this flight, book again?" before calling
the airline, and explain a refusal that reads like a duplicate. No hard block.

## 5. GetBookingDetails statuses
When a booking or ticket call times out, we ask GetBookingDetails what
happened. We have seen `BookingStatus` "Ticketed" and "Failed" (with `Status`
"Failure").

- What is the full list of `BookingStatus` values (held, cancelled, pending,
  …)? Anything we don't recognise is treated as "unknown": the booking is left
  as it is and the traveller is told not to book again while the desk checks.
