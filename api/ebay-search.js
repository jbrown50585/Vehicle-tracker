let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) return cachedToken;
  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`,
    },
    body: 'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
  });
  if (!res.ok) throw new Error('Failed to get eBay access token');
  const json = await res.json();
  cachedToken = json.access_token;
  cachedTokenExpiry = Date.now() + (json.expires_in - 60) * 1000;
  return cachedToken;
}

module.exports = async (req, res) => {
  const q = (req.query.q || '').toString().trim();
  if (!q) { res.status(400).json({ error: 'Missing search query' }); return; }
  if (!process.env.EBAY_CLIENT_ID || !process.env.EBAY_CLIENT_SECRET) {
    res.status(500).json({ error: 'eBay API is not configured yet (missing EBAY_CLIENT_ID/EBAY_CLIENT_SECRET).' });
    return;
  }
  try {
    const token = await getAccessToken();
    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(q)}&limit=8`;
    const ebayRes = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
      },
    });
    if (!ebayRes.ok) {
      const text = await ebayRes.text();
      res.status(502).json({ error: 'eBay search request failed', detail: text.slice(0, 300) });
      return;
    }
    const json = await ebayRes.json();
    const items = (json.itemSummaries || []).map((item) => ({
      title: item.title,
      price: item.price ? `$${item.price.value} ${item.price.currency}` : null,
      condition: item.condition || null,
      imageUrl: item.image ? item.image.imageUrl : null,
      itemUrl: item.itemWebUrl,
    }));
    res.status(200).json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
