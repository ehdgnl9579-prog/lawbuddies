/**
 * fetch-legal-jobs.js
 * 로버디스 — 민간 변호사 채용공고 자동 수집 (Tier A-2: 채용 SaaS 플랫폼 검색)
 *
 * 원리:
 *   greetinghr / recruiter.co.kr / recruiter.im / ninehire 등 채용 SaaS는
 *   각 회사 채용페이지를 구글에 색인시킴. 이 페이지들은 회사가 지원자 유치를
 *   위해 스스로 공개한 것 → "site:도메인 변호사" 검색으로 크로스-컴퍼니 수집 가능.
 *
 *   Google Programmable Search Engine(PSE) API 사용.
 *   하루 100 쿼리 무료. 쿼리당 최대 10건, start 파라미터로 페이지네이션.
 *
 * 저작권 안전:
 *   - 회사가 공개한 자사 채용페이지 (취정센 같은 무단사용금지 사이트 아님)
 *   - 저장하는 건 "제목 + 회사 + 링크 + 스니펫 일부" = 사실정보 + 원문링크
 *   - 본문 전문 복제 안 함
 *
 * 실행 주기: GitHub Actions legal-jobs.yml (매일 KST 06:20)
 * 출력: data/jobs.json 에 병합 (source: 'saas')
 */

const fs = require('fs');
const path = require('path');

// ───────────────────────────────
// CONFIG
// ───────────────────────────────
const GOOGLE_API_KEY = process.env.GOOGLE_SEARCH_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_SEARCH_CX; // Programmable Search Engine ID
const OUTPUT_PATH = path.join(__dirname, 'data', 'jobs.json');

// 검색엔진 자체가 이미 4개 도메인(greetinghr/recruiter.co.kr/recruiter.im/ninehire)으로
// 제한돼 있으므로(구글이 2026년 신규 엔진의 "전체 웹 검색"을 폐지 → 대신 도메인 등록 방식),
// site: 연산자 없이 키워드만 검색하면 됩니다.
const SEARCH_QUERIES = [
  '변호사',
  '사내변호사',
  '변호사 채용',
  'Legal Counsel',
  'In-house Counsel',
  '법무팀',
  '법무 담당',
  '법무 경력',
  '컴플라이언스',
  '준법지원',
];

// 회사명 추출: greetinghr는 서브도메인, recruiter는 서브도메인
// 예: kakaomobility.career.greetinghr.com → kakaomobility
//     koreanair.recruiter.co.kr → koreanair
const SUBDOMAIN_TO_FIRM = {
  // 필요시 수동 매핑 보강 (자동추출이 부정확한 경우만)
  kakaomobility: '카카오모빌리티',
  koreanair: '대한항공',
  koreanaircnd: '대한항공씨앤디서비스',
  pulmuone: '풀무원',
  hankooktire: '한국타이어앤테크놀로지',
  hlcompany: 'HL만도',
  donga: '동아쏘시오홀딩스',
  'ls-sec': 'LS증권',
  'yg-entertainment': 'YG엔터테인먼트',
  gwss: '고운세상코스메틱',
  peoplefund: '피플펀드',
  finda: '핀다',
  bucketplace: '오늘의집',
  vunohire: '뷰노',
  nice: 'NICE평가정보',
  daoudata: '다우데이타',
  carelabs: '케어랩스',
  jipyong: '법무법인 지평',
  lawcompany: '로앤컴퍼니',
  amwaykorea: '한국암웨이',
  inspireresorts: '인스파이어리조트',
  bhsn: 'BHSN',
};

