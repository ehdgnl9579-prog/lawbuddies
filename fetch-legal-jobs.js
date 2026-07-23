/**
 * fetch-legal-jobs.js
 * 로버디스 — 민간 변호사 채용공고 수집 (채용 SaaS 플랫폼 직접 수집 방식)
 *
 * 왜 이 방식인가:
 *   구글 Custom Search JSON API는 2026년부터 신규 사용자에게 제공되지 않음(403).
 *   대신 greetinghr / recruiter.co.kr / ninehire 등 채용 SaaS는 회사마다
 *   같은 HTML 템플릿을 쓰므로, 플랫폼당 파서 1개로 수십~수백 개 회사를 커버 가능.
 *   → 검색 API 불필요, 비용 0원, 쿼리 한도 없음.
 *
 * robots.txt 확인 결과 (2026-07-23):
 *   greetinghr : Content-Signal: search=yes, ai-train=no, use=reference
 *                User-agent: * → Allow: / (단 /apply, /m/, /a/ 는 Disallow)
 *                → "링크 + 짧은 발췌 + 원문참조" 용도는 명시적 허용
 *   ninehire   : User-agent: * → Allow (관리/로그인 경로만 Disallow)
 *   recruiter  : 회사별 상이. /app* 를 막는 곳이 있어 /career/jobs/ 경로만 사용
 *
 * 수집 원칙 (제품원칙 준수):
 *   - 사실 필드(회사·직무·경력·고용형태·근무지)만 추출, 본문 전문 복제 금지
 *   - 원문 링크로 유도
 *   - 요청 간 1초 간격, 식별 가능한 User-Agent
 *
 * 출력: data/jobs.json 에 병합 (source: 'saas')
 */

const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, 'data', 'jobs.json');
const UA = 'lawbuddies-bot/1.0 (legal job aggregator)';
const DELAY_MS = 1000;         // 요청 간 예의 간격
const MAX_DETAIL_PER_RUN = 60; // 1회 실행당 상세조회 상한

// ───────────────────────────────
// 수집 대상 회사 목록
//   새 회사를 발견하면 여기에 한 줄만 추가하면 됩니다.
// ───────────────────────────────
const COMPANIES = [
  // ── greetinghr ──
  { sub: 'kakaomobility',  platform: 'greeting', name: '카카오모빌리티' },
  { sub: 'jipyong',        platform: 'greeting', name: '법무법인 지평' },
  { sub: 'nice',           platform: 'greeting', name: 'NICE평가정보' },
  { sub: 'daoudata',       platform: 'greeting', name: '다우데이타' },
  { sub: 'peoplefund',     platform: 'greeting', name: '피플펀드' },
  { sub: 'finda',          platform: 'greeting', name: '핀다' },
  { sub: 'bucketplace',    platform: 'greeting', name: '오늘의집' },
  { sub: 'vunohire',       platform: 'greeting', name: '뷰노' },
  { sub: 'inspireresorts', platform: 'greeting', name: '인스파이어리조트' },
  { sub: 'amwaykorea',     platform: 'greeting', name: '한국암웨이' },
  { sub: 'bhsn',           platform: 'greeting', name: 'BHSN' },
  { sub: 'carelabs',       platform: 'greeting', name: '케어랩스' },
  { sub: 'lawcompany',     platform: 'greeting', name: '로앤컴퍼니' },

  // ── recruiter.co.kr ──
  { sub: 'koreanair',        platform: 'recruiter', name: '대한항공' },
  { sub: 'koreanaircnd',     platform: 'recruiter', name: '대한항공씨앤디서비스' },
  { sub: 'pulmuone',         platform: 'recruiter', name: '풀무원' },
  { sub: 'hankooktire',      platform: 'recruiter', name: '한국타이어앤테크놀로지' },
  { sub: 'gwss',             platform: 'recruiter', name: '고운세상코스메틱' },
  { sub: 'donga',            platform: 'recruiter', name: '동아쏘시오홀딩스' },
  { sub: 'hlcompany',        platform: 'recruiter', name: 'HL만도' },
  { sub: 'ls-sec',           platform: 'recruiter', name: 'LS증권' },
  { sub: 'yg-entertainment', platform: 'recruiter', name: 'YG엔터테인먼트' },
  { sub: 'cosmax',           platform: 'recruiter', name: '코스맥스' },
  { sub: 'hyosung',          platform: 'recruiter', name: '효성' },
  { sub: 'kukdo',            platform: 'recruiter', name: '국도화학' },
  { sub: 'hdc-labs',         platform: 'recruiter', name: 'HDC랩스' },

  // ── ninehire ──
  { sub: 'draju', platform: 'ninehire', name: '법무법인 대륙아주' },
];

