// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import http from 'k6/http'
import { sleep } from 'k6'
import { browser } from 'k6/browser'
import { Tracer } from 'k6/x/otel'

const BASE_URL = __ENV.K6_TARGET_URL || 'http://frontend-proxy:8080'
const FLAGD_HOST = __ENV.FLAGD_HOST || 'flagd'
const FLAGD_OFREP_PORT = __ENV.FLAGD_OFREP_PORT || '8016'

// The HTTP scenario's VU count is read from LOAD_GENERATOR_VUS rather than
// k6's own K6_VUS, since a K6_VUS env var makes k6 discard this script's
// scenarios config entirely in favor of an implicit single scenario (see
// README.md). The browser scenario runs a single headless browser session
// alongside the HTTP traffic; it stays opt-in via K6_BROWSER_ENABLED.
const browserEnabled = (__ENV.K6_BROWSER_ENABLED || '').toLowerCase() === 'true'

export const options = {
    scenarios: {
        load: {
            executor: 'constant-vus',
            exec: 'httpScenario',
            vus: parseInt(__ENV.LOAD_GENERATOR_VUS || '10'),
            duration: __ENV.K6_DURATION || '9999h',
        },
        ...(browserEnabled ? {
            browser: {
                executor: 'constant-vus',
                exec: 'browserScenario',
                vus: 1,
                duration: __ENV.K6_DURATION || '9999h',
                options: {
                    browser: {
                        type: 'chromium',
                        headless: true,
                        // executablePath/args come from env vars, not this field - see README.md.
                    },
                },
            },
        } : {}),
    },
}

const products = [
    '0PUK6V6EV0', '1YMWWN1N4O', '2ZYFJ3GM2N', '66VCHSJNUP', '6E92ZMYYFZ',
    '9SIQT8TOJO', 'L9ECAV7KIM', 'LS4PSXUNUM', 'OLJCESPC7Z', 'HQTGWGPNH4',
]

const categories = ['binoculars', 'telescopes', 'accessories', 'assembly', 'travel', 'books', null]

const people = JSON.parse(open('./people.json'))

const tracer = new Tracer()

// ---- helpers ----------------------------------------------------------------

// Uses a Uint8Array rather than Uint32Array(1): k6's crypto.getRandomValues
// only randomizes `buf.length` bytes, not `buf.byteLength`, so a Uint32Array(1)
// gets just 1 random byte with the upper 3 left as zero.
function cryptoRandom() {
    const buf = new Uint8Array(4)
    crypto.getRandomValues(buf)
    const val = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0
    return val / 0x100000000
}

function randomChoice(arr) {
    return arr[Math.floor(cryptoRandom() * arr.length)]
}

function uuid4() {
    return crypto.randomUUID()
}

// getFlagdValue mirrors Locust's TracingHook: each flag evaluation gets its
// own OTel span so flag-driven behaviour is visible in traces.
function getFlagdValue(flagName) {
    const span = tracer.startSpan('feature_flag.evaluate', { 'feature_flag.key': flagName })
    const res = http.post(
        `http://${FLAGD_HOST}:${FLAGD_OFREP_PORT}/ofrep/v1/evaluate/flags/${flagName}`,
        JSON.stringify({}),
        { headers: otelHeaders(span.traceParent(), { 'Content-Type': 'application/json' }), tags: { flagd: 'true' } }
    )
    let value = 0
    if (res.status === 200) {
        value = JSON.parse(res.body).value || 0
    }
    span.log(`Feature flag ${flagName} evaluated to ${value}`)
    span.end()
    return value
}

// Merges OTel headers (baggage + traceparent) with any extra headers provided.
function otelHeaders(traceParent, extra) {
    return Object.assign(
        {
            baggage: `synthetic_request=true,session.id=${sessionId}`,
            traceparent: traceParent,
        },
        extra
    )
}

// ---- per-VU session state ---------------------------------------------------

let sessionId = null

