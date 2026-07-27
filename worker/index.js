// Cloudflare Worker: /api/* is the Square booking bridge, everything else is a
// static file from the repo. Mirrors what the Netlify functions did.
const SQUARE = 'https://connect.squareup.com/v2';
const VERSION = '2025-01-23';
const LOCATION = 'L7DTBF77CSBMA';   // Synergy Dominican Barbershop

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        // Non-API paths normally never reach here (run_worker_first covers /api/*
        // only), but fall back to the asset server if one slips through.
        if (!url.pathname.startsWith('/api/')) {
            return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 });
        }

        const token = env.SQUARE_ACCESS_TOKEN;
        if (!token) return json(500, { error: 'SQUARE_ACCESS_TOKEN is not configured' });

        try {
            if (url.pathname === '/api/catalog')      return await catalog(token);
            if (url.pathname === '/api/availability') return await availability(token, url);
            if (url.pathname === '/api/book')         return await book(token, request);
        } catch (e) {
            return json(502, { error: e.message || 'Could not reach Square' });
        }
        return json(404, { error: 'Unknown endpoint' });
    },
};

/* ── /api/catalog ────────────────────────────────────────────────────────── */
async function catalog(token) {
    const [staffRes, itemsRes] = await Promise.all([
        sq(token, 'bookings/team-member-booking-profiles?limit=100'),
        sq(token, 'catalog/search-catalog-items', {
            product_types: ['APPOINTMENTS_SERVICE'], limit: 100,
        }),
    ]);

    const staff = (staffRes.team_member_booking_profiles || [])
        .filter(p => p.is_bookable)
        .map(p => ({ id: p.team_member_id, displayName: p.display_name }));

    const services = (itemsRes.items || []).map(item => {
        const v = item.item_data?.variations?.[0];
        return {
            name: item.item_data?.name,
            variationId: v?.id,
            minutes: Math.round((v?.item_variation_data?.service_duration || 0) / 60000),
        };
    }).filter(s => s.variationId);

    return json(200, { staff, services });
}

/* ── /api/availability ───────────────────────────────────────────────────── */
async function availability(token, url) {
    const p = url.searchParams;
    const serviceVariationId = p.get('serviceVariationId');
    const startAt = p.get('startAt');
    const endAt = p.get('endAt');
    const teamMemberId = p.get('teamMemberId');
    if (!serviceVariationId || !startAt || !endAt) {
        return json(400, { error: 'serviceVariationId, startAt and endAt are required' });
    }

    const segment = { service_variation_id: serviceVariationId };
    if (teamMemberId) segment.team_member_id_filter = { any: [teamMemberId] };

    const d = await sq(token, 'bookings/availability/search', {
        query: {
            filter: {
                start_at_range: { start_at: startAt, end_at: endAt },
                location_id: LOCATION,
                segment_filters: [segment],
            },
        },
    });

    const slots = (d.availabilities || []).map(a => ({
        startAt: a.start_at,
        teamMemberId: a.appointment_segments?.[0]?.team_member_id,
    }));
    return json(200, { slots });
}

/* ── /api/book ───────────────────────────────────────────────────────────── */
async function book(token, request) {
    if (request.method !== 'POST') return json(405, { error: 'POST only' });

    const req = await request.json().catch(() => null);
    if (!req) return json(400, { error: 'Bad JSON' });

    const { firstName, lastName, phone, email, idempotencyKey,
            serviceVariationId, teamMemberId, startAt, durationMinutes, note } = req;
    if (!firstName || !phone || !serviceVariationId || !teamMemberId || !startAt) {
        return json(400, { error: 'Missing booking details' });
    }

    // Square accepts overlapping bookings under an ACCEPT_ALL policy, so check first.
    if (!await slotIsFree(token, { serviceVariationId, teamMemberId, startAt })) {
        return json(409, { error: 'That time was just taken. Please pick another.', slotTaken: true });
    }

    const customerId = await findOrCreateCustomer(token, { firstName, lastName, phone, email });
    const variation = await sqGet(token, `catalog/object/${serviceVariationId}`);

    const res = await sqRaw(token, 'bookings', {
        idempotency_key: (idempotencyKey || crypto.randomUUID()).slice(0, 192),
        booking: {
            location_id: LOCATION,
            start_at: startAt,
            customer_id: customerId,
            customer_note: note || '',
            appointment_segments: [{
                team_member_id: teamMemberId,
                service_variation_id: serviceVariationId,
                service_variation_version: variation.object?.version,
                duration_minutes: Number(durationMinutes) || 30,
            }],
        },
    });
    const data = await res.json();

    if (!res.ok) {
        const detail = errText(data);
        const taken = /not available|conflict|already|overlap/i.test(detail);
        return json(taken ? 409 : res.status, { error: detail, slotTaken: taken });
    }
    return json(200, {
        bookingId: data.booking?.id,
        startAt: data.booking?.start_at,
        status: data.booking?.status,
    });
}

async function slotIsFree(token, { serviceVariationId, teamMemberId, startAt }) {
    const start = new Date(startAt);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const d = await sq(token, 'bookings/availability/search', {
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
    });
    const wanted = start.getTime();
    return (d.availabilities || []).some(a =>
        new Date(a.start_at).getTime() === wanted &&
        a.appointment_segments?.some(s => s.team_member_id === teamMemberId));
}

// Square matches customers on E.164 — without this every visit makes a duplicate.
function e164(raw) {
    const digits = String(raw || '').replace(/\D/g, '');
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
    return String(raw || '').startsWith('+') ? String(raw) : `+${digits}`;
}

async function findOrCreateCustomer(token, { firstName, lastName, phone, email }) {
    phone = e164(phone);
    const found = await sq(token, 'customers/search', {
        limit: 1, query: { filter: { phone_number: { exact: phone } } },
    });
    if (found.customers?.length) {
        const existing = found.customers[0];
        if (email && !existing.email_address) {
            await fetch(`${SQUARE}/customers/${existing.id}`, {
                method: 'PUT', headers: headers(token),
                body: JSON.stringify({ email_address: email }),
            }).catch(() => {});
        }
        return existing.id;
    }

    const made = await sq(token, 'customers', {
        idempotency_key: `cust-${phone}`,
        given_name: firstName,
        family_name: lastName || '',
        phone_number: phone,
        ...(email ? { email_address: email } : {}),
    });
    if (!made.customer) throw new Error(errText(made));
    return made.customer.id;
}

/* ── helpers ─────────────────────────────────────────────────────────────── */
const headers = (token) => ({
    'Authorization': `Bearer ${token}`,
    'Square-Version': VERSION,
    'Content-Type': 'application/json',
});

const sqRaw = (token, path, body) => fetch(`${SQUARE}/${path}`, {
    method: 'POST', headers: headers(token), body: JSON.stringify(body),
});

async function sq(token, path, body) {
    const r = body === undefined
        ? await fetch(`${SQUARE}/${path}`, { headers: headers(token) })
        : await sqRaw(token, path, body);
    const d = await r.json();
    if (!r.ok) throw new Error(errText(d));
    return d;
}

const sqGet = (token, path) => sq(token, path);

const errText = (d) =>
    (d.errors || []).map(e => e.detail || e.code).join('; ') || 'Square request failed';

const json = (status, payload) => new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});
