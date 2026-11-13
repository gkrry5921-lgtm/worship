// 아이폰 푸시(매일 08:00)와 슬랙 '내일 준비' 브리핑(매일 23:00)을 보냅니다. (한국시간)
// ONLY=push → 아침 워크플로, ONLY=slack → 밤 워크플로
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { kstNow, ymd, buildPush, buildSlack } from './briefing.mjs';

let sa = {};
try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); } catch { }
if (!sa.project_id) {
  console.error('GitHub Secrets에 FIREBASE_SERVICE_ACCOUNT(서비스 계정 JSON)를 넣어주세요.');
  process.exit(1);
}
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const fcm = getMessaging();

const APP_URL = (process.env.APP_URL || '').trim();            // 예: https://아이디.github.io/저장소/
const SLACK_WEBHOOK_URL = (process.env.SLACK_WEBHOOK_URL || '').trim();
const ONLY = (process.env.ONLY || 'push').trim();               // push | slack
const FORCE = process.env.FORCE === 'true';                      // 수동 실행이면 이미 보냈어도 다시 보냄

// 예약 실행이 빠지는 날을 대비해 여러 번 예약해 두고, 같은 날 두 번 가지 않도록 보낸 날짜를 기록합니다.
const metaRef = uid => db.collection('users').doc(uid).collection('hjm_meta').doc('notify');
async function alreadySent(uid, key, date) {
  if (FORCE) return false;
  const s = await metaRef(uid).get();
  return s.exists && s.data()[key] === date;
}
const markSent = (uid, key, date) => metaRef(uid).set({ [key]: date, [key + 'At']: Date.now() }, { merge: true });
const prevDay = ds => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - 1); return ymd(d); };

// GitHub 예약 실행은 몇 분씩 늦게 시작되므로 조금 일찍 시작해서 정해진 시각까지 기다립니다.
async function waitUntil(h, m) {
  if (process.env.SKIP_WAIT === 'true') return;
  const n = kstNow();
  const target = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), h, m, 0);
  const ms = target - n.getTime();
  if (ms > 0 && ms <= 50 * 60 * 1000) {
    console.log(`${h}:${String(m).padStart(2, '0')}까지 ${Math.round(ms / 1000)}초 대기`);
    await new Promise(r => setTimeout(r, ms));
  }
}

const userCol = (uid, name) => db.collection('users').doc(uid).collection(name).get().then(s => s.docs.map(d => d.data()));

async function collectTokens() {
  const tokSnap = await db.collectionGroup('hjm_push_tokens').get();
  const byUser = new Map();
  tokSnap.forEach(d => {
    const t = d.data();
    if (!t.token || t.enabled === false) return;
    const uid = d.ref.parent.parent.id;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push({ token: t.token, ref: d.ref });
  });
  return byUser;
}

async function sendPush(byUser, today) {
  if (!byUser.size) { console.log('등록된 푸시 기기가 없습니다. 앱에서 🔔 푸시 켜기를 먼저 눌러주세요.'); return true; }
  let ok = 0, fail = 0;
  for (const [uid, toks] of byUser) {
    if (await alreadySent(uid, 'push', today)) { console.log('오늘 푸시는 이미 보냈습니다. 건너뜁니다.'); continue; }
    const { title, body } = buildPush(await userCol(uid, 'hjm_events'), today);
    const webNotification = { title, body };
    if (APP_URL) webNotification.icon = new URL('icon-192.png', APP_URL).href;
    const webpush = { notification: webNotification, headers: { Urgency: 'high', TTL: String(6 * 3600) } };
    if (APP_URL) webpush.fcmOptions = { link: APP_URL };

    const res = await fcm.sendEachForMulticast({ tokens: toks.map(t => t.token), notification: { title, body }, webpush });
    for (let i = 0; i < res.responses.length; i++) {
      const r = res.responses[i];
      if (r.success) { ok++; continue; }
      fail++;
      const code = r.error?.code || '';
      console.warn('푸시 발송 실패:', code, r.error?.message);
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        await toks[i].ref.delete().catch(() => { });
      }
    }
    if (res.successCount > 0) await markSent(uid, 'push', today);
  }
  console.log(`푸시 발송: 성공 ${ok}건, 실패 ${fail}건`);
  return ok > 0 || fail === 0;
}

async function sendSlack(uids, today) {
  if (!SLACK_WEBHOOK_URL) { console.log('SLACK_WEBHOOK_URL이 없어서 슬랙 브리핑은 건너뜁니다.'); return true; }
  if (!uids.length) { console.log('슬랙으로 보낼 사용자를 찾지 못했습니다.'); return false; }
  let allOk = true;
  for (const uid of uids) {
    if (await alreadySent(uid, 'slack', today)) { console.log('오늘 밤 슬랙 브리핑은 이미 보냈습니다. 건너뜁니다.'); continue; }
    const [events, memos, routines] = await Promise.all([userCol(uid, 'hjm_events'), userCol(uid, 'hjm_memos'), userCol(uid, 'hjm_routines')]);
    const payload = buildSlack({ events, memos, routines }, today, APP_URL);
    const res = await fetch(SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const txt = await res.text();
    if (res.ok) { console.log('슬랙 브리핑 발송 완료'); await markSent(uid, 'slack', today); }
    else { allOk = false; console.error('슬랙 발송 실패:', res.status, txt); }
  }
  return allOk;
}

async function main() {
  const byUser = await collectTokens();
  let uids = [...byUser.keys()];
  if (!uids.length) uids = (await db.collection('users').listDocuments()).map(d => d.id);

  let pushOk = true, slackOk = true;
  if (ONLY === 'push') {
    await waitUntil(8, 0);
    const today = ymd(kstNow());
    console.log('푸시 기준 날짜(KST):', today);
    try { pushOk = await sendPush(byUser, today); } catch (e) { pushOk = false; console.error('푸시 오류:', e); }
  }
  if (ONLY === 'slack') {
    await waitUntil(23, 0);
    let today = ymd(kstNow());
    if (kstNow().getUTCHours() < 6) today = prevDay(today);   // 자정을 넘겨 늦게 실행돼도 '전날 밤' 브리핑으로 보냄
    console.log('슬랙 브리핑: 오늘(KST)', today, '→ 내일 준비');
    try { slackOk = await sendSlack(uids, today); } catch (e) { slackOk = false; console.error('슬랙 오류:', e); }
  }
  if (!pushOk || !slackOk) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
