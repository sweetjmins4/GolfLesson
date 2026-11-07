import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, SITE_NAME, CANCEL_HOURS } from './config.js';

const app = document.getElementById('app');
document.title = SITE_NAME;

const state = {
  me: null,                 // 로그인한 사람의 profiles 행
  tab: null,
  weekStart: startOfWeek(new Date()),
  authMode: 'login',
  recovering: false,        // 비밀번호 재설정 링크로 들어온 상태
  openMember: null,         // 회원 관리에서 펼친 회원 id
};

/* =====================================================================
   유틸
   ===================================================================== */
const DOW = ['일', '월', '화', '수', '목', '금', '토'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function startOfWeek(d) {           // 월요일 시작
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const sameDay = (a, b) => ymd(a) === ymd(b);
const fmtDate = (d) => `${d.getMonth() + 1}/${d.getDate()}(${DOW[d.getDay()]})`;
const fmtTime = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const fmtDateTime = (v) => { const d = new Date(v); return `${d.getMonth() + 1}/${d.getDate()} ${fmtTime(d)}`; };
const fmtRange = (s, e) => `${fmtDate(new Date(s))} ${fmtTime(new Date(s))}~${fmtTime(new Date(e))}`;

const BOOKING_STATUS = {
  pending: ['승인 대기', 'warn'], approved: ['예약 확정', 'ok'],
  rejected: ['거절', 'bad'], cancelled: ['취소', 'mute'],
};
const MEMBER_STATUS = { pending: ['가입 대기', 'warn'], approved: ['회원', 'ok'], rejected: ['거절', 'bad'] };
const badge = (map, s) => `<span class="badge ${map[s][1]}">${map[s][0]}</span>`;

// Supabase 응답에서 error 가 있으면 throw
async function q(promise) {
  const { data, error } = await promise;
  if (error) throw error;
  return data;
}

function errText(e) {
  const m = e?.message || String(e);
  if (m.includes('Invalid login credentials')) return '이메일 또는 비밀번호가 올바르지 않습니다.';
  if (m.includes('Email not confirmed')) return '이메일 인증이 아직 안 됐습니다. 받은 메일의 링크를 눌러 주세요.';
  if (m.includes('already registered')) return '이미 가입된 이메일입니다.';
  if (m.toLowerCase().includes('rate limit')) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  if (m.includes('Password should be')) return '비밀번호는 6자 이상이어야 합니다.';
  if (m.includes('Failed to fetch')) return '서버에 연결할 수 없습니다. 인터넷 연결 또는 config.js 설정을 확인해 주세요.';
  return m;
}

let toastTimer;
function toast(msg, kind = 'ok') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 3500);
}

/* =====================================================================
   설정 확인 & Supabase 연결
   ===================================================================== */
if (SUPABASE_URL.includes('YOUR-PROJECT') || SUPABASE_ANON_KEY.includes('YOUR-')) {
  app.innerHTML = `<div class="auth card">
    <h1>⚙️ 설정이 필요합니다</h1>
    <p><code>config.js</code> 파일에 Supabase 프로젝트 URL과 anon(publishable) 키를 넣어 주세요.</p>
    <p class="muted small">자세한 방법은 README.md 를 참고하세요.</p></div>`;
  throw new Error('config.js 설정 필요');
}

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

sb.auth.onAuthStateChange((event, session) => {
  if (event === 'PASSWORD_RECOVERY') {
    state.recovering = true;
    setTimeout(renderNewPassword, 0);
    return;
  }
  if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;
  if (event === 'SIGNED_IN' && state.me && session?.user.id === state.me.id) return;
  // 콜백 안에서 바로 supabase 를 호출하면 멈출 수 있어 다음 틱으로 미룸
  setTimeout(() => boot(session), 0);
});

async function boot(session) {
  if (state.recovering) return renderNewPassword();
  if (!session) {
    state.me = null;
    state.tab = null;
    return renderAuth();
  }
  try {
    await loadMe(session.user.id);
  } catch (e) {
    app.innerHTML = `<div class="auth card"><h1>문제가 발생했습니다</h1>
      <p class="err">${esc(errText(e))}</p>
      <p class="muted small">schema.sql 을 실행하기 전에 가입한 계정이라면 다시 가입해 주세요.</p>
      <button class="primary" data-action="logout">로그아웃</button></div>`;
    return;
  }
  if (state.me.role !== 'pro' && state.me.status !== 'approved') return renderWaiting();
  const tabs = currentTabs();
  if (!tabs[state.tab]) state.tab = Object.keys(tabs)[0];
  render();
}

async function loadMe(id = state.me?.id) {
  state.me = await q(sb.from('profiles').select('*').eq('id', id).single());
}

