# ⛳ 골프 레슨 예약 사이트

회원이 프로님이 열어둔 레슨 타임에 신청하면, 프로님이 승인해서 예약을 확정하는 웹사이트입니다.
Supabase(DB·로그인)와 GitHub Pages(무료 호스팅)로 동작하고, 서버 비용 없이 운영할 수 있습니다.

## 기능

**회원**
- 회원가입(이름·연락처·이메일). 프로님이 가입을 승인해야 예약할 수 있습니다.
- 주간 캘린더에서 열린 타임을 보고 신청합니다. 1:1 레슨과 그룹 레슨 정원이 표시됩니다.
- 내 예약에서 상태(승인 대기/확정/거절/취소)를 확인하고 취소할 수 있습니다.
- 확정된 레슨은 시작 24시간 전까지 취소할 수 있고, 취소하면 횟수가 돌아옵니다.
- 잔여 레슨 횟수와 변동 내역을 볼 수 있습니다.

**프로**
- **승인함**: 레슨 신청과 가입 신청을 승인하거나 거절합니다.
- **일정표**: 주간 타임과 신청자를 보고, 승인·거절·취소, 타임 닫기·삭제를 합니다.
- **타임 만들기**: 기간·요일·시간대·레슨 길이·쉬는 시간·정원을 정해서 타임을 한 번에 만듭니다.
- **회원 관리**: 회원 검색, 레슨 횟수 추가·차감(예: 10회권 등록 시 +10), 회원별 레슨·횟수 내역을 봅니다.

**규칙** (DB에서 강제되므로 화면을 조작해도 우회할 수 없습니다)
- 횟수는 **승인할 때 1회 차감**됩니다. 거절되거나 대기 중에 취소하면 차감되지 않습니다.
- 회원은 "잔여 횟수 − 승인 대기 건수"만큼만 새로 신청할 수 있습니다.
- 정원이 찬 타임은 더 이상 승인할 수 없습니다.
- 확정 예약을 취소하거나 타임을 삭제하면 횟수가 자동 환불됩니다.
- 회원은 본인 정보와 본인 예약만 볼 수 있습니다.

## 파일 구성

| 파일 | 설명 |
|---|---|
| `index.html` | 페이지 뼈대 |
| `app.js` | 화면과 동작 전체 |
| `style.css` | 디자인 |
| `config.js` | **Supabase 주소/키, 사이트 이름 설정 (여기만 수정)** |
| `schema.sql` | Supabase에 한 번 실행할 DB 설정 |

---

## 설치 방법

### 1. Supabase 프로젝트 만들기
1. https://supabase.com 에 가입하고 **New project**를 만듭니다. 지역은 `Northeast Asia (Seoul)`을 추천합니다.
2. 왼쪽 메뉴 **SQL Editor** → **New query**에 `schema.sql` 내용을 전부 붙여넣고 **Run**을 누릅니다.
   `Success. No rows returned`가 나오면 성공입니다.

### 2. 로그인(Auth) 설정
Supabase 대시보드 **Authentication** 메뉴에서:
1. **URL Configuration**
   - **Site URL**: 배포할 주소. 예: `https://내깃허브아이디.github.io/golf-lesson/`
   - **Redirect URLs**에도 같은 주소를 추가합니다.
2. **이메일 인증 끄기 (권장)**: Sign In / Providers → Email → **Confirm email**을 끕니다.
   어차피 프로님이 가입을 승인하는 구조라서 메일 인증 없이도 안전합니다. Supabase 기본 메일 발송은
   시간당 보낼 수 있는 양이 매우 적어서, 켜 두면 회원이 몰릴 때 인증 메일이 안 갈 수 있습니다.
   (메일 인증을 쓰려면 Authentication → Emails 에서 SMTP를 따로 연결하세요.)

### 3. `config.js` 수정
Supabase 대시보드 상단 **Connect** 버튼(또는 Project Settings → API Keys)에서 복사합니다.

```js
export const SUPABASE_URL = 'https://abcdefgh.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGci...';   // anon public 키 또는 sb_publishable_... 키
export const SITE_NAME = '김프로 골프 레슨';
```

> ⚠️ `service_role` 키나 `secret` 키는 **절대** 넣지 마세요. anon/publishable 키는 공개돼도 괜찮습니다.

### 4. GitHub Pages로 배포
1. GitHub에서 새 저장소를 만듭니다(예: `golf-lesson`, Public).
2. **Add file → Upload files**로 5개 파일(`index.html`, `app.js`, `style.css`, `config.js`, `README.md`)을 올리고 Commit 합니다.
   (`schema.sql`도 함께 올려도 괜찮습니다. DB 비밀번호 같은 비밀 정보는 들어 있지 않습니다.)
3. 저장소 **Settings → Pages** → Source: **Deploy from a branch**, Branch: `main` / `/ (root)` → Save
4. 1~2분 뒤 `https://내아이디.github.io/golf-lesson/` 로 접속됩니다.

이후 파일을 수정해서 다시 올리면 자동으로 재배포됩니다.

### 5. 프로님 계정 지정
1. 배포된 사이트에서 프로님 본인 이메일로 **회원가입**합니다.
2. Supabase **SQL Editor**에서 이메일을 바꿔 실행합니다.
   ```sql
   update public.profiles set role = 'pro', status = 'approved'
    where email = '프로님이메일@example.com';
   ```
3. 사이트를 새로고침하면 프로 화면(승인함·일정표·타임 만들기·회원 관리)이 나옵니다.

---

## 사용 흐름

1. **프로**: 타임 만들기 → 예) 11/10~11/30, 월·수·금, 10:00~18:00, 50분 + 휴식 10분
2. **회원**: 가입 → **프로**가 승인함에서 가입 승인 → 회원 관리에서 `+10` (10회권)
3. **회원**: 레슨 신청 탭에서 원하는 타임 **신청** → 승인 대기
4. **프로**: 승인함에서 **승인** → 예약 확정, 회원 잔여 횟수 10 → 9
5. **회원**: 내 예약에서 확정 확인

## 자주 바꾸는 설정

- **취소 마감 시간 변경 (기본 24시간)**
  `config.js`의 `CANCEL_HOURS`와 `schema.sql`의 `cancel_booking` 함수 안 `interval '24 hours'`를
  같은 값으로 바꾸고, 바뀐 함수 부분을 SQL Editor에서 다시 실행하세요.
- **사이트 이름**: `config.js`의 `SITE_NAME`
- **색상**: `style.css` 맨 위 `--green` 값

## 참고
- Supabase 무료 플랜은 일정 기간 접속이 없으면 프로젝트가 일시 정지될 수 있습니다. 대시보드에서 다시 켤 수 있고, 꾸준히 쓰면 문제없습니다.
- 휴대폰에서 사이트를 연 뒤 "홈 화면에 추가"를 하면 앱처럼 쓸 수 있습니다.