// ───────────────────────────────
// 유틸
// ───────────────────────────────
function normFirm(name) {
  return (name || '')
    .replace(/\(주\)|주식회사|\(유\)|유한회사|법무법인|\(유한\)/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

// URL에서 회사 서브도메인 추출
function extractFirmFromUrl(url) {
  try {
    const host = new URL(url).hostname;
    // greetinghr: {sub}.career.greetinghr.com  또는  {sub}.greetinghr.com
    // recruiter:  {sub}.recruiter.co.kr / .recruiter.im
    // ninehire:   {sub}.ninehire.site
    let sub = '';
    if (host.includes('greetinghr.com')) {
      sub = host.split('.career.greetinghr.com')[0].split('.greetinghr.com')[0];
    } else if (host.includes('recruiter.co.kr')) {
      sub = host.split('.recruiter.co.kr')[0];
    } else if (host.includes('recruiter.im')) {
      sub = host.split('.recruiter.im')[0];
    } else if (host.includes('ninehire.site')) {
      sub = host.split('.ninehire.site')[0];
    }
    sub = sub.replace(/^https?:\/\//, '');
    // 매핑 테이블에 있으면 한글 회사명, 없으면 서브도메인 그대로
    return SUBDOMAIN_TO_FIRM[sub] || sub || '(회사미상)';
  } catch (e) {
    return '(회사미상)';
  }
}

function guessRegionFromText(text) {
  const t = text || '';
  if (/서울|강남|서초|판교라인|여의도|종로|중구/.test(t)) return '서울';
  if (/경기|인천|판교|성남|수원|용인|송도/.test(t)) return '경기·인천';
  if (/부산|대구|대전|광주|울산|세종|충청|전라|경상|강원|제주|나주|천안/.test(t)) return '지방';
  return '미기재';
}
function guessExp(text) {
  const t = text || '';
  const m = t.match(/(\d+)\s*년\s*(이상|이하|~|-)/);
  if (m) return m[0];
  if (/신입/.test(t)) return '신입';
  if (/경력/.test(t)) return '경력';
  return '';
}

// 사이트 필터 버튼과 동일한 라벨을 반환해야 필터링이 동작함
// (사이트 직군 값: 송무 / 자문 / 사내변호사 / 공공 / 기타)
function guessRole(text) {
  const t = text || '';
  if (/사내변|Legal Counsel|법무담당|법무 담당|기업법무|기업 법무|준법|컴플라이언스|Compliance|법무팀|In-house/i.test(t)) return '사내변호사';
  if (/공사|공단|공공기관|재단|진흥원|연구원/.test(t)) return '공공';
  if (/법무법인|로펌|어쏘|송무|소송/.test(t)) return '송무';
  if (/자문|Advisory/i.test(t)) return '자문';
  return '기타';
}

// ───────────────────────────────
// Google PSE 검색
// ───────────────────────────────
async function googleSearch(query, start = 1) {
  // 표준 Custom Search JSON API (하루 100쿼리 무료)
  // ※ siterestrict 엔드포인트는 구글이 서비스 종료를 예고한 API라 사용하지 않음
  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}&start=${start}&num=10`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Google API ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function collectFromQuery(query) {
  const results = [];
  // 최대 3페이지(30건)까지. 대부분 쿼리는 1~2페이지면 충분
  for (let start = 1; start <= 21; start += 10) {
    let data;
    try {
      data = await googleSearch(query, start);
    } catch (e) {
      console.error(`  [검색실패] "${query}" start=${start}: ${e.message}`);
      break;
    }
    const items = data.items || [];
    if (items.length === 0) break;

    for (const it of items) {
      results.push(normalizeSearchItem(it, query));
    }
    // 다음 페이지가 없으면 중단
    if (!data.queries?.nextPage) break;
  }
  return results;
}

function normalizeSearchItem(item, query) {
  const title = item.title || '';
  const link = item.link || '';
  const snippet = item.snippet || '';
  const firm = extractFirmFromUrl(link);

  // 플랫폼 식별
  let platform = 'saas';
  if (link.includes('greetinghr')) platform = 'greeting';
  else if (link.includes('recruiter.co.kr') || link.includes('recruiter.im')) platform = 'recruiter';
  else if (link.includes('ninehire')) platform = 'ninehire';

  const combined = `${title} ${snippet}`;

  return {
    source: 'saas',
    platform,
    sourceId: link, // 링크 자체를 고유 ID로 (플랫폼별 공고 URL은 유니크)
    title: title.replace(/\s*[-|·]\s*.*(채용|공고|Careers?).*$/i, '').trim() || title,
    firm,
    firmKey: normFirm(firm),
    role: guessRole(combined),
    region: guessRegionFromText(combined),
    exp: guessExp(combined),
    pay: '공고 참조',
    deadline: null,   // 스니펫에 D-day 있으면 후처리 가능하나 불안정 → 원문 유도
    link,
    body: `${firm} 채용공고\n\n${snippet}\n\n※ 자격요건·마감일·전형절차는 원문 링크에서 확인하세요.`,
    created: new Date().toISOString(),
    archived: false,
    comments: [],
    seen: 0,
  };
}

// ───────────────────────────────
// 병합 (기존 jobs.json 과)
// ───────────────────────────────
function mergeJobs(newJobs, existingJobs) {
  const map = new Map();

  existingJobs.forEach((j) => {
    const key = j.sourceId
      ? `${j.source}:${j.sourceId}`
      : `manual:${j.id}`;
    map.set(key, j);
  });

  const seenKeys = new Set();
  newJobs.forEach((j) => {
    const key = `${j.source}:${j.sourceId}`;
    seenKeys.add(key);
    const prev = map.get(key);
    if (prev) {
      // 기존 것 유지 (댓글·조회수 보존), 재노출됐으니 archived 해제
      map.set(key, { ...prev, archived: false });
    } else {
      const maxId = Math.max(0, ...Array.from(map.values()).map((x) => x.id || 0));
      map.set(key, { ...j, id: maxId + 1 });
    }
  });

  // 이번 검색에서 안 나온 saas 공고 → archived (마감됐거나 색인 빠짐)
  map.forEach((job, key) => {
    if (job.source === 'saas' && !seenKeys.has(key) && !job.archived) {
      job.archived = true;
    }
  });

  return Array.from(map.values()).sort((a, b) => {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return new Date(b.created) - new Date(a.created);
  });
}

// ───────────────────────────────
// 메인
// ───────────────────────────────
async function main() {
  console.log('=== fetch-legal-jobs.js 시작 ===', new Date().toISOString());

  if (!GOOGLE_API_KEY || !GOOGLE_CX) {
    console.error('GOOGLE_SEARCH_API_KEY 또는 GOOGLE_SEARCH_CX 없음 — 스킵');
    process.exit(0);
  }

  const all = [];
  for (const q of SEARCH_QUERIES) {
    console.log(`[검색] ${q}`);
    const r = await collectFromQuery(q);
    console.log(`  → ${r.length}건`);
    all.push(...r);
  }

  // 링크 기준 중복 제거
  const dedup = new Map();
  all.forEach((j) => dedup.set(j.sourceId, j));
  const newJobs = Array.from(dedup.values());
  console.log(`수집 총 ${all.length}건 → 중복제거 후 ${newJobs.length}건`);

  let existingJobs = [];
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      existingJobs = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    } catch (e) {
      console.warn('기존 jobs.json 파싱 실패, 새로 시작');
    }
  }

  const merged = mergeJobs(newJobs, existingJobs);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(merged, null, 2), 'utf-8');

  const active = merged.filter((j) => !j.archived).length;
  console.log(`=== 완료: 총 ${merged.length}건 (활성 ${active}) → ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('fetch-legal-jobs.js 오류:', err);
  process.exit(1);
});