function onStart() {
    sessionId = uuid4()
    const span = tracer.startSpan('user_session_start')
    span.log(`Starting user session: ${sessionId}`)
    http.get(`${BASE_URL}/`, { headers: otelHeaders(span.traceParent()) })
    span.end()
}

// ---- tasks ------------------------------------------------------------------

function index() {
    const span = tracer.startSpan('user_index')
    span.log('User accessing index page')
    http.get(`${BASE_URL}/`, { headers: otelHeaders(span.traceParent()) })
    span.end()
}

function browseProduct() {
    const product = randomChoice(products)
    const span = tracer.startSpan('user_browse_product', { 'product.id': product })
    span.log(`User browsing product: ${product}`)
    http.get(`${BASE_URL}/api/products/${product}`, { headers: otelHeaders(span.traceParent()) })
    span.end()
}

function getRecommendations() {
    const product = randomChoice(products)
    const span = tracer.startSpan('user_get_recommendations', { 'product.id': product })
    span.log(`User getting recommendations for product: ${product}`)
    http.get(
        `${BASE_URL}/api/recommendations?productIds=${product}`,
        { headers: otelHeaders(span.traceParent()) }
    )
    span.end()
}

function getAds() {
    const category = randomChoice(categories)
    const span = tracer.startSpan('user_get_ads', { category: String(category) })
    span.log(`User getting ads for category: ${category}`)
    // When category is null, Locust sends contextKeys=None (Python str(None)).
    const url = category !== null
        ? `${BASE_URL}/api/data/?contextKeys=${category}`
        : `${BASE_URL}/api/data/?contextKeys=None`
    http.get(url, { headers: otelHeaders(span.traceParent()) })
    span.end()
}

function viewCart() {
    const span = tracer.startSpan('user_view_cart')
    span.log('User viewing cart')
    http.get(`${BASE_URL}/api/cart`, { headers: otelHeaders(span.traceParent()) })
    span.end()
}

function addToCart(user) {
    if (!user) user = uuid4()
    const product = randomChoice(products)
    const quantity = randomChoice([1, 2, 3, 4, 5, 10])
    const span = tracer.startSpan(
        'user_add_to_cart',
        { 'user.id': user, 'product.id': product, quantity }
    )
    span.log(`User ${user} adding ${quantity} of product ${product} to cart`)
    const h = otelHeaders(span.traceParent())
    http.get(`${BASE_URL}/api/products/${product}`, { headers: h })
    http.post(
        `${BASE_URL}/api/cart`,
        JSON.stringify({ item: { productId: product, quantity }, userId: user }),
        { headers: otelHeaders(span.traceParent(), { 'Content-Type': 'application/json' }) }
    )
    span.end()
}

function checkout() {
    const user = uuid4()
    const span = tracer.startSpan('user_checkout_single', { 'user.id': user })
    span.log(`Starting checkout for user ${user}`)

    addToCart(user)

    http.post(
        `${BASE_URL}/api/checkout`,
        JSON.stringify(Object.assign({}, randomChoice(people), { userId: user })),
        { headers: otelHeaders(span.traceParent(), { 'Content-Type': 'application/json' }) }
    )
    span.log(`Checkout completed for user ${user}`)
    span.end()
}

function checkoutMulti() {
    const user = uuid4()
    const itemCount = randomChoice([2, 3, 4])
    const span = tracer.startSpan('user_checkout_multi', { 'user.id': user, 'item.count': itemCount })
    span.log(`Starting multi-item checkout for user ${user}, ${itemCount} items`)

    for (let i = 0; i < itemCount; i++) {
        addToCart(user)
    }

    http.post(
        `${BASE_URL}/api/checkout`,
        JSON.stringify(Object.assign({}, randomChoice(people), { userId: user })),
        { headers: otelHeaders(span.traceParent(), { 'Content-Type': 'application/json' }) }
    )
    span.log(`Multi-item checkout completed for user ${user}`)
    span.end()
}