/* =====================================================================
   공통 레이아웃
   ===================================================================== */
const MEMBER_TABS = {
  book:    { label: '레슨 신청', render: memberBook },
  mine:    { label: '내 예약',   render: memberMine },
  profile: { label: '내 정보',   render: memberProfile },
};
const PRO_TABS = {
  profile:  { label: '강사 프로필', render: proProfile },
  inbox:    { label: '승인함',     render: proInbox },
  schedule: { label: '일정표',     render: proSchedule },
  slots:    { label: '타임 만들기', render: proSlots },
  members:  { label: '회원 관리',  render: proMembers },
};
const currentTabs = () => (state.me?.role === 'pro' ? PRO_TABS : MEMBER_TABS);

async function render() {
  const tabs = currentTabs();
  let html;
  try {
    await loadMe();
    html = await tabs[state.tab].render();
  } catch (e) {
    html = `<div class="card"><p class="err">${esc(errText(e))}</p></div>`;
  }
  const m = state.me;
  app.innerHTML = `
    <div class="workspace">
      <aside class="sidebar">
        <div class="brand-block">
          <div class="brand">⛳ ${esc(SITE_NAME)}</div>
          <div class="who">
            <span>${esc(m.name || m.email)} ${m.role === 'pro' ? '프로' : '님'}</span>
            ${m.role === 'pro' ? '<span class="pill">프로</span>' : `<span class="pill">잔여 ${m.credits}회</span>`}
          </div>
        </div>
        <nav class="tabs">${Object.entries(tabs).map(([k, t]) =>
          `<button class="${k === state.tab ? 'on' : ''}" data-action="tab" data-tab="${k}">${t.label}</button>`).join('')}
        </nav>
        <button class="link logout-link" data-action="logout">로그아웃</button>
      </aside>
      <main class="content">${html}</main>
    </div>`;
}

function weekNav() {
  const end = addDays(state.weekStart, 6);
  return `<div class="weeknav">
    <button data-action="week" data-d="-7">‹ 이전 주</button>
    <div><strong>${fmtDate(state.weekStart)} – ${fmtDate(end)}</strong>
      <button class="link small" data-action="week" data-d="0">이번 주</button></div>
    <button data-action="week" data-d="7">다음 주 ›</button>
  </div>`;
}

const weekDays = () => [...Array(7)].map((_, i) => addDays(state.weekStart, i));
const empty = (msg) => `<p class="muted small empty">${msg}</p>`;

/* =====================================================================
   로그인 / 회원가입 / 승인 대기
   ===================================================================== */
function renderAuth() {
  const login = state.authMode === 'login';
  app.innerHTML = `<div class="auth card">
    <h1>⛳ ${esc(SITE_NAME)}</h1>
    <p class="muted">레슨 예약을 위해 ${login ? '로그인' : '회원가입'}해 주세요.</p>
    <div class="seg">
      <button class="${login ? 'on' : ''}" data-action="authMode" data-mode="login">로그인</button>
      <button class="${login ? '' : 'on'}" data-action="authMode" data-mode="signup">회원가입</button>
    </div>
    <form data-form="${login ? 'login' : 'signup'}">
      ${login ? '' : `
        <label>이름<input name="name" required autocomplete="name" /></label>
        <label>연락처<input name="phone" type="tel" required placeholder="010-0000-0000" autocomplete="tel" /></label>`}
      <label>이메일<input name="email" type="email" required autocomplete="email" /></label>
      <label>비밀번호<input name="password" type="password" minlength="6" required
        autocomplete="${login ? 'current-password' : 'new-password'}" placeholder="6자 이상" /></label>
      <button class="primary block" type="submit">${login ? '로그인' : '가입 신청'}</button>
    </form>
    ${login ? '<button class="link small" data-action="resetPw">비밀번호를 잊으셨나요?</button>'
            : '<p class="muted small">가입 후 프로님이 승인하면 레슨을 신청할 수 있습니다.</p>'}
  </div>`;
}

function renderWaiting() {
  const rejected = state.me.status === 'rejected';
  app.innerHTML = `<div class="auth card">
    <h1>${rejected ? '가입이 승인되지 않았습니다' : '가입 승인 대기 중'}</h1>
    <p>${esc(state.me.name)}님, ${rejected
      ? '가입 신청이 승인되지 않았습니다. 프로님께 문의해 주세요.'
      : '가입 신청이 접수되었습니다.<br/>프로님이 승인하면 레슨을 신청할 수 있어요.'}</p>
    <div class="row-btns">
      <button class="primary" data-action="refresh">승인 여부 다시 확인</button>
      <button data-action="logout">로그아웃</button>
    </div></div>`;
}

