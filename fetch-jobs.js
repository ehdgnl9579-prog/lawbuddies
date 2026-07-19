/**
 * fetch-jobs.js
 * 로버디스 — 채용공고 자동 수집 (Tier A: 공공기관 채용정보 조회서비스)
 *
 * 소스: 재정경제부_공공기관 채용정보 조회서비스 (data.go.kr)
 * End Point: https://apis.data.go.kr/1051000/recruitment
 * 실행 주기: GitHub Actions jobs.yml (매일 KST 06:10)
 * 출력: data/jobs.json
 */

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://apis.data.go.kr/1051000/recruitment';
const SERVICE_KEY = process.env.JOBALIO_SERVICE_KEY;
const OUTPUT_PATH = path.join(__dirname, 'data', 'jobs.json');

// 변호사 관련 공고를 걸러낼 키워드 (공시제목에 하나라도 포함되면 수집)
const KEYWORDS = ['변호사', '법무', '법제', '준법', '컴플라이언스', 'Compliance'];

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

function matchesKeyword(text) {
  if (!text) return false;
  return KEYWORDS.some((kw) => text.includes(kw));
}

function parseKoreanDate(raw) {
  if (!raw) return null;
  const s = String(raw).replace(/-/g, ''); // YYYY-MM-DD → YYYYMMDD
  if (s.length !== 8) return null;
  const y = s.slice(0, 4), m = s.slice(4, 6), d = s.slice(6, 8);
  return new Date(`${y}-${m}-${d}T00:00:00+09:00`).toISOString();
}

// ───────────────────────────────
// API 호출: /list
// ───────────────────────────────
async function fetchPage(pageNo) {
  const params = new URLSearchParams({
    serviceKey: SERVICE_KEY,
    resultType: 'json',
    pageNo: String(pageNo),
    numOfRows: '100',
    ongoingYn: 'Y', // 진행 중 공고만
  });

  const url = `${BASE_URL}/list?${params.toString()}`;
  console.log(`[jobalio] 요청 URL (키 제외): ${url.replace(SERVICE_KEY, 'KEY_HIDDEN')}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API 오류: ${res.status} ${res.statusText}`);

  const data = await res.json();

  // 실제 응답 구조 (2026-07-19 확인):
  //   data.resultCode = 200
  //   data.totalCount = 542   ← 총 건수
  //   data.result = [...]     ← 아이템 배열 (바로 배열임, .items가 아님)
  const totalCount = data.totalCount || 0;
  const items = Array.isArray(data.result) ? data.result : [];

  console.log(`[jobalio] 파싱: totalCount=${totalCount}, items=${items.length}건`);

  return { totalCount, items };
}

async function fetchAllJobalio() {
  if (!SERVICE_KEY) {
    console.log('[jobalio] JOBALIO_SERVICE_KEY 없음 — 스킵');
    return [];
  }

  console.log('[jobalio] 수집 시작...');
  const first = await fetchPage(1);
  console.log(`[jobalio] 전체 진행 중 공고: ${first.totalCount}건`);

  const totalPages = Math.ceil(first.totalCount / 100);
  let allItems = [...first.items];

  for (let p = 2; p <= Math.min(totalPages, 10); p++) {
    const { items } = await fetchPage(p);
    allItems = allItems.concat(items);
  }

  // 변호사/법무 관련만 필터링 — 제목·자격요건·NCS직무명 모두에서 검색
  const filtered = allItems.filter((item) => {
    const searchText = [
      item.recrutPbancTtl,  // 공시 제목
      item.aplyQlfcCn,      // 자격요건 상세
      item.ncsCdNmLst,      // NCS 직무명 (예: "법률")
      item.recrutSeNm,      // 채용구분명
    ].filter(Boolean).join(' ');
    return matchesKeyword(searchText);
  });
  console.log(`[jobalio] 키워드 필터 후: ${filtered.length}건 / 전체 ${allItems.length}건`);
  if (filtered.length > 0) {
    console.log(`[jobalio] 예시: ${filtered.slice(0, 3).map(i => i.recrutPbancTtl).join(' | ')}`);
  }

  return filtered.map(normalizeItem);
}

