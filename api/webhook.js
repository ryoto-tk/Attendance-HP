const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');

// Firebase Admin SDK初期化（冪等）
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();
const adminAuth = admin.auth();

// Vercel用: bodyParserを無効化（CommonJS形式）
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // raw bodyを取得
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: err.message });
  }

  console.log('Webhook received:', event.type);

  // サブスクリプション作成
  if (event.type === 'customer.subscription.created') {
    const subscription = event.data.object;
    const meta = subscription.metadata || {};
    const { companyId, companyName, adminEmail, users } = meta;

    console.log('Processing subscription:', { companyId, adminEmail });

    if (!companyId || !adminEmail) {
      console.log('Missing metadata, skipping:', meta);
      return res.status(200).json({ received: true });
    }

    try {
      const trialEnd = subscription.trial_end
        ? new Date(subscription.trial_end * 1000)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      // 1. Firestoreに企業ドキュメントを作成
      const companyRef = db.collection('companies').doc(companyId);
      const companySnap = await companyRef.get();
      if (!companySnap.exists) {
        await companyRef.set({
          name: companyName || companyId,
          adminEmail,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          stripeCustomerId: subscription.customer,
          stripeSubscriptionId: subscription.id,
        });
        console.log('✅ companies/' + companyId + ' 作成完了');
      }

      // 2. subscriptionドキュメントを作成
      await companyRef.collection('settings').doc('subscription').set({
        status: subscription.status,
        stripeSubscriptionId: subscription.id,
        stripeCustomerId: subscription.customer,
        trialEnd: admin.firestore.Timestamp.fromDate(trialEnd),
        users: parseInt(users || '1', 10),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log('✅ subscription設定完了');

      // 3. Custom Claimsを設定
      try {
        const userRecord = await adminAuth.getUserByEmail(adminEmail);
        await adminAuth.setCustomUserClaims(userRecord.uid, {
          companyId,
          role: 'admin',
        });
        console.log('✅ Custom Claims設定完了:', adminEmail);
      } catch (authErr) {
        // ユーザーがまだ存在しない場合はpendingClaimsに保存
        console.log('ℹ️ ユーザー未登録、pendingに保存:', adminEmail);
        await db.collection('pendingClaims')
          .doc(adminEmail.replace(/[@.]/g, '_'))
          .set({
            email: adminEmail,
            companyId,
            role: 'admin',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          });
      }

      // 4. 案内メール送信
      if (process.env.RESEND_API_KEY) {
        try {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'Attendance <noreply@attendance1.com>',
              to: adminEmail,
              subject: '【Attendance】ご登録ありがとうございます！30日間無料トライアル開始',
              html: `
                <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
                  <h1 style="color:#0e2a55">ご登録ありがとうございます！</h1>
                  <p style="color:#444;line-height:1.8">
                    <strong>${companyName || companyId}</strong> として Attendance へのご登録が完了しました。<br>
                    30日間の無料トライアルが開始されました。
                  </p>
                  <div style="background:#0e2a55;border-radius:12px;padding:20px;margin:24px 0;text-align:center">
                    <p style="margin:0 0 8px;color:white;font-weight:bold">企業ID（大切に保管してください）</p>
                    <p style="margin:0;color:#12b886;font-size:24px;font-weight:bold;font-family:monospace">${companyId}</p>
                  </div>
                  <p style="color:#444;line-height:1.8">
                    管理者ダッシュボード：<a href="https://attendance-three-rose.vercel.app/index.html">こちらからログイン</a><br>
                    従業員打刻アプリ：<a href="https://attendance-three-rose.vercel.app/about.html">こちら</a>
                  </p>
                  <p style="color:#444;font-size:14px">
                    ご不明な点は <a href="mailto:attendance.support1@gmail.com">attendance.support1@gmail.com</a> までご連絡ください。
                  </p>
                </div>
              `,
            }),
          });
          console.log('✅ 案内メール送信完了');
        } catch (mailErr) {
          console.error('メール送信エラー:', mailErr.message);
        }
      }

    } catch (err) {
      console.error('Webhook処理エラー:', err.message, err.stack);
    }
  }

  // サブスクリプション更新
  if (event.type === 'customer.subscription.updated') {
    const sub = event.data.object;
    const { companyId } = sub.metadata || {};
    if (companyId) {
      try {
        await db.collection('companies').doc(companyId)
          .collection('settings').doc('subscription')
          .update({ status: sub.status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
        console.log('✅ subscription更新:', companyId, sub.status);
      } catch (e) { console.error(e.message); }
    }
  }

  // サブスクリプション解約
  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const { companyId } = sub.metadata || {};
    if (companyId) {
      try {
        await db.collection('companies').doc(companyId)
          .collection('settings').doc('subscription')
          .update({ status: 'canceled', canceledAt: admin.firestore.FieldValue.serverTimestamp() });
        console.log('✅ subscription解約:', companyId);
      } catch (e) { console.error(e.message); }
    }
  }

  res.status(200).json({ received: true });
};

// Vercel用: bodyParserを無効化
module.exports.config = { api: { bodyParser: false } };
