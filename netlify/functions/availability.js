// Returns real bookable slots from Square for a given service + date range.
// The Square token lives only in Netlify's env vars — never in the public page.
const SQUARE = 'https://connect.squareup.com/v2';
const VERSION = '2025-01-23';
const LOCATION = 'L7DTBF77CSBMA';   // Synergy Dominican Barbershop

exports.handler = async (event) => {
    const token = process.env.SQUARE_ACCESS_TOKEN;
    if (!token) {
        return json(500, { error: 'SQUARE_ACCESS_TOKEN is not configured' });
    }

    const { serviceVariationId, startAt, endAt, teamMemberId } = event.queryStringParameters || {};
    if (!serviceVariationId || !startAt || !endAt) {
        return json(400, { error: 'serviceVariationId, startAt and endAt are required' });
    }

    const segment = { service_variation_id: serviceVariationId };
    if (teamMemberId) segment.team_member_id_filter = { any: [teamMemberId] };

    const body = {
        query: {
            filter: {
                start_at_range: { start_at: startAt, end_at: endAt },
                location_id: LOCATION,
                segment_filters: [segment],
            },
        },
    };

    try {
        const r = await fetch(`${SQUARE}/bookings/availability/search`, {
            method: 'POST',
            headers: headers(token),
            body: JSON.stringify(body),
        });
        const data = await r.json();
        if (!r.ok) return json(r.status, { error: squareError(data) });

        // Flatten to just what the booking screen needs.
        const slots = (data.availabilities || []).map(a => ({
            startAt: a.start_at,
            teamMemberId: a.appointment_segments?.[0]?.team_member_id,
        }));
        return json(200, { slots });
    } catch (e) {
        return json(502, { error: 'Could not reach Square' });
    }
};

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
