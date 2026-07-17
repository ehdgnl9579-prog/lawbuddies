#!/usr/bin/env node
/*
 * fetch-news.js — 로버디스 조간 스크랩 자동 수집
 * ------------------------------------------------------------
 * 네이버 검색 오픈API(뉴스) → 정제·분류·중복제거 → data/news.json
 *
 * 실행:
 *   NAVER_CLIENT_ID=xxx NAVER_CLIENT_SECRET=yyy node fetch-news.js
 *
 * 의존성 없음. Node 18+ (내장 fetch 사용).
 *
 * 법적 유의: 원문 링크 + 제목 + 출처만 저장합니다(본문·요약 스니펫 없음).
 * 표준적인 헤드라인 링크백 방식이며, 네이버 오픈API 이용약관 범위 안에서 사용합니다.
 */

'use strict';
const fs = require('fs');

const CLIENT_ID     = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

/* ── 설정: 카테고리별 검색 키워드. 큐레이션 품질의 핵심 레버입니다 ── */
const CONFIG = {
  categories: [
    { cat: "법조",       queries: ["대법원 판결", "헌법재판소 결정", "법무부 입법예고", "변호사 징계"] },
    { cat: "금융",       queries: ["금융위원회", "금융감독원 제재", "가상자산 규제", "자본시장법 위반"] },
    { cat: "조세",       queries: ["국세청 세무조사", "조세심판원 결정", "법인세 과세처분", "상속세 증여세 판결"] },
    { cat: "공정거래",   queries: ["공정거래위원회 과징금", "담합 제재", "하도급법 위반", "가맹사업법"] },
    { cat: "형사",       queries: ["검찰 수사", "형사 판결", "구속영장"] },
    { cat: "노동",       queries: ["중앙노동위원회", "통상임금 판결", "중대재해처벌법", "부당해고 판정"] },
    { cat: "M&A",        queries: ["기업결합 심사", "인수합병 승인", "주주총회 분쟁"] },
    { cat: "IP·개인정보", queries: ["특허 침해 판결", "개인정보보호위원회 제재", "영업비밀 유출"] },
    { cat: "부동산·건설", queries: ["재건축 조합 소송", "건설 하자 판결", "임대차 분쟁 판결"] },
    { cat: "시사",       queries: ["국회 본회의", "주요 경제지표"] },
  ],
  perQuery:  15,   // 쿼리당 요청 건수
  sort:      "date",
  freshDays: 2,    // 최근 N일 이내만 유지
  maxPerCat: 12,   // 카테고리별 최종 노출 상한
  gapMs:     150,  // 요청 사이 간격
};

const OUT_FILE = process.env.OUT_FILE || "data/news.json";

// 언론사 표기 매핑 (없는 도메인은 호스트명 그대로 사용)
const SOURCE_MAP = {
  "yna.co.kr": "연합뉴스", "yonhapnews.co.kr": "연합뉴스",
  "lawtimes.co.kr": "법률신문", "koreanbar.or.kr": "대한변협",
  "hankyung.com": "한국경제", "mk.co.kr": "매일경제",
  "chosun.com": "조선일보", "joongang.co.kr": "중앙일보",
  "hani.co.kr": "한겨레", "donga.com": "동아일보",
  "khan.co.kr": "경향신문", "edaily.co.kr": "이데일리",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripHtml = (s) => (s || "").replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").trim();

function sourceFromLink(link) {
  try {
    const host = new URL(link).hostname.replace(/^www\./, "");
    for (const [domain, name] of Object.entries(SOURCE_MAP)) {
      if (host.includes(domain)) return name;
    }
    return host;
  } catch (e) { return "출처 미상"; }
}

function isFresh(pubDateStr, days) {
  const t = new Date(pubDateStr).getTime();
  if (Number.isNaN(t)) return true;   // 날짜 파싱 실패 시 일단 포함
  return Date.now() - t <= days * 86400000;
}

async function searchNaver(query) {
  const url = `https://openapi.naver.com/v1/search/news.json?query=${encodeURIComponent(query)}&display=${CONFIG.perQuery}&sort=${CONFIG.sort}`;
  const res = await fetch(url, {
    headers: {
      "X-Naver-Client-Id": CLIENT_ID,
      "X-Naver-Client-Secret": CLIENT_SECRET,
    },
  });
  if (!res.ok) throw new Error(`네이버 API 오류 HTTP ${res.status} (query="${query}")`);
  const data = await res.json();
  return data.items || [];
}

(async () => {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("환경변수 NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 이 필요합니다.");
    process.exit(1);
  }

  const seenLinks = new Set();   // 카테고리 전역 중복 제거
  const result = [];

  for (const { cat, queries } of CONFIG.categories) {
    const bucket = [];
    for (const q of queries) {
      let items = [];
      try { items = await searchNaver(q); }
      catch (e) { console.error("검색 실패:", e.message); continue; }
      await sleep(CONFIG.gapMs);

      for (const it of items) {
        const link = it.originallink || it.link;
        if (!link || seenLinks.has(link)) continue;
        if (!isFresh(it.pubDate, CONFIG.freshDays)) continue;

        seenLinks.add(link);
        bucket.push({
          cat,
          title:  stripHtml(it.title),
          source: sourceFromLink(link),
          link,
          created: new Date(it.pubDate).toISOString(),
        });
      }
    }
    bucket.sort((a, b) => new Date(b.created) - new Date(a.created));
    result.push(...bucket.slice(0, CONFIG.maxPerCat));
  }

  result.sort((a, b) => new Date(b.created) - new Date(a.created));

  const payload = {
    generated: new Date().toISOString(),
    source: "naver-search-api",
    count: result.length,
    items: result,
  };

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
  console.log(`news.json 저장 완료: ${result.length}건 → ${OUT_FILE}`);
})().catch((e) => { console.error("수집 실패:", e.message); process.exit(1); });