function renderNewPassword() {
  app.innerHTML = `<div class="auth card">
    <h1>새 비밀번호 설정</h1>
    <form data-form="newpw">
      <label>새 비밀번호<input name="password" type="password" minlength="6" required autocomplete="new-password" /></label>
      <button class="primary block" type="submit">변경하기</button>
    </form></div>`;
}

/* =====================================================================
   회원 화면
   ===================================================================== */
async function memberBook() {
  const from = state.weekStart;
  const [slots, pending] = await Promise.all([
    q(sb.rpc('get_slots', { p_from: from.toISOString(), p_to: addDays(from, 7).toISOString() })),
    q(sb.from('bookings').select('id').eq('member_id', state.me.id).eq('status', 'pending')),
  ]);
  const avail = Math.max(0, state.me.credits - pending.length);
  const now = new Date();

  const days = weekDays().map((d) => {
    const list = slots.filter((s) => sameDay(new Date(s.starts_at), d) && (s.is_open || s.my_status));
    return `<section class="day ${sameDay(d, now) ? 'today' : ''}">
      <h3>${fmtDate(d)}${sameDay(d, now) ? ' <span class="small">오늘</span>' : ''}</h3>
      ${list.length ? list.map((s) => memberSlotRow(s, now, avail)).join('') : empty('열린 레슨 타임이 없습니다')}
    </section>`;
  }).join('');

  return `<div class="card info">
      잔여 레슨 <b>${state.me.credits}회</b>
      ${pending.length ? ` · 승인 대기 ${pending.length}건 · 추가 신청 가능 <b>${avail}회</b>` : ''}
      ${state.me.credits === 0 ? '<div class="small">레슨 횟수가 없습니다. 프로님께 회원권 등록을 문의해 주세요.</div>' : ''}
    </div>
    ${weekNav()}
    <div class="days">${days}</div>`;
}

function memberSlotRow(s, now, avail) {
  const start = new Date(s.starts_at);
  const past = start <= now;
  const full = s.approved_count >= s.capacity;
  let right;
  if (s.my_status) right = badge(BOOKING_STATUS, s.my_status);
  else if (past) right = '<span class="muted small">지난 타임</span>';
  else if (full) right = '<span class="badge mute">마감</span>';
  else if (avail <= 0) right = '<span class="muted small">횟수 부족</span>';
  else right = `<button class="primary sm" data-action="request" data-id="${s.id}"
      data-label="${esc(fmtRange(s.starts_at, s.ends_at))} ${esc(s.title)}">신청</button>`;
  const seats = s.capacity > 1 ? ` · 그룹 ${s.approved_count}/${s.capacity}명` : ' · 1:1';
  return `<div class="slot ${past ? 'past' : ''}">
    <div><div class="time">${fmtTime(start)} – ${fmtTime(new Date(s.ends_at))}</div>
      <div class="small muted">${esc(s.title)}${seats}</div></div>
    <div class="slot-right">${right}</div></div>`;
}

async function memberMine() {
  const rows = await q(sb.from('bookings')
    .select('id, status, pro_note, created_at, slots(starts_at, ends_at, title)')
    .eq('member_id', state.me.id));
  const now = new Date();
  rows.sort((a, b) => new Date(a.slots.starts_at) - new Date(b.slots.starts_at));
  const upcoming = rows.filter((r) => ['pending', 'approved'].includes(r.status) && new Date(r.slots.starts_at) > now);
  const others = rows.filter((r) => !upcoming.includes(r)).reverse().slice(0, 30);

  const row = (r, active) => {
    const start = new Date(r.slots.starts_at);
    let act = '';
    if (active) {
      if (r.status === 'pending') act = `<button class="sm" data-action="cancel" data-id="${r.id}">신청 취소</button>`;
      else if ((start - now) / 36e5 >= CANCEL_HOURS) act = `<button class="sm" data-action="cancel" data-id="${r.id}" data-approved="1">예약 취소</button>`;
      else act = `<span class="small muted">취소 마감 · 프로님께 문의</span>`;
    }
    return `<div class="row">
      <div><b>${fmtRange(r.slots.starts_at, r.slots.ends_at)}</b>
        <div class="small muted">${esc(r.slots.title)}${r.pro_note ? ` · 사유: ${esc(r.pro_note)}` : ''}</div></div>
      <div class="row-right">${badge(BOOKING_STATUS, r.status)}${act}</div></div>`;
  };

  return `<div class="card"><h3>다가오는 레슨</h3>
      ${upcoming.length ? upcoming.map((r) => row(r, true)).join('') : empty('예정된 레슨이 없습니다')}
      <p class="small muted">확정된 레슨은 시작 ${CANCEL_HOURS}시간 전까지 취소할 수 있고, 취소하면 횟수가 돌아옵니다.</p>
    </div>
    <div class="card"><h3>지난 내역</h3>
      ${others.length ? others.map((r) => row(r, false)).join('') : empty('내역이 없습니다')}</div>`;
}

