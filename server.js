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

// Check for required environment variables
if (!TIKTOK_PIXEL_ID) {
  console.error('❌ TIKTOK_PIXEL_ID environment variable is not set');
  process.exit(1);
}

if (!TIKTOK_ACCESS_TOKEN) {
  console.error('❌ TIKTOK_ACCESS_TOKEN environment variable is not set');
  process.exit(1);
}

if (!SHOPIFY_WEBHOOK_SECRET) {
  console.error('❌ SHOPIFY_WEBHOOK_SECRET environment variable is not set');
  process.exit(1);
}

console.log('✅ Environment variables loaded successfully');
console.log('🔑 Pixel ID:', TIKTOK_PIXEL_ID);

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

  // Get customer data with better fallbacks
  const emailHashed = sha256Lower(order.customer?.email || order.email);
  const phoneRaw = order.customer?.phone || 
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
      page: { 
        url: pageUrl || `https://${order.domain || 'yourstore.com'}/checkout/thank_you` 
      },
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

  console.log('📤 Sending payload to TikTok');
  console.log('🔑 Pixel ID:', TIKTOK_PIXEL_ID);
  console.log('📦 Order ID:', order.id);
  console.log('💰 Total Value:', totalValue, currency);
  console.log('📧 Hashed email:', emailHashed ? 'Yes' : 'No');
  console.log('📞 Hashed phone:', phoneHashed ? 'Yes' : 'No');
  console.log('🛍️ Number of items:', contents.length);

  try {
    console.log('🔄 Trying TikTok API: https://business-api.tiktok.com/open_api/v1.3/event/track/');
    
    const resp = await fetch(
      'https://business-api.tiktok.com/open_api/v1.3/event/track/',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Access-Token': TIKTOK_ACCESS_TOKEN,
        },
        body: JSON.stringify(payload),
        timeout: 15000,
      }
    );

    const responseText = await resp.text();
    console.log('📨 TikTok API Response Status:', resp.status);
    console.log('📨 TikTok API Response Body:', responseText);

    if (resp.ok) {
      try {
        const data = JSON.parse(responseText);
        if (data.code === 0) {
          console.log('🎉 Successfully sent event to TikTok!');
          return data;
        } else {
          throw new Error(`TikTok API error: ${data.message} (code: ${data.code})`);
        }
      } catch (parseError) {
        throw new Error(`Failed to parse TikTok response: ${parseError.message}`);
      }
    } else {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}. Response: ${responseText}`);
    }
  } catch (error) {
    console.error('❌ TikTok API call failed:', error.message);
    throw error;
  }
}

// --- Shopify Webhook Endpoint ---
app.post(
  '/webhooks/shopify/orders-create',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    try {
      console.log('📨 Received webhook from Shopify');
      
      if (NODE_ENV === 'production') {
        if (!verifyShopifyWebhook(req)) {
          console.error('❌ Invalid HMAC signature');
          return res.status(401).send('Invalid HMAC');
        }
        console.log('✅ HMAC verification passed');
      }

      // Parse JSON only after verifying HMAC
      const order = JSON.parse(req.body.toString('utf8'));
      console.log('✅ Received Shopify order:', order.id);
      console.log('👤 Customer email:', order.customer?.email || order.email || 'null');
      console.log('🛒 Line items:', order.line_items?.length);

      if (order.test === true) {
        console.log('ℹ️ Ignored test order');
        return res.status(200).send('Ignored test order');
      }

      await sendTikTokPurchase({
        order,
        pageUrl: order.order_status_url,
      });

      console.log('✅ Successfully processed order and sent to TikTok');
      res.status(200).send('OK');
    } catch (err) {
      console.error('🔥 Webhook error:', err.message);
      res.status(500).send('Error');
    }
  }
);

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    environment: NODE_ENV,
    pixel_id: TIKTOK_PIXEL_ID ? 'Configured' : 'Missing',
    access_token: TIKTOK_ACCESS_TOKEN ? 'Configured' : 'Missing',
    webhook_secret: SHOPIFY_WEBHOOK_SECRET ? 'Configured' : 'Missing'
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.status(200).json({ 
    message: 'TikTok Shopify Webhook Server is running',
    endpoints: {
      webhook: 'POST /webhooks/shopify/orders-create',
      health: 'GET /health'
    }
  });
});

// --- Start server ---
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`✅ Server listening on :${port}`);
  console.log(`🔑 TikTok Pixel ID: ${TIKTOK_PIXEL_ID}`);
  console.log(`🔐 Webhook Secret: ${SHOPIFY_WEBHOOK_SECRET ? 'Configured' : 'Missing'}`);
  console.log(`🌍 Environment: ${NODE_ENV || 'development'}`);
});