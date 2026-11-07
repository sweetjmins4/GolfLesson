// ===== 여기만 바꾸면 됩니다 =====

// Supabase 대시보드 > Project Settings > API (또는 Connect 버튼) 에서 복사
export const SUPABASE_URL = 'https://bjxdkphgtpdjkzkbbjfg.supabase.co';

// anon public 키 또는 publishable 키 (sb_publishable_...)
// 이 키는 공개되어도 괜찮습니다. RLS가 데이터를 보호합니다.
// ⚠️ service_role / secret 키는 절대 넣지 마세요.
export const SUPABASE_ANON_KEY = 'sb_publishable_jBnSj3yK2aCS-8kiFBSFEw_JKybq6g2';

// 사이트 상단에 표시될 이름
export const SITE_NAME = '정프로의 골프레슨 예약';

// 회원이 확정 예약을 취소할 수 있는 마감 (레슨 시작 몇 시간 전까지)
// schema.sql 의 cancel_booking 함수 안 interval '24 hours' 와 같은 값으로 맞춰 주세요.
export const CANCEL_HOURS = 24;
