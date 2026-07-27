// What the booking screen needs from Square up front: which barbers can actually
// be booked, and the service-variation id behind each service name.
const SQUARE = 'https://connect.squareup.com/v2';
const VERSION = '2025-01-23';
const LOCATION = 'L7DTBF77CSBMA';   // Synergy Dominican Barbershop

exports.handler = async () => {
    const token = process.env.SQUARE_ACCESS_TOKEN;
    if (!token) return json(500, { error: 'SQUARE_ACCESS_TOKEN is not configured' });

    try {
        const [staff, services] = await Promise.all([
            bookableStaff(token),
            appointmentServices(token),
        ]);
        return json(200, { staff, services });
    } catch (e) {
        return json(502, { error: e.message || 'Could not reach Square' });
    }
};

async function bookableStaff(token) {
    const r = await fetch(`${SQUARE}/bookings/team-member-booking-profiles?limit=100`, {
        headers: headers(token),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(squareError(d));
    return (d.team_member_booking_profiles || [])
        .filter(p => p.is_bookable)
        .map(p => ({ id: p.team_member_id, displayName: p.display_name }));
}

async function appointmentServices(token) {
    const r = await fetch(`${SQUARE}/catalog/search-catalog-items`, {
        method: 'POST', headers: headers(token),
        body: JSON.stringify({ product_types: ['APPOINTMENTS_SERVICE'], limit: 100 }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(squareError(d));

    return (d.items || []).map(item => {
        const v = item.item_data?.variations?.[0];
        return {
            name: item.item_data?.name,
            variationId: v?.id,
            minutes: Math.round((v?.item_variation_data?.service_duration || 0) / 60000),
        };
    }).filter(s => s.variationId);
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
