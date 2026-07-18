#!/usr/bin/env node
/*
 * 로버디스 판례 속보 파이프라인
 * 법제처 국가법령정보 공동활용 오픈API(판례) → 최신 대법원 판례 → panrye.json
 *
 * 판결문은 저작권법 제7조 제3호에 따라 보호 대상이 아님 → 판시사항·판결요지·전문 게시 가능.
 * (뉴스와 달리 '요지 전문'을 그대로 실을 수 있는 이유)
 *
 * 실행:
 *   LAW_OC=your_oc node scripts/fetch-panrye.js
 *   (LAW_OC = 국가법령정보 오픈API 신청 시 쓴 이메일의 @ 앞부분)
 *
 * 데모 키로 테스트:
 *   LAW_OC=test node scripts/fetch-panrye.js
 *
 * 의존성 없음. Node 18+.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const CONFIG = {
  court: '대법원',   // curt 필터
  listCount: 20,     // 목록에서 훑을 최신 판례 수
  maxItems: 12,      // 최종 노출 상한
  includeFullText: true,  // 판례내용(전문)까지 담을지
  gapMs: 200,        // 본문조회 사이 간격
  // 사건명에 아래 문구가 들어가면 제외 (심리불속행 기각 등 — 실체 판단 없어 속보 가치 낮음)
  excludeNamePatterns: ['심리불속행'],
};

const OUT_FILE = process.env.OUT_FILE || 'data/panrye.json';
const OC = process.env.LAW_OC;
const BASE = 'https://www.law.go.kr/DRF';

if (!OC) {
  console.error('✗ LAW_OC 환경변수가 필요합니다. (테스트: LAW_OC=test)');
  process.exit(1);
}

/* ───────── XML 헬퍼 (무의존 정규식 파서 — 정부 XML은 구조가 단순·예측가능) ───────── */
function pick(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return '';
  let v = m[1].replace(/<!\[CDATA\[|\]\]>/g, '');
  v = v.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''); // 내부 태그 제거
  return decodeEntities(v).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
}
function decodeEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ');
}
// 선고일자 → ISO. 목록 API는 "2026.05.14", 본문 API는 "20260514" 로 서로 다르게 줌.
function dateToIso(s) {
  s = (s || '').trim();
  let m = s.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/) || s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return new Date().toISOString();
  const [, y, mo, d] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, 9)).toISOString();
}

async function fetchOnce(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; lawbuddies-panrye/1.0)',
        'Accept': 'application/xml,text/xml,*/*',
      },
    });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} — 응답앞부분: ${body.slice(0, 200)}`);
    }
    // IP 제한/거부 시 200인데 XML이 아니라 에러 안내 HTML이 오는 경우 감지
    if (!body.includes('<') || /권한|허용되지|제한|차단|denied|forbidden/i.test(body.slice(0, 300))) {
      throw new Error(`정상 XML 아님(권한/IP 제한 의심) — 앞부분: ${body.slice(0, 200)}`);
    }
    return body;
  } finally {
    clearTimeout(t);
  }
}

// https 먼저, 실패하면 http 로도 시도. 각 3회 재시도. 실패 원인을 자세히 출력.
async function get(url) {
  const candidates = [url, url.replace('https://', 'http://')];
  let lastErr;
  for (const cand of candidates) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await fetchOnce(cand);
      } catch (e) {
        const code = e.cause?.code || e.code || e.name || '';
        lastErr = e;
        console.error(`  … 시도 실패 [${cand.startsWith('https') ? 'https' : 'http'} #${attempt}] ${code} ${e.message}`);
        await sleep(1500 * attempt);
      }
    }
  }
  throw lastErr;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────── 메인 ───────── */
async function main() {
  // 1) 최신 대법원 판례 목록
  const listUrl = `${BASE}/lawSearch.do?OC=${encodeURIComponent(OC)}`
    + `&target=prec&type=XML&display=${CONFIG.listCount}`
    + `&curt=${encodeURIComponent(CONFIG.court)}&query=*&sort=ddes`;
  const listXml = await get(listUrl);

  const ids = [];
  const re = /<prec[\s>][\s\S]*?<\/prec>/g;
  let m;
  while ((m = re.exec(listXml))) {
    const block = m[0];
    const id = (block.match(/<판례일련번호>(\d+)<\/판례일련번호>/) || [])[1];
    const court = (block.match(/<법원명>([\s\S]*?)<\/법원명>/) || [])[1] || '';
    if (id) ids.push({ id, court });
  }
  console.error(`· 목록 ${ids.length}건 수집 (대법원 필터)`);

  // 2) 각 판례 본문조회 → 요지 없는 건 제외
  const items = [];
  for (const { id } of ids) {
    if (items.length >= CONFIG.maxItems) break;
    let xml;
    try {
      xml = await get(`${BASE}/lawService.do?OC=${encodeURIComponent(OC)}&target=prec&ID=${id}&type=XML`);
    } catch (e) {
      console.error(`  ! ${id} 본문 실패: ${e.message}`);
      continue;
    }
    await sleep(CONFIG.gapMs);

    const caseName = pick(xml, '사건명');
    const caseNo = pick(xml, '사건번호');
    const court = pick(xml, '법원명') || '대법원';
    const date = pick(xml, '선고일자');
    const caseType = pick(xml, '사건종류명');
    const issue = pick(xml, '판시사항');
    const summary = pick(xml, '판결요지');
    const refLaw = pick(xml, '참조조문');
    const fullText = pick(xml, '판례내용');

    // 판시사항·판결요지 둘 다 없으면 스킵 (속보 가치 낮음)
    if (!issue && !summary) continue;

    // 사건명 기준 명시적 제외 (심리불속행 기각 등)
    if (CONFIG.excludeNamePatterns.some((p) => caseName.includes(p))) {
      console.error(`  × 제외(${caseName.slice(0, 20)}): 심리불속행 등`);
      continue;
    }

    const bodyParts = [];
    if (issue) bodyParts.push(`【판시사항】\n${issue}`);
    if (summary) bodyParts.push(`【판결요지】\n${summary}`);
    if (refLaw) bodyParts.push(`【참조조문】 ${refLaw}`);

    const rec = {
      id: `prec-${id}`,
      type: '판례공보',
      title: `${court} ${caseNo}${caseName ? ' · ' + caseName : ''}`,
      body: bodyParts.join('\n\n'),
      link: `https://www.law.go.kr/LSW/precInfoP.do?precSeq=${id}`,
      author: court,
      created: dateToIso(date),
      views: 0,
      caseType,
    };
    if (CONFIG.includeFullText && fullText) rec.fullText = fullText;
    items.push(rec);
    console.error(`  · ${date} ${court} ${caseNo} — ${caseName.slice(0, 30)}`);
  }

  items.sort((a, b) => new Date(b.created) - new Date(a.created));

  const payload = {
    generated: new Date().toISOString(),
    source: 'law.go.kr-open-api',
    court: CONFIG.court,
    count: items.length,
    items,
  };

  const outPath = path.resolve(OUT_FILE);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.error(`✓ ${OUT_FILE} — 총 ${items.length}건 기록`);
}

main().catch((e) => { console.error('✗ 실패:', e.message); process.exit(1); });
