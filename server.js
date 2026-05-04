// server.js
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';

const app = express();

// --- Environment variables ---
const {
    TIKTOK_PIXEL_ID,
    TIKTOK_ACCESS_TOKEN,
    SHOPIFY_WEBHOOK_SECRET,
    NODE_ENV,
} = process.env;

// --- Verify Shopify HMAC ---
function verifyShopifyWebhook(req) {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    if (!hmacHeader) return false;
    const digest = crypto
      .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
      .update(req.body)
      .digest('base64');
    console.log('🔐 Shopify HMAC header:', hmacHeader);
    console.log('🔐 Calculated digest:', digest);
    try {
          return crypto.timingSafeEqual(
                  Buffer.from(digest, 'utf8'),
                  Buffer.from(hmacHeader, 'utf8')
                );
    } catch {
          return false;
    }
}

// --- Hash helper ---
function sha256Lower(value) {
    if (!value) return null;
    return crypto
      .createHash('sha256')
      .update(String(value).trim().toLowerCase())
      .digest('hex');
}

// --- Map Shopify line items to TikTok contents ---
function mapContents(line_items) {
    return (line_items || []).map((item) => ({
          content_id: String(item.product_id || item.variant_id || item.sku || item.id),
          content_type: 'product',
          content_name: item.title,
          quantity: item.quantity,
          price: Number(item.price),
    }));
}

// --- Build TikTok user context from order ---
function buildUserContext(order) {
    const emailHashed = sha256Lower(order.customer?.email || order.email);
    const phoneRaw =
          order.customer?.phone ||
          order.billing_address?.phone ||
          order.shipping_address?.phone;
    const phoneHashed = sha256Lower(phoneRaw);
    return { emailHashed, phoneHashed };
}