function normalizeItem(item) {
  // 실제 API 필드명 (2026-07-19 확인):
  //   recrutPblntSn  — 공시 일련번호 (고유 ID)
  //   recrutPbancTtl — 공시 제목
  //   instNm         — 기관명
  //   workRgnNmLst   — 근무지역명
  //   pbancBgngYmd   — 공시 시작일 (YYYYMMDD)
  //   pbancEndYmd    — 공시 마감일 (YYYYMMDD)
  //   srcUrl         — 원문 URL
  //   recrutNope     — 채용인원
  //   hireTypeNmLst  — 고용유형명
  //   aplyQlfcCn     — 자격요건

  const title = item.recrutPbancTtl || '';
  const firm = item.instNm || '';

  return {
    source: 'jobalio',
    sourceId: String(item.recrutPblntSn || ''),
    title,
    firm,
    firmKey: normFirm(firm),
    role: '공공',
    region: guessRegion(item.workRgnNmLst || ''),
    exp: item.hireTypeNmLst || '',
    pay: '공고 참조',
    deadline: parseKoreanDate(item.pbancEndYmd),
    link: item.srcUrl || 'https://job.alio.go.kr',
    body: `공공기관 채용공고 (잡알리오 자동수집)\n기관: ${firm}\n채용인원: ${item.recrutNope || '미정'}명\n고용유형: ${item.hireTypeNmLst || '미정'}\n\n※ 원문에서 상세 자격요건·전형절차를 확인하세요.`,
    created: parseKoreanDate(item.pbancBgngYmd) || new Date().toISOString(),
    archived: false,
    comments: [],
    seen: 0,
  };
}

function guessRegion(text) {
  if (!text) return '전체';
  if (text.includes('서울')) return '서울';
  if (text.includes('인천') || text.includes('경기')) return '경기·인천';
  if (/전체|전국/.test(text)) return '전체';
  return '지방';
}

// ───────────────────────────────
// 병합: 기존 jobs.json과 합치기
// ───────────────────────────────
function mergeJobs(newJobs, existingJobs) {
  const map = new Map();

  // 기존 공고 전부 맵에 올림
  existingJobs.forEach((j) => {
    const key = j.source && j.sourceId
      ? `${j.source}:${j.sourceId}`
      : `manual:${j.id}`;
    map.set(key, j);
  });

  // 신규 공고 반영
  const seenKeys = new Set();
  newJobs.forEach((j) => {
    const key = `${j.source}:${j.sourceId}`;
    seenKeys.add(key);

    const prev = map.get(key);
    if (prev) {
      // 기존 공고는 댓글·조회수 보존, 마감일·archived만 갱신
      map.set(key, {
        ...prev,
        deadline: j.deadline,
        archived: false,
      });
    } else {
      // 신규: id 자동 채번
      const maxId = Math.max(0, ...Array.from(map.values()).map((x) => x.id || 0));
      map.set(key, { ...j, id: maxId + 1 });
    }
  });

  // 이번에 안 잡힌 자동수집 공고 → archived (삭제 아님 — 공고빈도 카운터 보존)
  map.forEach((job, key) => {
    if (job.source === 'jobalio' && !seenKeys.has(key) && !job.archived) {
      job.archived = true;
      console.log(`[merge] 만료 처리: ${job.title}`);
    }
  });

  return Array.from(map.values()).sort((a, b) => {
    // 최신순 정렬, archived는 뒤로
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    return new Date(b.created) - new Date(a.created);
  });
}

// ───────────────────────────────
// 메인
// ───────────────────────────────
async function main() {
  console.log('=== fetch-jobs.js 시작 ===', new Date().toISOString());

  const newJobs = await fetchAllJobalio();

  let existingJobs = [];
  if (fs.existsSync(OUTPUT_PATH)) {
    try {
      existingJobs = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
      console.log(`기존 jobs.json: ${existingJobs.length}건`);
    } catch (e) {
      console.warn('기존 jobs.json 파싱 실패, 새로 시작합니다.');
    }
  }

  const merged = mergeJobs(newJobs, existingJobs);

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(merged, null, 2), 'utf-8');

  const activeCount = merged.filter((j) => !j.archived).length;
  console.log(`=== 완료: 총 ${merged.length}건 (활성 ${activeCount}건, 아카이브 ${merged.length - activeCount}건) → ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error('fetch-jobs.js 오류:', err);
  process.exit(1);
});