const KEYWORDS = [
  '변호사', '법무', '법제', '준법', '컴플라이언스',
  'Legal', 'Counsel', 'Compliance', 'Attorney',
];

// ───────────────────────────────
// 유틸
// ───────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normFirm(name) {
  return (name || '')
    .replace(/\(주\)|주식회사|\(유\)|유한회사|법무법인|\(유한\)/g, '')
    .replace(/\s+/g, '')
    .trim()
    .toLowerCase();
}

function matchesKeyword(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  return KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
}

function stripTags(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (res.status === 404) return { notFound: true, text: '' };
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return { notFound: false, text: await res.text() };
}

// ───────────────────────────────
// 사이트 필터 라벨과 동일한 값 반환
// (사이트 직군 값: 송무 / 자문 / 사내변호사 / 공공 / 기타)
// ───────────────────────────────
function guessRole(text, firmName) {
  const t = `${text || ''} ${firmName || ''}`;
  if (/법무법인|법률사무소|로펌/.test(firmName || '')) return '송무';
  if (/사내\s*변호사|사내변|Legal\s*Counsel|In-?house|기업\s*법무|법무\s*팀|법무\s*담당|준법|컴플라이언스|Compliance|법무/i.test(t)) return '사내변호사';
  if (/공사|공단|공공기관|재단|진흥원|연구원/.test(t)) return '공공';
  if (/자문|Advisory/i.test(t)) return '자문';
  return '기타';
}

function guessRegion(text) {
  const t = text || '';
  if (/서울|강남|서초|여의도|종로|중구|용산|마포/.test(t)) return '서울';
  if (/경기|인천|판교|성남|수원|용인|송도|안양|화성/.test(t)) return '경기·인천';
  if (/부산|대구|대전|광주|울산|세종|충청|충남|충북|전라|전남|전북|경상|경남|경북|강원|제주|나주|천안|청주/.test(t)) return '지방';
  return '미기재';
}

function guessExp(text) {
  const t = text || '';
  const m = t.match(/경력\s*\d+\s*[년~\-–]\s*\d*\s*년?|경력\s*\d+\s*년\s*(이상|이하)|\d+\s*년\s*(이상|이하)/);
  if (m) return m[0].replace(/\s+/g, ' ').trim();
  if (/경력\s*무관/.test(t)) return '경력무관';
  if (/신입/.test(t)) return '신입';
  if (/경력/.test(t)) return '경력';
  return '';
}

// 급여: 대부분 공고에 없음. 있으면 뽑고, 없으면 "미기재"로 명시
function extractPay(text) {
  const t = text || '';
  const m = t.match(/(연봉|급여|보수|처우)\s*[:：]\s*([^\n·]{1,40})/);
  if (m) {
    const v = m[2].trim();
    if (v && !/이력서|기재되어|기재된/.test(v)) return `${m[1]}: ${v}`;
  }
  const won = t.match(/\d[\d,]{2,}\s*만\s*원/);
  if (won) return won[0];
  if (/내규에?\s*따름|회사\s*내규/.test(t)) return '내규에 따름';
  return '미기재';
}

function makeJob({ platform, url, title, company, role, region, exp, pay, facts }) {
  return {
    source: 'saas',
    platform,
    sourceId: url,
    title: title || '(제목 없음)',
    firm: company.name,
    firmKey: normFirm(company.name),
    role,
    region,
    exp,
    pay,
    deadline: null,
    link: url,
    body: `${company.name} 채용공고\n\n${facts || ''}\n\n※ 상세 자격요건·전형절차·마감일은 원문 링크에서 확인하세요.`.replace(/\n{3,}/g, '\n\n'),
    created: new Date().toISOString(),
    archived: false,
    comments: [],
    seen: 0,
  };
}