function floodHome() {
    const floodCount = getFlagdValue('loadGeneratorFloodHomepage')
    if (floodCount <= 0) return

    const span = tracer.startSpan('user_flood_home', { 'flood.count': floodCount })
    span.log(`User flooding homepage ${floodCount} times`)
    const h = otelHeaders(span.traceParent())
    for (let i = 0; i < floodCount; i++) {
        http.get(`${BASE_URL}/`, { headers: h })
    }
    span.end()
}

// ---- weighted task selection ------------------------------------------------
// Task weights: index(1) browse(10) recs(3) ads(3) cart(3) add(2)
// checkout(1) checkout_multi(1) flood(5) = 29

const weightedTasks = [
    { cumWeight:  1, task: index },
    { cumWeight: 11, task: browseProduct },
    { cumWeight: 14, task: getRecommendations },
    { cumWeight: 17, task: getAds },
    { cumWeight: 20, task: viewCart },
    { cumWeight: 22, task: addToCart },
    { cumWeight: 23, task: checkout },
    { cumWeight: 24, task: checkoutMulti },
    { cumWeight: 29, task: floodHome },
]

function selectTask() {
    const r = cryptoRandom() * 29
    for (const { cumWeight, task } of weightedTasks) {
        if (r < cumWeight) return task
    }
    return weightedTasks[weightedTasks.length - 1].task
}

// ---- HTTP entrypoint --------------------------------------------------------

export function httpScenario() {
    if (getFlagdValue('loadGeneratorTraffic') <= 0) {
        sleep(cryptoRandom() * 9 + 1)
        return
    }

    if (sessionId === null) {
        onStart()
    }

    selectTask()()

    sleep(cryptoRandom() * 9 + 1)  // mirrors Locust between(1, 10)
}

// ---- browser tasks ----------------------------------------------------------

// Session replay records what the DOM and the pointer actually did. A script
// that only calls page.click() produces a recording of jump cuts: elements
// change with no cursor anywhere near them, and nothing looks like a person.
// The helpers below exist so the replay is watchable — they move the pointer
// along a path, pause the way a reader does, and scroll before deciding.
//
// Every one of them degrades to a no-op if the underlying browser API is
// missing. Cursor decoration must never be the reason the load generator
// stops producing traffic.

const viewport = { width: 1280, height: 800 }

// Ease-in-out: people accelerate away from where they were and decelerate
// into a target. Linear interpolation reads as robotic even at the right speed.
function ease(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
}

let cursor = { x: viewport.width / 2, y: viewport.height / 2 }

async function moveCursorTo(page, x, y, steps = 18) {
    try {
        const from = cursor
        for (let i = 1; i <= steps; i++) {
            const t = ease(i / steps)
            // A slight arc; a perfectly straight line is another robot tell.
            const drift = Math.sin(t * Math.PI) * 14 * (cryptoRandom() - 0.5)
            await page.mouse.move(from.x + (x - from.x) * t + drift, from.y + (y - from.y) * t + drift)
            await page.waitForTimeout(8 + cryptoRandom() * 12)
        }
        cursor = { x, y }
    } catch (e) {
        // No mouse API — the click still happens, just without the travel.
    }
}

// Move to an element's centre, pause as if reading it, then click it there.
// Falls back to a plain click so a selector that resolves but has no box
// (display:contents, zero-size wrapper) still advances the journey.
async function moveAndClick(page, selector) {
    try {
        const el = await page.$(selector)
        const box = el && (await el.boundingBox())
        if (box) {
            await moveCursorTo(page, box.x + box.width / 2, box.y + box.height / 2)
            await page.waitForTimeout(200 + cryptoRandom() * 500)
        }
    } catch (e) {
        // fall through to the plain click
    }
    await page.click(selector)
}

// Scroll in a few short bursts rather than one jump, pausing between them.
// The pauses are what a replay actually shows: a session that scrolls through
// a page in 300ms reads as a script no matter how smooth the cursor is.
async function readPage(page, bursts = 3) {
    for (let i = 0; i < bursts; i++) {
        try {
            await page.mouse.wheel({ deltaY: 220 + cryptoRandom() * 380 })
        } catch (e) {
            break
        }
        await page.waitForTimeout(1200 + cryptoRandom() * 2000)
        // Drifting the pointer while reading is what a real cursor does.
        await moveCursorTo(
            page,
            120 + cryptoRandom() * (viewport.width - 240),
            160 + cryptoRandom() * (viewport.height - 320),
            8
        )
    }
}

