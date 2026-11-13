// 매일 아침 8시(한국시간)에 오늘 일정을 아이폰으로 푸시합니다.
// GitHub Actions(.github/workflows/morning-push.yml)에서 실행됩니다.
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';

let sa = {};
try { sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}'); } catch { }
if (!sa.project_id) {
  console.error('GitHub Secrets에 FIREBASE_SERVICE_ACCOUNT(서비스 계정 JSON)를 넣어주세요.');
  process.exit(1);
}
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const fcm = getMessaging();

const APP_URL = (process.env.APP_URL || '').trim();   // 예: https://아이디.github.io/저장소/
const KST = 9 * 3600 * 1000;
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const CATS = ['NCMN', 'CGN', '개인일정', '퐁당'];

const kstNow = () => new Date(Date.now() + KST);
const ymd = d => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
const md = ds => { const d = new Date(ds + 'T00:00:00Z'); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`; };
const label = ds => { const d = new Date(ds + 'T00:00:00Z'); return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${WD[d.getUTCDay()]})`; };

// GitHub 예약 실행은 몇 분씩 늦게 시작되므로 조금 일찍 시작해서 8시 정각까지 기다립니다.
async function waitUntil8() {
  if (process.env.SKIP_WAIT === 'true') return;
  const n = kstNow();
  const target = Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate(), 8, 0, 0);
  const ms = target - n.getTime();
  if (ms > 0 && ms <= 40 * 60 * 1000) {
    console.log(`08:00까지 ${Math.round(ms / 1000)}초 대기`);
    await new Promise(r => setTimeout(r, ms));
  }
}

function buildMessage(events, today) {
  const list = events
    .filter(e => e.start && e.start <= today && (e.end || e.start) >= today)
    .sort((a, b) =>
      Number(!!a.done) - Number(!!b.done) ||
      CATS.indexOf(a.cat) - CATS.indexOf(b.cat) ||
      String(a.title).localeCompare(String(b.title), 'ko'));

  if (!list.length) return { title: `${label(today)} 오늘 일정`, body: '오늘 등록된 일정이 없어요.' };

  const lines = list.map(e => {
    const cat = e.cat === '개인일정' ? '개인' : (e.cat || '');
    const end = e.end || e.start;
    const range = e.start !== end ? ` (~${md(end)})` : '';
    return `${e.done ? '✓' : '•'} [${cat}] ${e.title}${range}`;
  });
  let body = lines.join('\n');
  if (body.length > 1500) body = body.slice(0, 1500) + '\n…';
  return { title: `${label(today)} 오늘 일정 ${list.length}개`, body };
}

async function main() {
  await waitUntil8();
  const today = ymd(kstNow());
  console.log('기준 날짜(KST):', today);

  // 푸시 켜기로 등록된 기기 토큰을 사용자별로 모읍니다.
  const tokSnap = await db.collectionGroup('hjm_push_tokens').get();
  const byUser = new Map();
  tokSnap.forEach(d => {
    const t = d.data();
    if (!t.token || t.enabled === false) return;
    const uid = d.ref.parent.parent.id;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push({ token: t.token, ref: d.ref });
  });
  if (!byUser.size) { console.log('등록된 푸시 기기가 없습니다. 앱에서 🔔 푸시 켜기를 먼저 눌러주세요.'); return; }

  let ok = 0, fail = 0;
  for (const [uid, toks] of byUser) {
    const evSnap = await db.collection('users').doc(uid).collection('hjm_events').get();
    const { title, body } = buildMessage(evSnap.docs.map(d => d.data()), today);

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
      console.warn('발송 실패:', code, r.error?.message);
      // 앱 삭제·권한 해제 등으로 더 이상 쓸 수 없는 토큰은 정리
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        await toks[i].ref.delete().catch(() => { });
      }
    }
  }
  console.log(`발송 완료: 성공 ${ok}건, 실패 ${fail}건`);
  if (!ok && fail) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
