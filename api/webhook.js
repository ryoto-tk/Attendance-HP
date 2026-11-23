const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const admin = require('firebase-admin');
const crypto = require('crypto');

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

/** ランダムトークン生成（32文字の hex） */
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
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
  // 決済完了後にオンボーディングメールを送信するだけ。Firebase への自動登録は行わない。
  if (event.type === 'customer.subscription.created') {
    const subscription = event.data.object;
    const meta = subscription.metadata || {};
    const { companyId, companyName, adminEmail, users, referrer_email } = meta;

    if (!companyId || !adminEmail) {
      console.log('メタデータ不足のためスキップ:', meta);
      return res.status(200).json({ received: true });
    }

    try {
      const trialEnd = subscription.trial_end
        ? new Date(subscription.trial_end * 1000)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      // ── 1. saasCustomers に決済記録を保存（二重送信防止フラグつき）──
      const customerRef = db.collection('saasCustomers').doc(companyId);
      const customerSnap = await customerRef.get();

      // すでに emailSentAt が記録されていれば二重送信をスキップ
      if (customerSnap.exists && customerSnap.data().emailSentAt) {
        console.log(`⚠️ メール送信済みのためスキップ: ${companyId}`);
        return res.status(200).json({ received: true });
      }

      // オンボーディングトークンを生成
      const onboardingToken = generateToken();
      const onboardingUrl = `https://attendance-three-rose.vercel.app/customer-onboarding.html?token=${onboardingToken}`;

      // saasCustomers に保存（既存レコードがあれば merge、なければ新規作成）
      await customerRef.set({
        customerId: companyId,
        company: companyName || companyId,
        email: adminEmail,
        plan: parseInt(users || '1', 10) > 10 ? 'standard' : 'basic',
        status: 'paid',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        stripeCustomerId: subscription.customer,
        stripeSubscriptionId: subscription.id,
        trialEnd: admin.firestore.Timestamp.fromDate(trialEnd),
        users: parseInt(users || '1', 10),
        onboardingToken,
        onboardingStatus: 'pending',   // pending | completed
        emailSentAt: null,             // メール送信後に更新
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      console.log(`✅ saasCustomers/${companyId} 保存完了`);

      // ── 2. 紹介プログラム処理（既存ロジックをそのまま維持）──
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
              customer: referrerCustomer.id, status: 'active', limit: 1,
            });
            const trialSubs = subs.data.length === 0
              ? (await stripe.subscriptions.list({ customer: referrerCustomer.id, status: 'trialing', limit: 1 })).data
              : subs.data;
            if (trialSubs.length > 0) {
              await stripe.subscriptions.update(trialSubs[0].id, { coupon: coupon.id });
              console.log(`✅ 紹介クーポン適用: ${referrer_email}`);
            }
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

      // ── 3. 顧客へオンボーディングメールを送信 ──
      const trialEndStr = `${trialEnd.getFullYear()}年${trialEnd.getMonth()+1}月${trialEnd.getDate()}日`;
      const emailSent = await sendEmail({
        to: adminEmail,
        subject: '【Attendance】ご登録ありがとうございます！利用登録を完了してください',
        html: `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f8fc;font-family:-apple-system,'Hiragino Sans','Yu Gothic UI',sans-serif;">
<div style="max-width:600px;margin:0 auto;padding:32px 16px;">

  <!-- ヘッダー -->
  <div style="background:#1B2A4A;border-radius:16px 16px 0 0;padding:28px 32px;">
    <p style="margin:0 0 4px;font-size:11px;font-weight:700;letter-spacing:.1em;color:#00B4D8;">ATTENDANCE</p>
    <h1 style="margin:0;font-size:22px;font-weight:800;color:#ffffff;">ご登録ありがとうございます！</h1>
  </div>

  <!-- メイン -->
  <div style="background:#ffffff;padding:32px;">
    <p style="margin:0 0 20px;color:#4A5568;line-height:1.8;font-size:15px;">
      <strong style="color:#1B2A4A;">${companyName || companyId}</strong> 様<br><br>
      Attendanceへのお申し込みが完了しました。<br>
      以下のボタンから利用登録を完了してください。<strong style="color:#1B2A4A;">登録は5〜10分で完了します。</strong>
    </p>

    <!-- CTA -->
    <div style="text-align:center;margin:32px 0;">
      <a href="${onboardingUrl}"
         style="display:inline-block;background:#00B4D8;color:#ffffff;font-size:16px;font-weight:700;text-decoration:none;padding:16px 40px;border-radius:12px;letter-spacing:.02em;">
        利用登録を完了する →
      </a>
      <p style="margin:12px 0 0;font-size:12px;color:#7A8BA0;">ボタンが押せない場合は以下のURLをブラウザに貼り付けてください：</p>
      <p style="margin:4px 0 0;font-size:11px;color:#00B4D8;word-break:break-all;">${onboardingUrl}</p>
    </div>

    <!-- 登録内容 -->
    <div style="background:#F4F7FB;border-radius:12px;padding:20px;margin:24px 0;">
      <p style="margin:0 0 12px;font-size:13px;font-weight:700;color:#1B2A4A;">📋 お申し込み内容</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <tr><td style="padding:6px 0;color:#7A8BA0;width:140px;">企業ID</td><td style="font-family:monospace;font-weight:700;color:#1B2A4A;">${companyId}</td></tr>
        <tr><td style="padding:6px 0;color:#7A8BA0;">利用人数</td><td style="color:#1B2A4A;">${users}名</td></tr>
        <tr><td style="padding:6px 0;color:#7A8BA0;">無料トライアル終了日</td><td style="color:#1B2A4A;">${trialEndStr}</td></tr>
      </table>
    </div>

    <!-- 登録でできること -->
    <div style="border-left:3px solid #00B4D8;padding:12px 16px;margin:24px 0;background:#EBF9FD;border-radius:0 8px 8px 0;">
      <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#1B2A4A;">登録ページで行うこと</p>
      <ol style="margin:0;padding-left:20px;font-size:13px;color:#4A5568;line-height:2.2;">
        <li>企業・管理者情報の入力</li>
        <li>従業員リストの登録（CSVまたは手動入力）</li>
        <li>登録完了 → すぐに利用開始できます</li>
      </ol>
    </div>

    <!-- 注意 -->
    <p style="margin:24px 0 0;font-size:13px;color:#7A8BA0;line-height:1.8;">
      ⚠️ このURLは<strong style="color:#4A5568;">お客様専用</strong>です。第三者への共有はお控えください。<br>
      ご不明な点は <a href="mailto:attendance.support1@gmail.com" style="color:#00B4D8;">attendance.support1@gmail.com</a> までご連絡ください。
    </p>
  </div>

  <!-- フッター -->
  <div style="background:#1B2A4A;border-radius:0 0 16px 16px;padding:20px 32px;text-align:center;">
    <p style="margin:0;font-size:12px;color:rgba(255,255,255,.5);">
      Attendance | <a href="https://www.attendance1.com" style="color:#00B4D8;text-decoration:none;">www.attendance1.com</a>
    </p>
  </div>

</div>
</body>
</html>`,
      });

      // ── 4. メール送信完了フラグを更新（二重送信防止）──
      if (emailSent) {
        await customerRef.update({ emailSentAt: admin.firestore.FieldValue.serverTimestamp() });
        console.log(`✅ オンボーディングメール送信完了: ${adminEmail}`);
      } else {
        console.error(`❌ メール送信失敗: ${adminEmail}`);
      }

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
        // saasCustomers のステータスも更新
        await db.collection('saasCustomers').doc(companyId).update({
          subscriptionStatus: subscription.status,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {}); // レコードが存在しない場合は無視

        // companies/{companyId}/settings/subscription が存在すれば更新
        const subRef = db.collection('companies').doc(companyId)
          .collection('settings').doc('subscription');
        const subSnap = await subRef.get();
        if (subSnap.exists) {
          await subRef.update({
            status: subscription.status,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
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
        await db.collection('saasCustomers').doc(companyId).update({
          subscriptionStatus: 'canceled',
          canceledAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});

        const subRef = db.collection('companies').doc(companyId)
          .collection('settings').doc('subscription');
        const subSnap = await subRef.get();
        if (subSnap.exists) {
          await subRef.update({
            status: 'canceled',
            canceledAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
        console.log(`✅ subscription canceled: ${companyId}`);
      } catch (e) {
        console.error('subscription delete error:', e.message);
      }
    }
  }

  res.status(200).json({ received: true });
};