// Hover a few product tiles before committing to one — the browsing that makes
// a replay look like shopping rather than a scripted click-through.
async function browseProducts(page, count = 3) {
    for (let i = 0; i < count; i++) {
        const id = products[Math.floor(cryptoRandom() * products.length)]
        try {
            const el = await page.$(`a[href="/product/${id}"]`)
            const box = el && (await el.boundingBox())
            if (!box) continue
            await moveCursorTo(page, box.x + box.width / 2, box.y + box.height / 2, 12)
            await page.waitForTimeout(900 + cryptoRandom() * 1600)
        } catch (e) {
            continue
        }
    }
}

async function changeCurrency(page) {
    await page.goto(`${BASE_URL}/cart`, { waitUntil: 'domcontentloaded' })
    await readPage(page, 1)
    await moveCursorTo(page, viewport.width - 220, 90)
    await page.selectOption('[name="currency_code"]', 'CHF')
    await page.waitForTimeout(2000)
}

async function addProductToCartBrowser(page) {
    // Roof Binoculars (2ZYFJ3GM2N). Selects by href / data-cy rather than
    // :has-text(), which k6 browser's native CSS engine does not support
    // (it forwards selectors straight to document.querySelectorAll, unlike
    // Playwright's own selector engine).
    //
    // The imageSlowLoad flagd flag delays every product image fetch by up to
    // 10s. The homepage isn't actually hydrated/interactive until that
    // thumbnail request resolves, so a click fired before it lands never
    // reaches the Next.js router and the SPA navigation silently no-ops.
    // Gate the click on that response, mirroring the pre-click
    // wait_for_event in the pre-k6 (Locust) fix for this same flag (#3171).
    await Promise.all([
        page.waitForResponse(/\/images\/products\/RoofBinoculars\.jpg/, { timeout: 25000 }),
        page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' }),
    ])
    await page.waitForSelector('a[href="/product/2ZYFJ3GM2N"]', { timeout: 15000 })
    await readPage(page, 2)
    await browseProducts(page, 3)
    await moveAndClick(page, 'a[href="/product/2ZYFJ3GM2N"]')
    // The product-link click is a client-side (SPA/pushState) route change, not
    // a full navigation - domcontentloaded already fired once for the initial
    // page load and never fires again for this transition. waitForLoadState
    // here is a no-op that resolves instantly, before React has rendered the
    // new route, so the add-to-cart click below never finds its target. Wait
    // for the actual element instead - correct for both SPA and full navigation.
    await page.waitForSelector('[data-cy="product-add-to-cart"]', { timeout: 25000 })
    // Read the product page before adding it — the pause is the difference
    // between a replay that looks like shopping and one that looks like a bot.
    await readPage(page, 2)
    await moveAndClick(page, '[data-cy="product-add-to-cart"]')
    await page.waitForTimeout(2000)
}

