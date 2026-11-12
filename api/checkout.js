const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { users, referrer, companyId, companyName, adminEmail } = req.body;
    const n = parseInt(users, 10) || 1;

    // 企業IDを正規化（何が来ても動く）
    const normalizedId = (companyId || 'company')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9\-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '') || 'company';

    // 料金計算
    const basePrice = 1980;
    const extraPrice = n > 10 ? (n - 10) * 180 : 0;
    const totalPrice = basePrice + extraPrice;

    // metadata
    const metadata = {
      users: String(n),
      companyId: normalizedId,
      companyName: (companyName || normalizedId).toString().trim(),
      adminEmail: (adminEmail || '').toString().trim().toLowerCase(),
      plan: n > 10 ? 'standard' : 'basic',
    };
    if (referrer && String(referrer).includes('@')) {
      metadata.referrer_email = String(referrer).trim().toLowerCase();
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: metadata.adminEmail || undefined,
      line_items: [{
        price_data: {
          currency: 'jpy',
          recurring: { interval: 'month' },
          unit_amount: totalPrice,
          product_data: {
            name: `Attendance 月額プラン（${n}名）`,
            description: n > 10
              ? `基本料金1,980円 ＋ 追加${n - 10}名 × 180円`
              : '10名まで定額プラン',
          },
        },
        quantity: 1,
      }],
      subscription_data: {
        trial_period_days: 30,
        metadata,
      },
      metadata,
      success_url: `https://www.attendance1.com/success.html?users=${n}&amount=${totalPrice}&company=${encodeURIComponent(metadata.companyName)}&companyId=${normalizedId}`,
      cancel_url: 'https://www.attendance1.com/#trial',
      locale: 'ja',
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