async function memberProfile() {
  const logs = await q(sb.from('credit_logs').select('*').eq('member_id', state.me.id)
    .order('created_at', { ascending: false }).limit(50));
  const m = state.me;
  return `<div class="card"><h3>내 정보</h3>
      <form data-form="profile">
        <label>이름<input name="name" value="${esc(m.name)}" required /></label>
        <label>연락처<input name="phone" type="tel" value="${esc(m.phone)}" /></label>
        <label>이메일<input value="${esc(m.email)}" disabled /></label>
        <button class="primary" type="submit">저장</button>
      </form></div>
    <div class="card"><h3>레슨 횟수 내역 <span class="pill">현재 ${m.credits}회</span></h3>${logList(logs)}</div>`;
}

function logList(logs) {
  if (!logs.length) return empty('내역이 없습니다');
  return `<ul class="logs">${logs.map((l) => `<li>
    <span class="muted small">${fmtDateTime(l.created_at)}</span>
    <span>${esc(l.reason)}</span>
    <b class="${l.delta > 0 ? 'plus' : 'minus'}">${l.delta > 0 ? '+' : ''}${l.delta}</b>
    <span class="muted small">잔여 ${l.balance}</span></li>`).join('')}</ul>`;
}

/* =====================================================================
   프로 화면
   ===================================================================== */
async function proProfile() {
  return `<div class="profile-page">
    <div class="card profile-hero">
      <div class="profile-photo-wrap">
        <img class="profile-photo" src="https://images.unsplash.com/photo-1535131749006-b7f58c99034b?auto=format&fit=crop&w=900&q=80" alt="프로 골퍼 사진" />
      </div>
      <div class="profile-copy">
        <p class="eyebrow">Premier Golf Coach</p>
        <h2>김프로</h2>
        <p class="lead">기본기와 경기 감각을 동시에 키우는 레슨을 추구합니다. 초보자는 정확한 스윙 루틴을, 중급 이상은 구질과 심리 관리까지 함께 다듬어 안정적인 플레이를 만들어갑니다.</p>
        <div class="profile-meta">
          <span class="pill">KPGA 투어 경력</span>
          <span class="pill">국가대표 참여</span>
          <span class="pill">1:1 맞춤 코칭</span>
        </div>
      </div>
    </div>

    <div class="card profile-block">
      <div class="section-head">
        <h3>나의 이력</h3>
        <span class="mini-tag">Career</span>
      </div>
      <ul class="history-list">
        <li>
          <strong>KPGA 투어 우승 10회</strong>
          <span>국내 주요 대회에서 우승하며 시즌 내내 안정적인 경기력과 압박 상황 대응력을 인정받았습니다.</span>
        </li>
        <li>
          <strong>올림픽 국가대표 참여</strong>
          <span>국가대표 선발 과정과 국제 대회 경험을 바탕으로, 큰 무대에서도 흔들리지 않는 플레이를 가르칩니다.</span>
        </li>
        <li>
          <strong>최연소 골프 프로 데뷔</strong>
          <span>젊은 나이에도 꾸준한 실전 경쟁을 통해 프로 무대에서 인정받았고, 이후 코칭에도 뛰어난 감각을 보였습니다.</span>
        </li>
        <li>
          <strong>아카데미 지도 경험</strong>
          <span>초보자부터 상급자까지 자세, 샷 메커니즘, 심리 관리, 라운드 전략까지 종합적으로 지도하고 있습니다.</span>
        </li>
      </ul>
    </div>

    <div class="card profile-block">
      <div class="section-head">
        <h3>주요 성과</h3>
        <span class="mini-tag">Achievements</span>
      </div>
      <div class="stat-grid">
        <div class="stat-box">
          <strong>10회</strong>
          <span>KPGA 투어 우승</span>
        </div>
        <div class="stat-box">
          <strong>국가대표</strong>
          <span>올림픽 국가대표 참여</span>
        </div>
        <div class="stat-box">
          <strong>1:1</strong>
          <span>맞춤형 레슨 운영</span>
        </div>
      </div>
    </div>
  </div>`;
}

