const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.attendance1.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { users, referrer } = req.body;
    const n = parseInt(users, 10);

    if (!n || n < 1 || n > 500) {
      return res.status(400).json({ error: '利用人数は1〜500名の範囲で入力してください。' });
    }

    const basePrice = 1980;
    const extraPrice = n > 10 ? (n - 10) * 180 : 0;
    const totalPrice = basePrice + extraPrice;

    // メタデータに紹介者メールを含める
    const metadata = {
      users: String(n),
      plan: n > 10 ? 'standard' : 'basic',
    };
    if (referrer && referrer.includes('@')) {
      metadata.referrer_email = referrer.trim().toLowerCase();
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
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
        },
      ],
      subscription_data: {
        trial_period_days: 30,
        metadata,
      },
      metadata,
      success_url: `https://www.attendance1.com/success.html?users=${n}&amount=${totalPrice}`,
      cancel_url: 'https://www.attendance1.com/#trial',
      locale: 'ja',
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: '決済の準備中にエラーが発生しました。しばらく時間をおいて再度お試しください。' });
  }
};
