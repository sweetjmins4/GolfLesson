-- =====================================================================
--  골프 레슨 예약 시스템 - Supabase 스키마
--  사용법: Supabase 대시보드 > SQL Editor > New query 에 전체를 붙여넣고 Run
--  여러 번 실행해도 안전하도록 작성되어 있습니다.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. 테이블
-- ---------------------------------------------------------------------

-- 회원 정보 (auth.users 와 1:1)
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null default '',
  name        text not null default '',
  phone       text not null default '',
  role        text not null default 'member' check (role in ('member', 'pro')),
  status      text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  credits     int  not null default 0 check (credits >= 0),   -- 잔여 레슨 횟수
  created_at  timestamptz not null default now()
);

-- 레슨 타임 (프로가 여는 시간)
create table if not exists public.slots (
  id          bigint generated always as identity primary key,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  capacity    int  not null default 1 check (capacity >= 1),   -- 정원 (1 = 1:1 레슨)
  title       text not null default '개인 레슨',
  is_open     boolean not null default true,                    -- false 면 회원에게 안 보임
  created_at  timestamptz not null default now(),
  check (ends_at > starts_at)
);
create index if not exists slots_starts_at_idx on public.slots (starts_at);

-- 레슨 신청
create table if not exists public.bookings (
  id          bigint generated always as identity primary key,
  slot_id     bigint not null references public.slots(id) on delete cascade,
  member_id   uuid   not null references public.profiles(id) on delete cascade,
  status      text   not null default 'pending'
              check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  pro_note    text   not null default '',   -- 거절/취소 사유
  created_at  timestamptz not null default now(),
  decided_at  timestamptz
);
-- 같은 타임에 같은 회원이 '대기/확정' 신청을 두 개 가질 수 없음
create unique index if not exists bookings_one_active_idx
  on public.bookings (slot_id, member_id) where status in ('pending', 'approved');
create index if not exists bookings_member_idx on public.bookings (member_id);

-- 레슨 횟수 변동 내역
create table if not exists public.credit_logs (
  id          bigint generated always as identity primary key,
  member_id   uuid not null references public.profiles(id) on delete cascade,
  delta       int  not null,          -- +10, -1 ...
  balance     int  not null,          -- 변동 후 잔여 횟수
  reason      text not null default '',
  booking_id  bigint references public.bookings(id) on delete set null,
  created_at  timestamptz not null default now()
);
create index if not exists credit_logs_member_idx on public.credit_logs (member_id);


-- ---------------------------------------------------------------------
-- 2. 기본 함수 / 트리거
-- ---------------------------------------------------------------------

-- 현재 로그인한 사람이 프로인지
create or replace function public.is_pro()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'pro');
$$;

-- 현재 로그인한 사람이 가입 승인된 회원(또는 프로)인지
create or replace function public.is_approved()
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from public.profiles
                 where id = auth.uid() and (status = 'approved' or role = 'pro'));
$$;

