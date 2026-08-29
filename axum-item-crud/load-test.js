import http from 'k6/http';
import { check } from 'k6';

// ---------------------------------------------------------------
// Config
// ---------------------------------------------------------------
// Override with: k6 run -e BASE_URL=http://localhost:3000 load-test.js
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

const JSON_HEADERS = { headers: { 'Content-Type': 'application/json' } };

export const options = {
    vus: 50,
    duration: '30s',
    // Include p99 (not just the default avg/min/med/max/p90/p95) so the
    // CI benchmark comparison can report tail latency, not just p95.
    summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
    thresholds: {
        // Overall pass/fail gate — fails the run if >1% of checks fail
        checks: ['rate>0.99'],
        // Per-endpoint latency budgets (uses the tags set below)
        'http_req_duration{name:list_items}': ['p(95)<200'],
        'http_req_duration{name:get_item}': ['p(95)<200'],
        'http_req_duration{name:create_item}': ['p(95)<200'],
        'http_req_duration{name:update_item}': ['p(95)<200'],
        'http_req_duration{name:delete_item}': ['p(95)<200'],
    },
};

// ---------------------------------------------------------------
// Each iteration runs one full CRUD cycle against its own item, so
// concurrent VUs never read/update/delete an item another VU owns.
// A plain GET /items call is included every iteration too, since
// that's the cheapest, most frequently hit endpoint in most real APIs.
// ---------------------------------------------------------------
export default function () {
    // 1. List — cheap, read-heavy background traffic
    let res = http.get(`${BASE_URL}/items`, { tags: { name: 'list_items' } });
    check(res, {
        'list: status 200': (r) => r.status === 200,
        'list: response time < 200ms': (r) => r.timings.duration < 200,
    });

    // 2. Create — exercises JSON body parsing + a DB write
    const createPayload = JSON.stringify({
        name: `Item-${__VU}-${__ITER}`,
        description: 'load test item',
        quantity: Math.floor(Math.random() * 100),
    });

    res = http.post(`${BASE_URL}/items`, createPayload, {
        headers: JSON_HEADERS.headers,
        tags: { name: 'create_item' },
    });
    const createOk = check(res, {
        'create: status 200/201': (r) => r.status === 200 || r.status === 201,
        'create: response time < 200ms': (r) => r.timings.duration < 200,
    });

    // If creation failed for some reason, don't try to chase a
    // nonexistent id through the rest of the cycle this iteration.
    if (!createOk) {
        return;
    }

    let id;
    try {
        id = res.json('id');
    } catch (e) {
        return;
    }
    if (id === undefined || id === null) {
        return;
    }

    // 3. Get the item that was just created
    res = http.get(`${BASE_URL}/items/${id}`, { tags: { name: 'get_item' } });
    check(res, {
        'get: status 200': (r) => r.status === 200,
        'get: response time < 200ms': (r) => r.timings.duration < 200,
    });

    // 4. Update it — exercises JSON body parsing + a DB write
    const updatePayload = JSON.stringify({
        quantity: Math.floor(Math.random() * 100),
    });

    res = http.put(`${BASE_URL}/items/${id}`, updatePayload, {
        headers: JSON_HEADERS.headers,
        tags: { name: 'update_item' },
    });
    check(res, {
        'update: status 200': (r) => r.status === 200,
        'update: response time < 200ms': (r) => r.timings.duration < 200,
    });

    // 5. Delete it — cleans up after itself so the table doesn't grow
    // unbounded across a long-running test
    res = http.del(`${BASE_URL}/items/${id}`, null, { tags: { name: 'delete_item' } });
    check(res, {
        'delete: status 204': (r) => r.status === 204,
        'delete: response time < 200ms': (r) => r.timings.duration < 200,
    });
}
