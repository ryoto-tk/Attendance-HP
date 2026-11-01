const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// Vercelはbodyをそのまま読むためraw bodyが必要
export const config = { api: { bodyParser: false } };

// raw bodyを取得するヘルパー
function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Resendでメール送信（無料枠100通/日）
async function sendEmail({ to, subject, html }) {
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
  if (!res.ok) {
    const err = await res.text();
    console.error('Resend error:', err);
  }
  return res.ok;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await getRawBody(req);
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
    return res.status(400).json({ error: `Webhook Error: ${err.message}` });
  }

  // サブスクリプション作成時（トライアル開始）
  if (event.type === 'customer.subscription.created') {
    const subscription = event.data.object;
    const referrerEmail = subscription.metadata?.referrer_email;

    if (referrerEmail) {
      try {
        // 紹介者のCustomerを検索
        const customers = await stripe.customers.list({
          email: referrerEmail,
          limit: 1,
        });

        if (customers.data.length > 0) {
          const referrerCustomer = customers.data[0];

          // 翌月無料クーポンを作成
          const coupon = await stripe.coupons.create({
            duration: 'once',
            percent_off: 100,
            name: '紹介プログラム：翌月無料',
            metadata: {
              referrer_email: referrerEmail,
              new_customer_id: subscription.customer,
            },
          });

          // 紹介者のサブスクリプションを検索してクーポン適用
          const referrerSubs = await stripe.subscriptions.list({
            customer: referrerCustomer.id,
            status: 'active',
            limit: 1,
          });

          if (referrerSubs.data.length > 0) {
            await stripe.subscriptions.update(referrerSubs.data[0].id, {
              coupon: coupon.id,
            });
            console.log(`クーポン適用: ${referrerEmail} → ${coupon.id}`);
          } else {
            // アクティブなサブスクがない場合はトライアル中かも
            const trialSubs = await stripe.subscriptions.list({
              customer: referrerCustomer.id,
              status: 'trialing',
              limit: 1,
            });
            if (trialSubs.data.length > 0) {
              await stripe.subscriptions.update(trialSubs.data[0].id, {
                coupon: coupon.id,
              });
              console.log(`クーポン適用（トライアル中）: ${referrerEmail}`);
            }
          }

          // 紹介者にメール通知
          await sendEmail({
            to: referrerEmail,
            subject: '【Attendance】ご紹介ありがとうございます！翌月無料クーポンを発行しました',
            html: `
              <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
                <h1 style="color:#0e2a55;font-size:24px">ご紹介ありがとうございます！🎉</h1>
                <p style="color:#444;line-height:1.8">
                  ご紹介いただいた方がAttendanceにご登録されました。<br>
                  翌月分の利用料が<strong>1ヶ月分無料</strong>になるクーポンを発行しました。
                </p>
                <div style="background:#f5f8fc;border-radius:12px;padding:20px;margin:24px 0">
                  <p style="margin:0;color:#0e2a55;font-weight:bold">クーポン内容</p>
                  <p style="margin:8px 0 0;color:#12b886;font-size:20px;font-weight:bold">翌月利用料 100%OFF</p>
                  <p style="margin:4px 0 0;color:#666;font-size:14px">次回の請求日に自動的に適用されます</p>
                </div>
                <p style="color:#444;line-height:1.8">
                  引き続きAttendanceをよろしくお願いいたします。<br>
                  ご不明な点は <a href="mailto:attendance.support1@gmail.com" style="color:#0e2a55">attendance.support1@gmail.com</a> までお気軽にご連絡ください。
                </p>
                <hr style="border:none;border-top:1px solid #e8eff9;margin:24px 0">
                <p style="color:#999;font-size:12px">
                  Attendance | <a href="https://www.attendance1.com" style="color:#999">www.attendance1.com</a><br>
                  運営者：Takasaki Ryoto
                </p>
              </div>
            `,
          });
        } else {
          console.log(`紹介者が見つかりません: ${referrerEmail}`);
        }
      } catch (err) {
        console.error('紹介プログラム処理エラー:', err.message);
      }
    }
  }

  res.status(200).json({ received: true });
};
