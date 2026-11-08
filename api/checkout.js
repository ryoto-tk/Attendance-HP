const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Firebase Admin SDK初期化（冪等）
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', 'https://www.attendance1.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { users, referrer, companyId, companyName, adminEmail } = req.body;
    const n = parseInt(users, 10);

    // バリデーション
    if (!n || n < 1 || n > 500)
      return res.status(400).json({ error: '利用人数は1〜500名の範囲で入力してください。' });
    if (!companyId || !/^[a-z0-9\-]+$/.test(companyId))
      return res.status(400).json({ error: '企業IDは小文字英数字・ハイフンのみです。' });
    if (!companyName?.trim())
      return res.status(400).json({ error: '企業名を入力してください。' });
    if (!adminEmail?.includes('@'))
      return res.status(400).json({ error: '管理者メールアドレスを入力してください。' });

    // checkOnlyモード（フロントのリアルタイムチェック用）
    if (req.body.checkOnly) {
      const snap = await db.collection('companies').doc(companyId).get();
      if (snap.exists) {
        const suggestions = [
          companyId + '-2', companyId + '-new',
          companyId + '-corp', companyId + '2', companyId + '-jp',
        ];
        return res.status(409).json({ error: `企業ID「${companyId}」は既に使用されています。`, suggestions });
      }
      return res.status(200).json({ available: true });
    }

    // 企業ID重複チェック
    const companyRef = db.collection('companies').doc(companyId);
    const companySnap = await companyRef.get();
    if (companySnap.exists) {
      // 似たIDの候補を生成
      const suggestions = [
        companyId + '-2',
        companyId + '-new',
        companyId + '-corp',
        companyId + '2',
        companyId + '-jp',
      ];
      return res.status(409).json({
        error: `企業ID「${companyId}」は既に使用されています。`,
        suggestions,
      });
    }

    // 料金計算
    const basePrice = 1980;
    const extraPrice = n > 10 ? (n - 10) * 180 : 0;
    const totalPrice = basePrice + extraPrice;

    // metadata
    const metadata = {
      users: String(n),
      companyId,
      companyName: companyName.trim(),
      adminEmail: adminEmail.trim().toLowerCase(),
      plan: n > 10 ? 'standard' : 'basic',
    };
    if (referrer && referrer.includes('@')) {
      metadata.referrer_email = referrer.trim().toLowerCase();
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: adminEmail.trim().toLowerCase(),
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
      success_url: `https://www.attendance1.com/success.html?users=${n}&amount=${totalPrice}&company=${encodeURIComponent(companyName)}`,
      cancel_url: 'https://www.attendance1.com/#trial',
      locale: 'ja',
    });

    return res.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Stripe error:', err.message);
    return res.status(500).json({ error: '決済の準備中にエラーが発生しました。' });
  }
};
