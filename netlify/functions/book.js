// Creates the customer (if new) and the booking in Square.
// If the slot was taken between picking and confirming, Square rejects it and
// we pass that back so the booking screen can ask for another time.
const SQUARE = 'https://connect.squareup.com/v2';
const VERSION = '2025-01-23';
const LOCATION = 'L7DTBF77CSBMA';   // Synergy Dominican Barbershop

exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

    const token = process.env.SQUARE_ACCESS_TOKEN;
    if (!token) return json(500, { error: 'SQUARE_ACCESS_TOKEN is not configured' });

    let req;
    try { req = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'Bad JSON' }); }

    const { firstName, lastName, phone, email,
            serviceVariationId, teamMemberId, startAt, durationMinutes, note } = req;

    if (!firstName || !phone || !serviceVariationId || !teamMemberId || !startAt) {
        return json(400, { error: 'Missing booking details' });
    }

    try {
        // Square's CreateBooking does not reject overlaps on its own (booking_policy
        // is ACCEPT_ALL), so confirm the slot is genuinely free before taking it.
        const free = await slotIsFree(token, { serviceVariationId, teamMemberId, startAt });
        if (!free) {
            return json(409, {
                error: 'That time was just taken. Please pick another.',
                slotTaken: true,
            });
        }

        const customerId = await findOrCreateCustomer(token, { firstName, lastName, phone, email });

        const booking = {
            idempotency_key: `${teamMemberId}-${startAt}-${phone}`.slice(0, 192),
            booking: {
                location_id: LOCATION,
                start_at: startAt,
                customer_id: customerId,
                customer_note: note || '',
                appointment_segments: [{
                    team_member_id: teamMemberId,
                    service_variation_id: serviceVariationId,
                    service_variation_version: await variationVersion(token, serviceVariationId),
                    duration_minutes: Number(durationMinutes) || 30,
                }],
            },
        };

        const r = await fetch(`${SQUARE}/bookings`, {
            method: 'POST', headers: headers(token), body: JSON.stringify(booking),
        });
        const data = await r.json();

        if (!r.ok) {
            const detail = squareError(data);
            // Slot gone, or the barber is no longer free at that time.
            const taken = /not available|conflict|already|overlap/i.test(detail);
            return json(taken ? 409 : r.status, { error: detail, slotTaken: taken });
        }

        return json(200, {
            bookingId: data.booking?.id,
            startAt: data.booking?.start_at,
            status: data.booking?.status,
        });
    } catch (e) {
        return json(502, { error: e.message || 'Could not reach Square' });
    }
};

// Ask Square whether this exact barber is still free at this exact time.
async function slotIsFree(token, { serviceVariationId, teamMemberId, startAt }) {
    const start = new Date(startAt);
    const end = new Date(start.getTime() + 60 * 60 * 1000);   // 1h window around the slot
    const r = await fetch(`${SQUARE}/bookings/availability/search`, {
        method: 'POST', headers: headers(token),
        body: JSON.stringify({
            query: {
                filter: {
                    start_at_range: { start_at: start.toISOString(), end_at: end.toISOString() },
                    location_id: LOCATION,
                    segment_filters: [{
                        service_variation_id: serviceVariationId,
                        team_member_id_filter: { any: [teamMemberId] },
                    }],
                },
            },
        }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(squareError(d));

    const wanted = start.getTime();
    return (d.availabilities || []).some(a =>
        new Date(a.start_at).getTime() === wanted &&
        a.appointment_segments?.some(s => s.team_member_id === teamMemberId));
}

async function findOrCreateCustomer(token, { firstName, lastName, phone, email }) {
    const search = await fetch(`${SQUARE}/customers/search`, {
        method: 'POST', headers: headers(token),
        body: JSON.stringify({ limit: 1, query: { filter: { phone_number: { exact: phone } } } }),
    });
    const found = await search.json();
    if (found.customers?.length) return found.customers[0].id;

    const create = await fetch(`${SQUARE}/customers`, {
        method: 'POST', headers: headers(token),
        body: JSON.stringify({
            idempotency_key: `cust-${phone}`,
            given_name: firstName,
            family_name: lastName || '',
            phone_number: phone,
            ...(email ? { email_address: email } : {}),
        }),
    });
    const made = await create.json();
    if (!create.ok) throw new Error(squareError(made));
    return made.customer.id;
}

// Square requires the catalog version the price/duration came from.
async function variationVersion(token, variationId) {
    const r = await fetch(`${SQUARE}/catalog/object/${variationId}`, { headers: headers(token) });
    const d = await r.json();
    return d.object?.version;
}

const headers = (token) => ({
    'Authorization': `Bearer ${token}`,
    'Square-Version': VERSION,
    'Content-Type': 'application/json',
});

const squareError = (d) =>
    (d.errors || []).map(e => e.detail || e.code).join('; ') || 'Square request failed';

const json = (statusCode, payload) => ({
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(payload),
});