// --- Send event to TikTok Events API ---
async function sendTikTokEvent({ eventName, order, pageUrl, extraProps = {} }) {
    // 1. If it's a Purchase, match the Browser Pixel exact Order ID.
    // 2. For CompletePayment/Cancelled, use a prefix so it deduplicates against itself.
    const eventId = eventName === 'Purchase' ? String(order.id) : `${eventName}_${order.id}`;
    const { emailHashed, phoneHashed } = buildUserContext(order);
    const contents = mapContents(order.line_items);
    const contentIds = (order.line_items || []).map((item) =>
          String(item.product_id || item.variant_id || item.sku || item.id)
                                                      );
    const totalValue = Number(order.total_price);
    const currency = String(order.currency || 'PKR');

  const payload = {
        event: eventName,
        event_id: eventId,
        event_time: Math.floor(Date.now() / 1000),
        context: {
                page: {
                          url: pageUrl || `https://${order.domain || 'gulshanefashion.com'}/checkout/thank_you`,
                },
                user: {
                          external_id: emailHashed ? [emailHashed] : [],
                          phone: phoneHashed ? [phoneHashed] : [],
                },
                user_agent: order.client_details?.user_agent || '',
                ip: order.browser_ip || '',
        },
        properties: {
                content_id: contentIds,
                content_type: 'product',
                contents: contents,
                currency: currency,
                value: totalValue,
                content_category: order.line_items?.[0]?.product_type || 'fashion',
                ...extraProps,
        },
  };

  const batchPayload = {
        event_source: 'web',
        event_source_id: TIKTOK_PIXEL_ID,
        data: [payload],
  };

  console.log(`📤 Sending [${eventName}] to TikTok`);
    console.log('🔑 Pixel ID:', TIKTOK_PIXEL_ID);
    console.log('📦 Order ID:', order.id);
    console.log('💰 Total Value:', totalValue, currency);
    console.log('📧 Hashed email:', emailHashed ? 'Yes' : 'No');
    console.log('📞 Hashed phone:', phoneHashed ? 'Yes' : 'No');

  const resp = await fetch('https://business-api.tiktok.com/open_api/v1.3/event/track/', {
        method: 'POST',
        headers: {
                'Content-Type': 'application/json',
                'Access-Token': TIKTOK_ACCESS_TOKEN,
        },
        body: JSON.stringify(batchPayload),
        timeout: 15000,
  });

  const responseText = await resp.text();
    console.log('📨 TikTok API Response Status:', resp.status);
    console.log('📨 TikTok API Response Body:', responseText);

  if (resp.ok) {
        const data = JSON.parse(responseText);
        if (data.code === 0) {
                console.log(`🎉 Successfully sent [${eventName}] to TikTok!`);
                return data;
        } else {
                throw new Error(`TikTok API error: ${data.message} (code: ${data.code})`);
        }
  } else {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}. Response: ${responseText}`);
  }
}

// --- Shared webhook parser middleware ---
const rawBodyMiddleware = express.raw({ type: 'application/json' });

// --- Helper: verify + parse webhook ---
function parseWebhook(req, res) {
    if (NODE_ENV === 'production') {
          if (!verifyShopifyWebhook(req)) {
                  console.error('❌ Invalid HMAC signature');
                  res.status(401).send('Invalid HMAC');
                  return null;
          }
          console.log('✅ HMAC verification passed');
    }
    return JSON.parse(req.body.toString('utf8'));
}

// ============================================================
// WEBHOOK 1: orders/create → Send Purchase event
// ============================================================
app.post('/webhooks/shopify/orders-create', rawBodyMiddleware, async (req, res) => {
    try {
          console.log('📨 [orders/create] Received webhook');
          const order = parseWebhook(req, res);
          if (!order) return;

      console.log('✅ Order ID:', order.id);

      if (order.test === true) {
              console.log('ℹ️ Ignored test order');
              return res.status(200).send('Ignored test order');
      }

      if (order.cancelled_at || order.financial_status === 'refunded') {
              console.log('ℹ️ Ignored cancelled/refunded order at creation');
              return res.status(200).send('Ignored cancelled order');
      }

      await sendTikTokEvent({
              eventName: 'Purchase',
              order,
              pageUrl: order.order_status_url,
      });

      console.log('✅ Purchase event sent successfully');
          res.status(200).send('OK');
    } catch (err) {
          console.error('🔥 orders/create error:', err.message);
          res.status(500).send('Error');
    }
});

// ============================================================
// WEBHOOK 2: orders/updated → Watch for confirmed / cancelled tags
// ============================================================
app.post('/webhooks/shopify/orders-updated', rawBodyMiddleware, async (req, res) => {
    try {
          console.log('📨 [orders/updated] Received webhook');
          const order = parseWebhook(req, res);
          if (!order) return;

      console.log('✅ Order ID:', order.id);
          console.log('🏷️ Tags:', order.tags || '(none)');

      if (order.test === true) {
              console.log('ℹ️ Ignored test order');
              return res.status(200).send('Ignored test order');
      }

      const tags = (order.tags || '').toLowerCase().split(',').map((t) => t.trim());

      // --- CONFIRMED tag: tell TikTok this is a real verified order ---
      if (tags.includes('confirmed')) {
              console.log('✅ Tag [confirmed] found → Sending CompletePayment event');
              await sendTikTokEvent({
                        eventName: 'CompletePayment',
                        order,
                        pageUrl: order.order_status_url,
                        extraProps: {
                                    order_tag: 'confirmed',
                        },
              });
              console.log('🎉 CompletePayment event sent for confirmed order');
      }

      // --- CANCELLED tag: tell TikTok this order was cancelled (low quality signal) ---
      if (tags.includes('cancelled')) {
              console.log('🚫 Tag [cancelled] found → Sending CancelledOrder custom event');
              // We use a custom event name - TikTok will log it under "Other" events
            // This helps with negative audience signals
            await sendTikTokEvent({
                      eventName: 'CancelledOrder',
                      order,
                      pageUrl: order.order_status_url,
                      extraProps: {
                                  order_tag: 'cancelled',
                      },
            });
              console.log('📋 CancelledOrder event sent');
      }

      if (!tags.includes('confirmed') && !tags.includes('cancelled')) {
              console.log('ℹ️ No confirmed/cancelled tag found — skipping');
      }

      res.status(200).send('OK');
    } catch (err) {
          console.error('🔥 orders/updated error:', err.message);
          res.status(500).send('Error');
    }
});

// --- Health check ---
app.get('/health', (req, res) => {
    res.status(200).json({
          status: 'OK',
          timestamp: new Date().toISOString(),
          environment: NODE_ENV,
          pixel_id: TIKTOK_PIXEL_ID ? 'Configured' : 'Missing',
          access_token: TIKTOK_ACCESS_TOKEN ? 'Configured' : 'Missing',
          webhook_secret: SHOPIFY_WEBHOOK_SECRET ? 'Configured' : 'Missing',
    });
});

// --- Root ---
app.get('/', (req, res) => {
    res.status(200).json({
          message: 'TikTok Shopify Webhook Server is running',
          version: '3.0 - Confirmed/Cancelled Tag Events',
          endpoints: {
                  orders_create: 'POST /webhooks/shopify/orders-create',
                  orders_updated: 'POST /webhooks/shopify/orders-updated',
                  health: 'GET /health',
          },
    });
});

// --- Start server ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`✅ Server listening on :${port}`);
    console.log(`🔑 TikTok Pixel ID: ${TIKTOK_PIXEL_ID}`);
    console.log(`🔐 Webhook Secret: ${SHOPIFY_WEBHOOK_SECRET ? 'Configured' : 'Missing'}`);
    console.log(`🌍 Environment: ${NODE_ENV || 'development'}`);
    console.log(`🚀 Version: 3.0 - Confirmed/Cancelled Tag Events`);
});