-- 회원가입 시 profiles 자동 생성 (가입 화면에서 받은 이름/연락처 사용)
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, name, phone)
  values (
    new.id,
    coalesce(new.email, ''),
    coalesce(new.raw_user_meta_data ->> 'name', ''),
    coalesce(new.raw_user_meta_data ->> 'phone', '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 회원이 자기 프로필을 수정할 때 이름/연락처만 바꿀 수 있게 보호
-- (역할·가입상태·잔여횟수는 프로 또는 아래 예약 함수만 변경 가능)
create or replace function public.protect_profile_fields()
returns trigger
language plpgsql
as $$
begin
  if current_user in ('authenticated', 'anon') and not public.is_pro() then
    new.id      := old.id;
    new.email   := old.email;
    new.role    := old.role;
    new.status  := old.status;
    new.credits := old.credits;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_profile_fields on public.profiles;
create trigger protect_profile_fields
  before update on public.profiles
  for each row execute function public.protect_profile_fields();


-- ---------------------------------------------------------------------
-- 3. 예약 관련 함수 (웹사이트에서 supabase.rpc(...) 로 호출)
--    신청/승인/취소/환불은 모두 이 함수들을 통해서만 일어납니다.
-- ---------------------------------------------------------------------

-- 기간 내 레슨 타임 + 신청 현황 (회원 화면용)
create or replace function public.get_slots(p_from timestamptz, p_to timestamptz)
returns table (
  id bigint, starts_at timestamptz, ends_at timestamptz, capacity int, title text,
  is_open boolean, approved_count int, pending_count int, my_status text
)
language sql stable security definer set search_path = public
as $$
  select
    s.id, s.starts_at, s.ends_at, s.capacity, s.title, s.is_open,
    (select count(*) from public.bookings b where b.slot_id = s.id and b.status = 'approved')::int,
    (select count(*) from public.bookings b where b.slot_id = s.id and b.status = 'pending')::int,
    (select b.status from public.bookings b
      where b.slot_id = s.id and b.member_id = auth.uid() and b.status in ('pending', 'approved')
      limit 1)
  from public.slots s
  where s.starts_at >= p_from and s.starts_at < p_to
    and public.is_approved()
  order by s.starts_at;
$$;

-- [회원] 레슨 신청
create or replace function public.request_booking(p_slot_id bigint)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
  v_me       public.profiles;
  v_slot     public.slots;
  v_approved int;
  v_pending  int;
  v_id       bigint;
begin
  select * into v_me from public.profiles where id = auth.uid();
  if v_me.id is null or v_me.status <> 'approved' then
    raise exception '가입 승인 후 예약할 수 있습니다.';
  end if;

  select * into v_slot from public.slots where id = p_slot_id;
  if v_slot.id is null or not v_slot.is_open then
    raise exception '신청할 수 없는 타임입니다.';
  end if;
  if v_slot.starts_at <= now() then
    raise exception '이미 지난 타임입니다.';
  end if;

  select count(*) into v_approved from public.bookings
   where slot_id = p_slot_id and status = 'approved';
  if v_approved >= v_slot.capacity then
    raise exception '정원이 마감된 타임입니다.';
  end if;

  -- 횟수는 승인 시 차감되므로, 대기 중인 신청 수만큼은 미리 확보되어 있어야 함
  select count(*) into v_pending from public.bookings
   where member_id = auth.uid() and status = 'pending';
  if v_me.credits - v_pending <= 0 then
    raise exception '잔여 레슨 횟수가 부족합니다. (승인 대기 중인 신청 %건 포함)', v_pending;
  end if;

  insert into public.bookings (slot_id, member_id)
  values (p_slot_id, auth.uid())
  returning id into v_id;
  return v_id;
exception
  when unique_violation then
    raise exception '이미 신청한 타임입니다.';
end;
$$;

-- [프로] 신청 승인 → 회원 잔여 횟수 1회 차감
create or replace function public.approve_booking(p_booking_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_b        public.bookings;
  v_slot     public.slots;
  v_approved int;
  v_credits  int;
begin
  if not public.is_pro() then raise exception '권한이 없습니다.'; end if;

  select * into v_b from public.bookings where id = p_booking_id for update;
  if v_b.id is null or v_b.status <> 'pending' then
    raise exception '대기 중인 신청이 아닙니다.';
  end if;

  -- 같은 타임을 동시에 승인하는 경우를 막기 위해 타임 행을 잠금
  select * into v_slot from public.slots where id = v_b.slot_id for update;
  select count(*) into v_approved from public.bookings
   where slot_id = v_slot.id and status = 'approved';
  if v_approved >= v_slot.capacity then
    raise exception '정원(%명)이 이미 찼습니다.', v_slot.capacity;
  end if;

  update public.profiles set credits = credits - 1
   where id = v_b.member_id and credits >= 1
  returning credits into v_credits;
  if v_credits is null then
    raise exception '회원의 잔여 레슨 횟수가 없습니다. 회원 관리에서 횟수를 추가해 주세요.';
  end if;

  update public.bookings set status = 'approved', decided_at = now() where id = p_booking_id;

  insert into public.credit_logs (member_id, delta, balance, reason, booking_id)
  values (v_b.member_id, -1, v_credits, '레슨 승인', p_booking_id);
end;
$$;

-- [프로] 신청 거절
create or replace function public.reject_booking(p_booking_id bigint, p_reason text default '')
returns void
language plpgsql security definer set search_path = public
as $$
begin
  if not public.is_pro() then raise exception '권한이 없습니다.'; end if;
  update public.bookings
     set status = 'rejected', decided_at = now(), pro_note = coalesce(p_reason, '')
   where id = p_booking_id and status = 'pending';
  if not found then raise exception '대기 중인 신청이 아닙니다.'; end if;
end;
$$;

-- [회원/프로] 예약 취소. 확정된 예약이면 횟수 1회 환불
--   회원은 레슨 시작 24시간 전까지만 확정 예약을 취소할 수 있음 (프로는 언제나 가능)
--   ※ 24시간을 바꾸려면 아래 interval 과 config.js 의 CANCEL_HOURS 를 같이 바꾸세요.
create or replace function public.cancel_booking(p_booking_id bigint, p_reason text default '')
returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_b       public.bookings;
  v_start   timestamptz;
  v_pro     boolean := public.is_pro();
  v_credits int;
begin
  select * into v_b from public.bookings where id = p_booking_id for update;
  if v_b.id is null or (v_b.member_id <> auth.uid() and not v_pro) then
    raise exception '예약을 찾을 수 없습니다.';
  end if;
  if v_b.status not in ('pending', 'approved') then
    raise exception '이미 처리된 예약입니다.';
  end if;

  select starts_at into v_start from public.slots where id = v_b.slot_id;

  if v_b.status = 'approved' then
    if not v_pro and v_start - now() < interval '24 hours' then
      raise exception '확정된 레슨은 시작 24시간 전까지만 취소할 수 있습니다. 프로님께 문의해 주세요.';
    end if;
    update public.profiles set credits = credits + 1
     where id = v_b.member_id
    returning credits into v_credits;
    insert into public.credit_logs (member_id, delta, balance, reason, booking_id)
    values (v_b.member_id, 1, v_credits,
            case when v_pro then '레슨 취소 환불 (프로)' else '레슨 취소 환불' end, v_b.id);
  end if;

  update public.bookings
     set status = 'cancelled', decided_at = now(),
         pro_note = case when v_pro then coalesce(p_reason, '') else pro_note end
   where id = v_b.id;
end;
$$;

-- [프로] 타임 삭제 (확정된 회원은 자동 환불)
create or replace function public.delete_slot(p_slot_id bigint)
returns void
language plpgsql security definer set search_path = public
as $$
declare
  r         record;
  v_credits int;
begin
  if not public.is_pro() then raise exception '권한이 없습니다.'; end if;
  for r in
    select * from public.bookings where slot_id = p_slot_id and status = 'approved' for update
  loop
    update public.profiles set credits = credits + 1 where id = r.member_id
    returning credits into v_credits;
    insert into public.credit_logs (member_id, delta, balance, reason)
    values (r.member_id, 1, v_credits, '레슨 타임 삭제 환불');
  end loop;
  delete from public.slots where id = p_slot_id;
end;
$$;

-- [프로] 회원 레슨 횟수 추가/차감 (예: 10회권 등록 → +10)
create or replace function public.adjust_credits(p_member_id uuid, p_delta int, p_reason text default '')
returns int
language plpgsql security definer set search_path = public
as $$
declare
  v_now int;
  v_credits int;
begin
  if not public.is_pro() then raise exception '권한이 없습니다.'; end if;
  if coalesce(p_delta, 0) = 0 then raise exception '변경할 횟수를 입력해 주세요.'; end if;

  select credits into v_now from public.profiles where id = p_member_id for update;
  if v_now is null then raise exception '회원을 찾을 수 없습니다.'; end if;
  if v_now + p_delta < 0 then
    raise exception '잔여 횟수(%회)보다 많이 차감할 수 없습니다.', v_now;
  end if;

  update public.profiles set credits = credits + p_delta where id = p_member_id
  returning credits into v_credits;
  insert into public.credit_logs (member_id, delta, balance, reason)
  values (p_member_id, p_delta, v_credits,
          coalesce(nullif(p_reason, ''), case when p_delta > 0 then '횟수 추가' else '횟수 차감' end));
  return v_credits;
end;
$$;


-- ---------------------------------------------------------------------
-- 4. RLS (행 단위 보안) - 누가 무엇을 볼 수 있는지
-- ---------------------------------------------------------------------
alter table public.profiles    enable row level security;
alter table public.slots       enable row level security;
alter table public.bookings    enable row level security;
alter table public.credit_logs enable row level security;

-- profiles: 본인 또는 프로만 조회/수정
drop policy if exists "profiles_select" on public.profiles;
create policy "profiles_select" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_pro());

drop policy if exists "profiles_update" on public.profiles;
create policy "profiles_update" on public.profiles
  for update to authenticated
  using (id = auth.uid() or public.is_pro())
  with check (id = auth.uid() or public.is_pro());

-- slots: 승인된 회원은 조회, 생성/수정은 프로만 (삭제는 delete_slot 함수로)
drop policy if exists "slots_pro_select" on public.slots;
drop policy if exists "slots_select" on public.slots;
create policy "slots_select" on public.slots
  for select to authenticated using (public.is_approved());

drop policy if exists "slots_pro_insert" on public.slots;
create policy "slots_pro_insert" on public.slots
  for insert to authenticated with check (public.is_pro());

drop policy if exists "slots_pro_update" on public.slots;
create policy "slots_pro_update" on public.slots
  for update to authenticated using (public.is_pro()) with check (public.is_pro());

-- bookings: 본인 신청 또는 프로만 조회 (생성/변경은 위 함수로만)
drop policy if exists "bookings_select" on public.bookings;
create policy "bookings_select" on public.bookings
  for select to authenticated using (member_id = auth.uid() or public.is_pro());

-- credit_logs: 본인 또는 프로만 조회
drop policy if exists "credit_logs_select" on public.credit_logs;
create policy "credit_logs_select" on public.credit_logs
  for select to authenticated using (member_id = auth.uid() or public.is_pro());


-- ---------------------------------------------------------------------
-- 5. 권한 부여 (로그인 사용자만 API 사용)
-- ---------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select, update            on public.profiles    to authenticated;
grant select, insert, update    on public.slots       to authenticated;
grant select                    on public.bookings    to authenticated;
grant select                    on public.credit_logs to authenticated;

revoke execute on function public.get_slots(timestamptz, timestamptz)       from public, anon;
revoke execute on function public.request_booking(bigint)                   from public, anon;
revoke execute on function public.approve_booking(bigint)                   from public, anon;
revoke execute on function public.reject_booking(bigint, text)              from public, anon;
revoke execute on function public.cancel_booking(bigint, text)              from public, anon;
revoke execute on function public.delete_slot(bigint)                       from public, anon;
revoke execute on function public.adjust_credits(uuid, int, text)           from public, anon;

grant execute on function public.is_pro()                                   to authenticated;
grant execute on function public.is_approved()                              to authenticated;
grant execute on function public.get_slots(timestamptz, timestamptz)        to authenticated;
grant execute on function public.request_booking(bigint)                    to authenticated;
grant execute on function public.approve_booking(bigint)                    to authenticated;
grant execute on function public.reject_booking(bigint, text)               to authenticated;
grant execute on function public.cancel_booking(bigint, text)               to authenticated;
grant execute on function public.delete_slot(bigint)                        to authenticated;
grant execute on function public.adjust_credits(uuid, int, text)            to authenticated;


-- =====================================================================
--  ★ 프로 계정 지정 (사이트에서 본인 계정으로 회원가입한 뒤, 이메일을 바꿔서 한 번 실행)
--
--  update public.profiles set role = 'pro', status = 'approved'
--   where email = '프로님이메일@example.com';
-- =====================================================================
