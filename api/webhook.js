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
const adminAuth = admin.auth();

export const config = { api: { bodyParser: false } };

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function sendEmail({ to, subject, html }) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Attendance <noreply@attendance1.com>',
        to,
        subject,
        html,
      }),
    });
    if (!res.ok) console.error('Resend error:', await res.text());
    return res.ok;
  } catch (e) {
    console.error('sendEmail error:', e.message);
    return false;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature error:', err.message);
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // ── サブスクリプション作成（トライアル開始）──
  if (event.type === 'customer.subscription.created') {
    const subscription = event.data.object;
    const meta = subscription.metadata || {};
    const {
      companyId,
      companyName,
      adminEmail,
      users,
      referrer_email,
    } = meta;

    if (!companyId || !adminEmail) {
      console.log('メタデータ不足のためスキップ:', meta);
      return res.status(200).json({ received: true });
    }

    try {
      const trialEnd = subscription.trial_end
        ? new Date(subscription.trial_end * 1000)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      // 1. Firestoreに企業ドキュメントを作成（存在しない場合のみ）
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
        console.log(`✅ companies/${companyId} 作成完了`);
      }

      // 2. サブスクリプション状態を保存
      await db
        .collection('companies').doc(companyId)
        .collection('settings').doc('subscription')
        .set({
          status: subscription.status, // 'trialing'
          stripeSubscriptionId: subscription.id,
          stripeCustomerId: subscription.customer,
          trialEnd: admin.firestore.Timestamp.fromDate(trialEnd),
          users: parseInt(users || '1', 10),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      console.log(`✅ companies/${companyId}/settings/subscription 作成完了`);

      // 3. Firebase Custom Claimsに companyId を設定
      //    adminEmail でユーザーを検索（存在しない場合はスキップ、後でログイン時に設定）
      try {
        const userRecord = await adminAuth.getUserByEmail(adminEmail);
        await adminAuth.setCustomUserClaims(userRecord.uid, {
          companyId,
          role: 'admin',
        });
        console.log(`✅ Custom Claims設定: ${adminEmail} → companyId: ${companyId}`);
      } catch (authErr) {
        // ユーザーがまだFirebaseに存在しない場合は pending として保存
        console.log(`ℹ️ ユーザー未登録のためpendingに保存: ${adminEmail}`);
        await db.collection('pendingClaims').doc(adminEmail.replace('@', '_at_')).set({
          email: adminEmail,
          companyId,
          role: 'admin',
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // 4. 紹介プログラム処理
      if (referrer_email) {
        try {
          const customers = await stripe.customers.list({ email: referrer_email, limit: 1 });
          if (customers.data.length > 0) {
            const referrerCustomer = customers.data[0];
            const coupon = await stripe.coupons.create({
              duration: 'once',
              percent_off: 100,
              name: '紹介プログラム：翌月無料',
              metadata: { referrer_email, new_company: companyId },
            });
            const subs = await stripe.subscriptions.list({
              customer: referrerCustomer.id,
              status: 'active',
              limit: 1,
            });
            const trialSubs = subs.data.length === 0
              ? (await stripe.subscriptions.list({ customer: referrerCustomer.id, status: 'trialing', limit: 1 })).data
              : subs.data;
            if (trialSubs.length > 0) {
              await stripe.subscriptions.update(trialSubs[0].id, { coupon: coupon.id });
              console.log(`✅ 紹介クーポン適用: ${referrer_email}`);
            }
            // 紹介者にメール通知
            await sendEmail({
              to: referrer_email,
              subject: '【Attendance】ご紹介ありがとうございます！翌月無料クーポンを発行しました',
              html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
                <h1 style="color:#0e2a55">ご紹介ありがとうございます！🎉</h1>
                <p style="color:#444;line-height:1.8">ご紹介いただいた方がAttendanceにご登録されました。<br>翌月分の利用料が<strong>1ヶ月分無料</strong>になるクーポンを発行しました。</p>
                <div style="background:#f5f8fc;border-radius:12px;padding:20px;margin:24px 0">
                  <p style="margin:0;color:#0e2a55;font-weight:bold">翌月利用料 100%OFF</p>
                  <p style="margin:8px 0 0;color:#666;font-size:14px">次回の請求日に自動的に適用されます</p>
                </div>
                <hr style="border:none;border-top:1px solid #e8eff9;margin:24px 0">
                <p style="color:#999;font-size:12px">Attendance | <a href="https://www.attendance1.com">www.attendance1.com</a></p>
              </div>`,
            });
          }
        } catch (refErr) {
          console.error('紹介処理エラー:', refErr.message);
        }
      }

      // 5. 管理者に案内メールを送信
      await sendEmail({
        to: adminEmail,
        subject: '【Attendance】ご登録ありがとうございます！30日間無料トライアル開始',
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
          <h1 style="color:#0e2a55;font-size:24px">ご登録ありがとうございます！</h1>
          <p style="color:#444;line-height:1.8">
            <strong>${companyName || companyId}</strong> として Attendance へのご登録が完了しました。<br>
            30日間の無料トライアルが開始されました。
          </p>
          <div style="background:#f5f8fc;border-radius:12px;padding:20px;margin:24px 0">
            <p style="margin:0 0 12px;color:#0e2a55;font-weight:bold">📋 次のステップ</p>
            <ol style="margin:0;padding-left:20px;color:#444;line-height:2">
              <li>管理者ダッシュボードにログイン（メールアドレスとパスワードで）</li>
              <li>従業員を登録して、シフトや打刻ルールを設定</li>
              <li>従業員に打刻アプリのURLを共有</li>
            </ol>
          </div>
          <div style="background:#0e2a55;border-radius:12px;padding:20px;margin:24px 0;text-align:center">
            <p style="margin:0 0 8px;color:white;font-weight:bold">企業ID（重要：大切に保管してください）</p>
            <p style="margin:0;color:#12b886;font-size:24px;font-weight:bold;font-family:monospace">${companyId}</p>
          </div>
          <table style="width:100%;border-collapse:collapse;margin:16px 0">
            <tr><td style="padding:8px;border-bottom:1px solid #e8eff9;color:#666">管理者ダッシュボード</td>
                <td style="padding:8px;border-bottom:1px solid #e8eff9"><a href="https://attendance-three-rose.vercel.app/index.html">index.html を開く</a></td></tr>
            <tr><td style="padding:8px;border-bottom:1px solid #e8eff9;color:#666">従業員打刻アプリ</td>
                <td style="padding:8px;border-bottom:1px solid #e8eff9"><a href="https://attendance-three-rose.vercel.app/about.html">about.html を開く</a></td></tr>
            <tr><td style="padding:8px;color:#666">トライアル終了日</td>
                <td style="padding:8px">${trialEnd.getFullYear()}年${trialEnd.getMonth()+1}月${trialEnd.getDate()}日</td></tr>
          </table>
          <p style="color:#444;line-height:1.8;font-size:14px">
            ご不明な点は <a href="mailto:attendance.support1@gmail.com">attendance.support1@gmail.com</a> までお気軽にご連絡ください。<br>
            2営業日以内にご返信いたします。
          </p>
          <hr style="border:none;border-top:1px solid #e8eff9;margin:24px 0">
          <p style="color:#999;font-size:12px">Attendance | 運営者：Takasaki Ryoto | <a href="https://www.attendance1.com">www.attendance1.com</a></p>
        </div>`,
      });
      console.log(`✅ 案内メール送信完了: ${adminEmail}`);

    } catch (err) {
      console.error('Webhook処理エラー:', err.message);
    }
  }

  // ── サブスクリプション更新（トライアル終了・更新など）──
  if (event.type === 'customer.subscription.updated') {
    const subscription = event.data.object;
    const meta = subscription.metadata || {};
    const { companyId } = meta;
    if (companyId) {
      try {
        await db
          .collection('companies').doc(companyId)
          .collection('settings').doc('subscription')
          .update({
            status: subscription.status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        console.log(`✅ subscription status更新: ${companyId} → ${subscription.status}`);
      } catch (e) {
        console.error('subscription update error:', e.message);
      }
    }
  }

  // ── サブスクリプション解約 ──
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const meta = subscription.metadata || {};
    const { companyId } = meta;
    if (companyId) {
      try {
        await db
          .collection('companies').doc(companyId)
          .collection('settings').doc('subscription')
          .update({
            status: 'canceled',
            canceledAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        console.log(`✅ subscription canceled: ${companyId}`);
      } catch (e) {
        console.error('subscription delete error:', e.message);
      }
    }
  }

  res.status(200).json({ received: true });
};