async function proInbox() {
  const [reqs, newbies] = await Promise.all([
    q(sb.from('bookings')
      .select('id, created_at, slots(id, starts_at, ends_at, title, capacity, bookings(status)), profiles(name, phone, credits)')
      .eq('status', 'pending')),
    q(sb.from('profiles').select('*').eq('role', 'member').eq('status', 'pending').order('created_at')),
  ]);
  reqs.sort((a, b) => new Date(a.slots.starts_at) - new Date(b.slots.starts_at));
  const now = new Date();

  const reqHtml = reqs.map((r) => {
    const s = r.slots;
    const approved = s.bookings.filter((b) => b.status === 'approved').length;
    const full = approved >= s.capacity;
    const past = new Date(s.starts_at) <= now;
    return `<div class="row">
      <div>
        <b>${esc(r.profiles.name)}</b> <span class="small muted">${esc(r.profiles.phone)}</span>
        <span class="pill ${r.profiles.credits ? '' : 'danger'}">잔여 ${r.profiles.credits}회</span>
        <div>${fmtRange(s.starts_at, s.ends_at)} · ${esc(s.title)}
          ${s.capacity > 1 ? `<span class="small">(확정 ${approved}/${s.capacity}명)</span>` : ''}
          ${full ? '<span class="badge mute">정원 마감</span>' : ''}${past ? '<span class="badge mute">지난 타임</span>' : ''}</div>
        <div class="small muted">신청 ${fmtDateTime(r.created_at)}</div>
      </div>
      <div class="row-right">
        <button class="primary sm" data-action="approve" data-id="${r.id}" ${full ? 'disabled' : ''}>승인</button>
        <button class="sm" data-action="reject" data-id="${r.id}">거절</button>
      </div></div>`;
  }).join('');

  const newbieHtml = newbies.map((m) => `<div class="row">
      <div><b>${esc(m.name)}</b> <span class="small muted">${esc(m.phone)} · ${esc(m.email)}</span>
        <div class="small muted">가입 ${fmtDateTime(m.created_at)}</div></div>
      <div class="row-right">
        <button class="primary sm" data-action="memberStatus" data-id="${m.id}" data-status="approved">가입 승인</button>
        <button class="sm" data-action="memberStatus" data-id="${m.id}" data-status="rejected">거절</button>
      </div></div>`).join('');

  return `<div class="card"><h3>레슨 신청 <span class="pill">${reqs.length}</span></h3>
      ${reqHtml || empty('대기 중인 레슨 신청이 없습니다')}</div>
    <div class="card"><h3>가입 신청 <span class="pill">${newbies.length}</span></h3>
      ${newbieHtml || empty('대기 중인 가입 신청이 없습니다')}
      ${newbies.length ? '<p class="small muted">가입 승인 후 회원 관리에서 레슨 횟수를 등록해 주세요.</p>' : ''}</div>`;
}

async function proSchedule() {
  const from = state.weekStart;
  const slots = await q(sb.from('slots')
    .select('*, bookings(id, status, profiles(name, phone))')
    .gte('starts_at', from.toISOString()).lt('starts_at', addDays(from, 7).toISOString())
    .order('starts_at'));
  const now = new Date();
  const confirmed = slots.reduce((n, s) => n + s.bookings.filter((b) => b.status === 'approved').length, 0);

  const slotCard = (s) => {
    const active = s.bookings.filter((b) => ['pending', 'approved'].includes(b.status))
      .sort((a, b) => (a.status === 'approved' ? -1 : 1));
    const approved = active.filter((b) => b.status === 'approved').length;
    const past = new Date(s.starts_at) <= now;
    const people = active.map((b) => `<div class="person">
        <span>${esc(b.profiles.name)} <span class="small muted">${esc(b.profiles.phone)}</span></span>
        <span class="row-right">${badge(BOOKING_STATUS, b.status)}
          ${b.status === 'pending'
            ? `<button class="primary sm" data-action="approve" data-id="${b.id}">승인</button>
               <button class="sm" data-action="reject" data-id="${b.id}">거절</button>`
            : `<button class="sm" data-action="proCancel" data-id="${b.id}">취소</button>`}</span>
      </div>`).join('');
    return `<div class="slot-card ${past ? 'past' : ''} ${s.is_open ? '' : 'closed'}">
      <div class="slot-head">
        <div><span class="time">${fmtTime(new Date(s.starts_at))} – ${fmtTime(new Date(s.ends_at))}</span>
          <span class="small muted">${esc(s.title)} · ${s.capacity > 1 ? `확정 ${approved}/${s.capacity}명` : (approved ? '확정' : '1:1')}</span>
          ${s.is_open ? '' : '<span class="badge mute">닫힘</span>'}</div>
        <div class="row-right">
          <button class="link small" data-action="toggleSlot" data-id="${s.id}" data-open="${s.is_open ? 1 : 0}">${s.is_open ? '닫기' : '열기'}</button>
          <button class="link small danger" data-action="deleteSlot" data-id="${s.id}" data-n="${approved}">삭제</button>
        </div>
      </div>
      ${people || '<div class="small muted">신청자 없음</div>'}
    </div>`;
  };

  const days = weekDays().map((d) => {
    const list = slots.filter((s) => sameDay(new Date(s.starts_at), d));
    return `<section class="day ${sameDay(d, now) ? 'today' : ''}">
      <h3>${fmtDate(d)}${sameDay(d, now) ? ' <span class="small">오늘</span>' : ''}</h3>
      ${list.length ? list.map(slotCard).join('') : empty('타임 없음')}</section>`;
  }).join('');

  return `${weekNav()}
    <p class="small muted center">이번 주 타임 ${slots.length}개 · 확정 레슨 ${confirmed}건 ·
      <button class="link small" data-action="tab" data-tab="slots">+ 타임 만들기</button></p>
    <div class="days">${days}</div>`;
}

