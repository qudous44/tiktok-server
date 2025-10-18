// server.js
import express from 'express';
import crypto from 'crypto';
import fetch from 'node-fetch';

const app = express();

// --- Middleware to capture raw body for HMAC verification ---
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf.toString(); // keep raw body for HMAC
    },
  })
);

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
    .update(req.rawBody, 'utf8')
    .digest('base64');

  // Debug logs to compare values
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
    content_id: String(
      item.product_id || item.variant_id || item.sku || item.id
    ),
    content_type: 'product',
    content_name: item.title,
    quantity: item.quantity,
    price: Number(item.price),
  }));
}

// --- Send Purchase event to TikTok ---
async function sendTikTokPurchase({ order, pageUrl }) {
  const eventId = String(order.id);
  const totalValue = Number(order.total_price);
  const currency = String(order.currency || 'PKR');

  const emailHashed = sha256Lower(order.customer?.email);
  const phoneRaw =
    order.customer?.phone ||
    order.billing_address?.phone ||
    order.shipping_address?.phone;
  const phoneHashed = sha256Lower(phoneRaw);

  const contents = mapContents(order.line_items);

  const payload = {
    pixel_code: TIKTOK_PIXEL_ID,
    event: 'Purchase',
    event_id: eventId,
    timestamp: Math.floor(Date.now() / 1000),
    context: {
      page: { url: pageUrl || 'https://yourstore.example/checkout/thank_you' },
      user: {
        external_id: emailHashed ? [emailHashed] : [],
        phone_number: phoneHashed ? [phoneHashed] : [],
      },
    },
    properties: {
      contents,
      currency,
      value: totalValue,
    },
  };

  console.log('📤 Sending payload to TikTok:', JSON.stringify(payload, null, 2));

  const resp = await fetch(
    'https://business-api.tiktokglobalshop.com/open_api/v1.3/event/track/',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': TIKTOK_ACCESS_TOKEN,
      },
      body: JSON.stringify(payload),
    }
  );

  const data = await resp.json();
  if (!resp.ok || data.code !== 0) {
    throw new Error(
      `TikTok API error: ${resp.status} ${JSON.stringify(data)}`
    );
  }
  return data;
}

// --- Shopify Webhook Endpoint ---
app.post('/webhooks/shopify/orders-create', async (req, res) => {
  try {
    if (NODE_ENV === 'production') {
      if (!verifyShopifyWebhook(req)) {
        console.error('❌ Invalid HMAC signature');
        return res.status(401).send('Invalid HMAC');
      }
    }

    const order = req.body;
    console.log('✅ Received Shopify order:', JSON.stringify(order, null, 2));

    if (order.test === true) {
      console.log('ℹ️ Ignored test order');
      return res.status(200).send('Ignored test order');
    }

    if (NODE_ENV === 'development') {
      console.log('ℹ️ Skipping TikTok call in local development');
      return res.status(200).send('OK (local test)');
    }

    await sendTikTokPurchase({
      order,
      pageUrl: order.order_status_url,
    });

    res.status(200).send('OK');
  } catch (err) {
    console.error('🔥 Webhook error:', err);
    res.status(500).send('Error');
  }
});

// --- Start server ---
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`✅ Server listening on :${port}`));