// ───────────────────────────────
// greetinghr
//   목록: /ko/guide   상세: /ko/o/{id}
// ───────────────────────────────
async function collectGreeting(company, budget) {
  const base = `https://${company.sub}.career.greetinghr.com`;
  const results = [];

  let listHtml;
  try {
    const r = await get(`${base}/ko/guide`);
    if (r.notFound) return results;
    listHtml = r.text;
  } catch (e) {
    console.error(`  [${company.name}] 목록 실패: ${e.message}`);
    return results;
  }

  const chunks = listHtml.split(/href="\/ko\/o\//).slice(1);
  const candidates = [];
  for (const chunk of chunks) {
    const idMatch = chunk.match(/^(\d+)/);
    if (!idMatch) continue;
    const id = idMatch[1];
    if (candidates.some((c) => c.id === id)) continue;
    // data-variant="title-01" 은 해시되지 않는 의미 속성이라 비교적 안정적
    const titleMatch = chunk.match(/data-variant="title-01"[^>]*>([^<]+)</);
    const title = titleMatch ? stripTags(titleMatch[1]) : '';
    const around = stripTags(chunk.slice(0, 1200));
    if (!matchesKeyword(`${title} ${around}`)) continue;
    candidates.push({ id, title });
  }

  for (const c of candidates) {
    if (budget.used >= MAX_DETAIL_PER_RUN) break;
    const url = `${base}/ko/o/${c.id}`;
    await sleep(DELAY_MS);
    budget.used++;
    try {
      const r = await get(url);
      if (r.notFound) continue; // 마감된 공고
      results.push(parseGreetingDetail(r.text, url, company, c.title));
    } catch (e) {
      console.error(`  [${company.name}] 상세 실패 ${c.id}: ${e.message}`);
    }
  }
  return results;
}

function parseGreetingDetail(html, url, company, fallbackTitle) {
  const text = stripTags(html);

  // 상세 페이지는 "구분 / 직군 / 직무 / 경력사항 / 고용형태 / 근무지" 라벨 구조
  const pick = (label) => {
    const re = new RegExp(`${label}\\s+(.{1,60}?)\\s+(?:구분|직군|직무|경력사항|고용형태|근무지|합류|이런|영입|지원|공유)`);
    const m = text.match(re);
    return m ? m[1].trim() : '';
  };

  const rawTitle = fallbackTitle || (html.match(/<title>([^<]+)<\/title>/) || [])[1] || '';
  const title = stripTags(rawTitle).replace(/\s*[-|]\s*.*$/, '').trim();
  const duty = pick('직무');
  const exp = pick('경력사항') || guessExp(text);
  const employ = pick('고용형태');
  const place = pick('근무지');

  const facts = [
    duty && `직무: ${duty}`,
    exp && `경력: ${exp}`,
    employ && `고용형태: ${employ}`,
    place && `근무지: ${place}`,
  ].filter(Boolean).join('\n');

  return makeJob({
    platform: 'greeting',
    url,
    title,
    company,
    role: guessRole(`${title} ${duty}`, company.name),
    region: guessRegion(`${place} ${text.slice(0, 1500)}`),
    exp,
    pay: extractPay(text),
    facts,
  });
}

// ───────────────────────────────
// recruiter.co.kr
//   sitemap.xml → /career/jobs/{id} 만 사용
// ───────────────────────────────
async function collectRecruiter(company, budget, knownUrls) {
  const base = `https://${company.sub}.recruiter.co.kr`;
  const results = [];

  let xml;
  try {
    const r = await get(`${base}/sitemap.xml`);
    if (r.notFound) return results;
    xml = r.text;
  } catch (e) {
    console.error(`  [${company.name}] 사이트맵 실패: ${e.message}`);
    return results;
  }

  const urls = Array.from(xml.matchAll(/<loc>([^<]+)<\/loc>/g))
    .map((m) => m[1].trim())
    .filter((u) => /\/career\/jobs\/\d+/.test(u));

  for (const url of urls) {
    if (budget.used >= MAX_DETAIL_PER_RUN) break;
    await sleep(DELAY_MS);
    budget.used++;
    try {
      const r = await get(url);
      if (r.notFound) continue;
      const text = stripTags(r.text);
      const head = text.slice(0, 3000);
      const titleMatch = r.text.match(/<title>([^<]+)<\/title>/);
      const rawTitle = titleMatch ? stripTags(titleMatch[1]) : '';
      if (!matchesKeyword(`${rawTitle} ${head}`)) continue;

      results.push(makeJob({
        platform: 'recruiter',
        url,
        title: rawTitle.replace(/^[^|]*\|\s*/, '').trim(),
        company,
        role: guessRole(`${rawTitle} ${head}`, company.name),
        region: guessRegion(head),
        exp: guessExp(head),
        pay: extractPay(head),
        facts: '',
      }));
    } catch (e) {
      console.error(`  [${company.name}] 상세 실패: ${e.message}`);
    }
  }
  return results;
}

// ───────────────────────────────
// ninehire
// ───────────────────────────────
async function collectNinehire(company, budget) {
  const base = `https://${company.sub}.ninehire.site`;
  const results = [];

  let html;
  try {
    const r = await get(`${base}/`);
    if (r.notFound) return results;
    html = r.text;
  } catch (e) {
    console.error(`  [${company.name}] 목록 실패: ${e.message}`);
    return results;
  }

  const ids = Array.from(new Set(
    Array.from(html.matchAll(/\/job_posting\/([A-Za-z0-9]+)/g)).map((m) => m[1])
  ));

  for (const id of ids) {
    if (budget.used >= MAX_DETAIL_PER_RUN) break;
    const url = `${base}/job_posting/${id}`;
    await sleep(DELAY_MS);
    budget.used++;
    try {
      const r = await get(url);
      if (r.notFound) continue;
      const text = stripTags(r.text);
      const head = text.slice(0, 3000);
      const titleMatch = r.text.match(/<title>([^<]+)<\/title>/);
      const rawTitle = titleMatch ? stripTags(titleMatch[1]) : '';
      if (!matchesKeyword(`${rawTitle} ${head}`)) continue;

      results.push(makeJob({
        platform: 'ninehire',
        url,
        title: rawTitle.replace(/\s*\|.*$/, '').trim(),
        company,
        role: guessRole(`${rawTitle} ${head}`, company.name),
        region: guessRegion(head),
        exp: guessExp(head),
        pay: extractPay(head),
        facts: '',
      }));
    } catch (e) {
      console.error(`  [${company.name}] 상세 실패 ${id}: ${e.message}`);
    }
  }
  return results;
}

// ───────────────────────────────
// 병합
// ───────────────────────────────
function mergeJobs(newJobs, existingJobs) {
  const map = new Map();

  existingJobs.forEach((j) => {
    const key = j.sourceId ? `${j.source}:${j.sourceId}` : `manual:${j.id}`;
    map.set(key, j);
  });

  const seenKeys = new Set();
  newJobs.forEach((j) => {
    const key = `${j.source}:${j.sourceId}`;
    seenKeys.add(key);
    const prev = map.get(key);
    if (prev) {
      // 댓글·조회수는 보존, 사실 필드만 갱신
      map.set(key, {
        ...prev,
        title: j.title, role: j.role, region: j.region,
        exp: j.exp, pay: j.pay, body: j.body,
        archived: false,
      });
    } else {
      const maxId = Math.max(0, ...Array.from(map.values()).map((x) => x.id || 0));
      map.set(key, { ...j, id: maxId + 1 });
    }
  });

  // 이번에 안 잡힌 saas 공고 → 아카이브 (삭제 아님, 공고빈도 카운터 보존)
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
  console.log(`대상 회사 ${COMPANIES.length}곳`);

  let existingJobs = [];
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      existingJobs = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    } catch (e) {
      console.warn('기존 jobs.json 파싱 실패, 새로 시작');
    }
  }
  const knownUrls = new Set(
    existingJobs.filter((j) => j.source === 'saas').map((j) => j.sourceId)
  );

  const budget = { used: 0 };
  const all = [];

  for (const c of COMPANIES) {
    if (budget.used >= MAX_DETAIL_PER_RUN) {
      console.log('상세조회 상한 도달 — 나머지는 다음 실행에서 처리');
      break;
    }
    let r = [];
    try {
      if (c.platform === 'greeting') r = await collectGreeting(c, budget);
      else if (c.platform === 'recruiter') r = await collectRecruiter(c, budget, knownUrls);
      else if (c.platform === 'ninehire') r = await collectNinehire(c, budget);
    } catch (e) {
      console.error(`[${c.name}] 수집 오류: ${e.message}`);
    }
    if (r.length) console.log(`[${c.name}] ${r.length}건`);
    all.push(...r);
    await sleep(DELAY_MS);
  }

  const dedup = new Map();
  all.forEach((j) => dedup.set(j.sourceId, j));
  const newJobs = Array.from(dedup.values());
  console.log(`수집 ${all.length}건 → 중복제거 ${newJobs.length}건 (상세조회 ${budget.used}회)`);

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