async function proSlots() {
  const today = ymd(new Date());
  return `<div class="card"><h3>레슨 타임 만들기</h3>
    <form data-form="slots">
      <div class="grid2">
        <label>시작 날짜<input type="date" name="from" value="${today}" required /></label>
        <label>종료 날짜<input type="date" name="to" value="${today}" required /></label>
      </div>
      <fieldset class="dows"><legend>요일</legend>
        ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label class="chk"><input type="checkbox" name="dow" value="${d}"
          ${d >= 1 && d <= 5 ? 'checked' : ''} /> ${DOW[d]}</label>`).join('')}
      </fieldset>
      <div class="grid2">
        <label>첫 레슨 시작<input type="time" name="start" value="10:00" required /></label>
        <label>마지막 레슨 끝<input type="time" name="end" value="18:00" required /></label>
      </div>
      <div class="grid3">
        <label>레슨 시간(분)<input type="number" name="len" value="50" min="10" step="5" required /></label>
        <label>쉬는 시간(분)<input type="number" name="gap" value="10" min="0" step="5" required /></label>
        <label>정원(명)<input type="number" name="cap" value="1" min="1" required /></label>
      </div>
      <label>레슨 이름<input name="title" value="개인 레슨" required /></label>
      <p class="small muted">예) 10:00~18:00, 레슨 50분 + 휴식 10분 → 10시, 11시, … 17시 시작 8타임<br/>
        그룹 레슨은 정원을 2명 이상으로 하고 이름을 '그룹 레슨'으로 바꿔 만드세요.<br/>
        같은 시각에 이미 있는 타임은 건너뜁니다.</p>
      <button class="primary" type="submit">타임 만들기</button>
    </form></div>`;
}

async function proMembers() {
  const members = await q(sb.from('profiles').select('*').eq('role', 'member').order('name'));
  const order = { pending: 0, approved: 1, rejected: 2 };
  members.sort((a, b) => order[a.status] - order[b.status]);

  let detail = '';
  if (state.openMember) {
    const [logs, books] = await Promise.all([
      q(sb.from('credit_logs').select('*').eq('member_id', state.openMember)
        .order('created_at', { ascending: false }).limit(30)),
      q(sb.from('bookings').select('status, slots(starts_at, ends_at, title)').eq('member_id', state.openMember)),
    ]);
    books.sort((a, b) => new Date(b.slots.starts_at) - new Date(a.slots.starts_at));
    detail = `<div class="detail">
      <h4>최근 레슨</h4>
      ${books.length ? `<ul class="logs">${books.slice(0, 20).map((b) => `<li>
        <span>${fmtRange(b.slots.starts_at, b.slots.ends_at)}</span><span class="small muted">${esc(b.slots.title)}</span>
        ${badge(BOOKING_STATUS, b.status)}</li>`).join('')}</ul>` : empty('레슨 내역 없음')}
      <h4>횟수 내역</h4>${logList(logs)}</div>`;
  }

  const card = (m) => {
    const open = state.openMember === m.id;
    return `<div class="member" data-search="${esc(`${m.name} ${m.phone} ${m.email}`.toLowerCase())}">
      <div class="member-head">
        <div><b>${esc(m.name)}</b> ${badge(MEMBER_STATUS, m.status)}
          <div class="small muted">${esc(m.phone)} · ${esc(m.email)}</div></div>
        <div class="credits-big">${m.credits}<span class="small">회</span></div>
      </div>
      <div class="member-actions">
        ${m.status === 'approved' ? `
          <form data-form="credits" data-id="${m.id}" class="inline">
            <input name="delta" type="number" placeholder="+10 / -1" required />
            <input name="reason" placeholder="사유 (예: 10회권 결제)" />
            <button class="sm primary" type="submit">횟수 적용</button>
          </form>` : `
          <button class="primary sm" data-action="memberStatus" data-id="${m.id}" data-status="approved">가입 승인</button>
          ${m.status === 'pending' ? `<button class="sm" data-action="memberStatus" data-id="${m.id}" data-status="rejected">거절</button>` : ''}`}
        <button class="link small" data-action="toggleMember" data-id="${m.id}">${open ? '내역 닫기' : '내역 보기'}</button>
      </div>
      ${open ? detail : ''}
    </div>`;
  };

  return `<div class="card">
    <h3>회원 관리 <span class="pill">${members.length}명</span></h3>
    <input class="search" data-filter placeholder="이름·연락처·이메일 검색" />
    ${members.length ? members.map(card).join('') : empty('아직 가입한 회원이 없습니다')}
  </div>`;
}

/* =====================================================================
   버튼 동작
   ===================================================================== */
const actions = {
  async tab({ tab }) { state.tab = tab; state.openMember = null; await render(); scrollTo(0, 0); },
  async week({ d }) {
    state.weekStart = d === '0' ? startOfWeek(new Date()) : addDays(state.weekStart, Number(d));
    await render();
  },
  async logout() { await sb.auth.signOut(); },
  authMode({ mode }) { state.authMode = mode; renderAuth(); },
  async refresh() { const { data } = await sb.auth.getSession(); await boot(data.session); },
  async resetPw() {
    const email = app.querySelector('input[name=email]')?.value.trim();
    if (!email) return toast('이메일 칸에 가입한 이메일을 먼저 입력해 주세요.', 'err');
    await q(sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname }));
    toast('비밀번호 재설정 메일을 보냈습니다.');
  },

  // 회원
  async request({ id, label }) {
    if (!confirm(`${label}\n이 레슨을 신청할까요?`)) return;
    await q(sb.rpc('request_booking', { p_slot_id: Number(id) }));
    toast('신청했습니다. 프로님 승인을 기다려 주세요.');
    await render();
  },
  async cancel({ id, approved }) {
    const msg = approved ? '확정된 예약을 취소할까요? 레슨 횟수 1회가 돌아옵니다.' : '신청을 취소할까요?';
    if (!confirm(msg)) return;
    await q(sb.rpc('cancel_booking', { p_booking_id: Number(id) }));
    toast('취소했습니다.');
    await render();
  },

  // 프로
  async approve({ id }) {
    await q(sb.rpc('approve_booking', { p_booking_id: Number(id) }));
    toast('승인했습니다. 회원 횟수 1회가 차감되었습니다.');
    await render();
  },
  async reject({ id }) {
    const reason = prompt('거절 사유 (회원에게 표시됩니다, 비워도 됩니다)', '');
    if (reason === null) return;
    await q(sb.rpc('reject_booking', { p_booking_id: Number(id), p_reason: reason }));
    toast('거절했습니다.');
    await render();
  },
  async proCancel({ id }) {
    const reason = prompt('확정된 레슨을 취소합니다. 회원 횟수 1회가 환불됩니다.\n취소 사유 (비워도 됩니다)', '');
    if (reason === null) return;
    await q(sb.rpc('cancel_booking', { p_booking_id: Number(id), p_reason: reason }));
    toast('취소하고 환불했습니다.');
    await render();
  },
  async toggleSlot({ id, open }) {
    await q(sb.from('slots').update({ is_open: open !== '1' }).eq('id', Number(id)));
    await render();
  },
  async deleteSlot({ id, n }) {
    const msg = Number(n) > 0
      ? `확정된 회원 ${n}명이 있습니다. 삭제하면 예약이 취소되고 횟수가 환불됩니다. 삭제할까요?`
      : '이 타임을 삭제할까요?';
    if (!confirm(msg)) return;
    await q(sb.rpc('delete_slot', { p_slot_id: Number(id) }));
    toast('삭제했습니다.');
    await render();
  },
  async memberStatus({ id, status }) {
    await q(sb.from('profiles').update({ status }).eq('id', id));
    toast(status === 'approved' ? '가입을 승인했습니다.' : '가입을 거절했습니다.');
    await render();
  },
  async toggleMember({ id }) {
    state.openMember = state.openMember === id ? null : id;
    await render();
  },
};

/* =====================================================================
   폼 제출
   ===================================================================== */
const forms = {
  async login(f) {
    await q(sb.auth.signInWithPassword({ email: f.get('email').trim(), password: f.get('password') }));
  },
  async signup(f) {
    const data = await q(sb.auth.signUp({
      email: f.get('email').trim(),
      password: f.get('password'),
      options: {
        data: { name: f.get('name').trim(), phone: f.get('phone').trim() },
        emailRedirectTo: location.origin + location.pathname,
      },
    }));
    if (!data.session) {
      state.authMode = 'login';
      renderAuth();
      toast('인증 메일을 보냈습니다. 메일의 링크를 누른 뒤 로그인해 주세요.');
    }
  },
  async newpw(f) {
    await q(sb.auth.updateUser({ password: f.get('password') }));
    state.recovering = false;
    history.replaceState(null, '', location.pathname);
    toast('비밀번호를 변경했습니다.');
    const { data } = await sb.auth.getSession();
    await boot(data.session);
  },
  async profile(f) {
    await q(sb.from('profiles').update({ name: f.get('name').trim(), phone: f.get('phone').trim() }).eq('id', state.me.id));
    toast('저장했습니다.');
    await render();
  },
  async credits(f, form) {
    const delta = parseInt(f.get('delta'), 10);
    if (!delta) return toast('횟수를 숫자로 입력해 주세요. (예: 10, -1)', 'err');
    await q(sb.rpc('adjust_credits', { p_member_id: form.dataset.id, p_delta: delta, p_reason: f.get('reason').trim() }));
    toast(`횟수를 ${delta > 0 ? '+' : ''}${delta} 적용했습니다.`);
    await render();
  },
  async slots(f) {
    const from = new Date(`${f.get('from')}T00:00`);
    const to = new Date(`${f.get('to')}T00:00`);
    const dows = new Set(f.getAll('dow').map(Number));
    const [sh, sm] = f.get('start').split(':').map(Number);
    const [eh, em] = f.get('end').split(':').map(Number);
    const len = Number(f.get('len'));
    const step = len + Number(f.get('gap'));
    const capacity = Number(f.get('cap'));
    const title = f.get('title').trim() || '레슨';

    if (to < from) return toast('종료 날짜가 시작 날짜보다 빠릅니다.', 'err');
    if ((to - from) / 864e5 > 92) return toast('한 번에 최대 3개월까지 만들 수 있습니다.', 'err');
    if (!dows.size) return toast('요일을 하나 이상 선택해 주세요.', 'err');

    const rows = [];
    for (let d = new Date(from); d <= to; d = addDays(d, 1)) {
      if (!dows.has(d.getDay())) continue;
      for (let m = sh * 60 + sm; m + len <= eh * 60 + em; m += step) {
        const s = new Date(d);
        s.setHours(0, m, 0, 0);
        rows.push({ starts_at: s.toISOString(), ends_at: new Date(s.getTime() + len * 6e4).toISOString(), capacity, title });
      }
    }
    if (!rows.length) return toast('조건에 맞는 타임이 없습니다. 시간을 확인해 주세요.', 'err');
    if (rows.length > 600) return toast(`타임이 너무 많습니다(${rows.length}개). 기간을 나눠서 만들어 주세요.`, 'err');

    // 같은 시각에 이미 있는 타임은 제외
    const existing = await q(sb.from('slots').select('starts_at')
      .gte('starts_at', rows[0].starts_at).lte('starts_at', rows.at(-1).starts_at));
    const taken = new Set(existing.map((e) => new Date(e.starts_at).getTime()));
    const fresh = rows.filter((r) => !taken.has(new Date(r.starts_at).getTime()));
    const skipped = rows.length - fresh.length;

    if (!fresh.length) return toast('모두 이미 있는 타임입니다.', 'err');
    if (!confirm(`${fresh.length}개의 타임을 만듭니다.${skipped ? ` (이미 있는 ${skipped}개 제외)` : ''}`)) return;
    await q(sb.from('slots').insert(fresh));
    toast(`${fresh.length}개 타임을 만들었습니다.`);
    state.weekStart = startOfWeek(from);
    state.tab = 'schedule';
    await render();
  },
};

/* =====================================================================
   이벤트 연결
   ===================================================================== */
app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  e.preventDefault();
  el.disabled = true;
  try { await fn({ ...el.dataset }); }
  catch (err) { toast(errText(err), 'err'); }
  finally { if (el.isConnected) el.disabled = false; }
});

app.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const btn = form.querySelector('button[type=submit]');
  if (btn) btn.disabled = true;
  try { await forms[form.dataset.form](new FormData(form), form); }
  catch (err) { toast(errText(err), 'err'); }
  finally { if (btn?.isConnected) btn.disabled = false; }
});

app.addEventListener('input', (e) => {
  if (!e.target.matches('[data-filter]')) return;
  const v = e.target.value.trim().toLowerCase();
  app.querySelectorAll('[data-search]').forEach((el) => { el.hidden = !!v && !el.dataset.search.includes(v); });
});
