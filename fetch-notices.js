/**
 * fetch-notices.js
 * 대한변협(koreanbar.or.kr) 공지사항(types=1)을 수집해 data/notices.json 생성.
 * - robots.txt 허용 경로(/pages/news/)만 접근
 * - 노이즈(공시송달 등) 제외
 * - 제목 + 날짜 + 원문링크만 저장 (본문 복사 안 함)
 * 서울지방회는 robots.txt 전면 차단이라 자동 수집 대상 아님(운영자 수동 입력).
 */

const fs = require('fs');
const path = require('path');

const BASE = 'https://www.koreanbar.or.kr/pages/news/';
const LIST_URL = BASE + 'list.asp?types=1';
const MAX_ITEMS = 6; // 위젯에 보여줄 최신 공지 개수

// 노이즈 제외: 이 단어가 제목에 있으면 버림
const EXCLUDE = ['공시송달', '등록취소', '개시통지', '휴업', '폐업신고'];

function decode(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/★|☆|◆|◇|▶|▷|●|○/g, '').trim();
}

async function fetchWithRetry(url, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LawbuddiesBot/1.0)' }
      });
      if (res.ok) return await res.text();
      console.error(`  시도 ${i} 실패: HTTP ${res.status}`);
    } catch (e) {
      console.error(`  시도 ${i} 실패: ${e.message}`);
    }
    if (i < tries) await new Promise(r => setTimeout(r, 3000)); // 3초 쉬고 재시도
  }
  throw new Error('재시도 모두 실패');
}

async function main() {
  const htmlText = await fetchWithRetry(LIST_URL);

  const rows = htmlText.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const items = [];

  for (const r of rows) {
    const a = r.match(/href="([^"]*view\.asp[^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    if (!a) continue;

    const title = decode(a[2].replace(/<[^>]+>/g, ''));
    if (!title) continue;
    if (EXCLUDE.some(w => title.includes(w))) continue;

    const dm = r.match(/(20\d{2})[-.](\d{1,2})[-.](\d{1,2})/);
    const created = dm
      ? `${dm[1]}-${dm[2].padStart(2, '0')}-${dm[3].padStart(2, '0')}`
      : null;

    // 상대경로 → 절대경로
    const link = BASE + a[1].replace(/^\.?\//, '');

    items.push({
      org: '대한변협',
      title,
      deadline: null, // 마감일은 본문에만 있어 자동추출 안 함
      link,
      created
    });
  }

  // 최신순 정렬 후 상위 N개
  items.sort((x, y) => (y.created || '').localeCompare(x.created || ''));
  const top = items.slice(0, MAX_ITEMS).map((it, i) => ({ id: i + 1, ...it }));

  const outDir = process.env.OUT_DIR || 'data';
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'notices.json');
  fs.writeFileSync(outFile, JSON.stringify({
    updated: new Date().toISOString(),
    source: '대한변협 공지사항',
    items: top
  }, null, 2), 'utf-8');

  console.log(`수집 완료: ${top.length}건 → ${outFile}`);
  top.forEach(t => console.log(`  [${t.created}] ${t.title}`));
}

main().catch(e => { console.error('실패:', e.message); process.exit(1); });