// The full funnel: land, browse, open a product, add it, review the cart and
// place the order. This is the journey worth opening a replay to watch, and
// the one that produces an end-to-end trace across frontend, cart, checkout,
// payment, shipping and email.
async function checkoutJourney(page) {
    // Same hydration gate as addProductToCartBrowser: the homepage is not
    // interactive until a product thumbnail resolves, so a click fired before
    // that never reaches the Next.js router.
    //
    // But it is registered as a soft gate rather than awaited in a
    // Promise.all. Any product image satisfies it, and a browser-level cache
    // hit or a slow flag means no matching response event ever fires — in
    // which case Promise.all rejects and the whole journey is abandoned after
    // 25s of nothing. That produced 10-second recordings where a full funnel
    // should have been. waitForSelector below is the real precondition; this
    // just gives hydration a chance to happen first.
    const hydrated = page
        .waitForResponse(/\/images\/products\//, { timeout: 20000 })
        .catch(() => {})
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' })
    await hydrated
    await readPage(page, 2)
    await browseProducts(page, 4)

    const id = products[Math.floor(cryptoRandom() * products.length)]
    await page.waitForSelector(`a[href="/product/${id}"]`, { timeout: 15000 })
    await moveAndClick(page, `a[href="/product/${id}"]`)

    await page.waitForSelector('[data-cy="product-add-to-cart"]', { timeout: 25000 })
    await readPage(page, 3)
    await moveAndClick(page, '[data-cy="product-add-to-cart"]')

    // Adding to cart lands on the cart page already; give it a beat to render.
    await page.waitForTimeout(1500 + cryptoRandom() * 1500)
    await readPage(page, 3)

    // Second lap: go back and look at another product before deciding. Real
    // carts get built over more than one page view, and it doubles the length
    // of the recording without inventing behaviour nobody does.
    if (cryptoRandom() < 0.5) {
        const second = products[Math.floor(cryptoRandom() * products.length)]
        try {
            await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' })
            await readPage(page, 2)
            await browseProducts(page, 3)
            await page.waitForSelector(`a[href="/product/${second}"]`, { timeout: 15000 })
            await moveAndClick(page, `a[href="/product/${second}"]`)
            await page.waitForSelector('[data-cy="product-add-to-cart"]', { timeout: 25000 })
            await readPage(page, 2)
            await moveAndClick(page, '[data-cy="product-add-to-cart"]')
            await page.waitForTimeout(1500 + cryptoRandom() * 1500)
        } catch (e) {
            // One product in the cart is still a complete session.
        }
    }

    // Not every visit converts. A demo where every session ends in a purchase
    // has no funnel to show, and the abandoned ones are the interesting half.
    if (cryptoRandom() < 0.35) return

    try {
        await page.waitForSelector('[data-cy="checkout-place-order"]', { timeout: 15000 })
        await moveAndClick(page, '[data-cy="checkout-place-order"]')
        await page.waitForTimeout(3000)
        await readPage(page, 1)
    } catch (e) {
        // The place-order control moves between demo versions; an abandoned
        // cart is a perfectly good session, so this is not an error.
    }
}

// ---- browser entrypoint -----------------------------------------------------

export async function browserScenario() {
    if (getFlagdValue('loadGeneratorTraffic') <= 0) {
        sleep(cryptoRandom() * 9 + 1)
        return
    }

    const page = await browser.newPage()
    // A viewport the replay player can show at a sensible size, and one the
    // cursor helpers can aim inside of.
    try {
        await page.setViewportSize(viewport)
    } catch (e) {
        // older k6 browser builds; the defaults are close enough
    }
    cursor = { x: viewport.width / 2, y: viewport.height / 2 }

    // Weighted so most sessions are the full funnel — that is the one worth
    // watching — while the shorter flows keep the traffic mix varied.
    const roll = cryptoRandom()
    const flow = roll < 0.6 ? 'checkout' : roll < 0.8 ? 'add_to_cart' : 'change_currency'
    const span = tracer.startSpan(`browser_${flow}`)
    try {
        await page.setExtraHTTPHeaders({ baggage: 'synthetic_request=true' })
        if (flow === 'checkout') {
            span.log('Completed a browsing and checkout journey')
            await checkoutJourney(page)
        } else if (flow === 'add_to_cart') {
            span.log('Product added to cart successfully')
            await addProductToCartBrowser(page)
        } else {
            span.log('Currency changed to CHF')
            await changeCurrency(page)
        }
    } catch (e) {
        console.error(`browser task error: ${e}`)
    } finally {
        span.end()
        // Give the Monoscope replay recorder time to flush the tail of the
        // session before the page goes away. Without this the last few seconds
        // of every recording — usually the interesting part — never upload.
        await page.waitForTimeout(3000)
        await page.close()
    }

    sleep(cryptoRandom() * 9 + 1)
}
