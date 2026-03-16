/**
 * Lightweight news fetcher — polls free RSS feeds every 5 minutes.
 * Headlines are stored in memory and injected into AI analyst prompts
 * to give the model context about breaking events that may affect markets.
 * No external API keys required.
 */

interface NewsItem {
  title: string;
  description: string;
  pubDate: Date;
  source: string;
  link: string;
}

const MAX_HEADLINES = 40;
const FETCH_INTERVAL_MS = 5 * 60 * 1000;

const RSS_FEEDS: { url: string; source: string }[] = [
  { url: "https://www.espn.com/espn/rss/news", source: "ESPN" },
  { url: "https://feeds.bbci.co.uk/sport/rss.xml", source: "BBC Sport" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/Politics.xml", source: "NYT Politics" },
];

let cachedHeadlines: NewsItem[] = [];
let lastFetchAt: Date | null = null;
let fetchTimer: ReturnType<typeof setInterval> | null = null;

function extractTextBetween(text: string, open: string, close: string): string | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  const end = text.indexOf(close, start + open.length);
  if (end === -1) return null;
  return text.slice(start + open.length, end).replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}

function stripCdata(s: string): string {
  return s.replace(/<!\[CDATA\[|\]\]>/g, "").trim();
}

async function fetchFeed(url: string, source: string): Promise<NewsItem[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "KalshiAI-NewsBot/1.0 (research only)" },
    });
    clearTimeout(timeout);
    if (!res.ok) return [];
    const xml = await res.text();

    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match: RegExpExecArray | null;

    while ((match = itemRegex.exec(xml)) !== null && items.length < 15) {
      const block = match[1];
      const title = extractTextBetween(block, "<title>", "</title>");
      const desc = extractTextBetween(block, "<description>", "</description>");
      const pubDateStr = extractTextBetween(block, "<pubDate>", "</pubDate>");
      const link = extractTextBetween(block, "<link>", "</link>") || "";

      if (!title) continue;
      const pubDate = pubDateStr ? new Date(pubDateStr) : new Date();
      items.push({
        title: stripCdata(title),
        description: desc ? stripCdata(desc).slice(0, 200) : "",
        pubDate,
        source,
        link,
      });
    }

    return items;
  } catch {
    clearTimeout(timeout);
    return [];
  }
}

async function refreshAllFeeds(): Promise<void> {
  const results = await Promise.allSettled(RSS_FEEDS.map((f) => fetchFeed(f.url, f.source)));
  const allItems: NewsItem[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") allItems.push(...r.value);
  }

  allItems.sort((a, b) => b.pubDate.getTime() - a.pubDate.getTime());
  cachedHeadlines = allItems.slice(0, MAX_HEADLINES);
  lastFetchAt = new Date();
}

export function startNewsFetcher(): void {
  if (fetchTimer) return;
  refreshAllFeeds().catch(() => {});
  fetchTimer = setInterval(() => {
    refreshAllFeeds().catch(() => {});
  }, FETCH_INTERVAL_MS);
}

export function stopNewsFetcher(): void {
  if (fetchTimer) {
    clearInterval(fetchTimer);
    fetchTimer = null;
  }
}

export function getNewsFetcherStatus(): { headlines: number; lastFetchAt: string | null } {
  return {
    headlines: cachedHeadlines.length,
    lastFetchAt: lastFetchAt?.toISOString() ?? null,
  };
}

/**
 * Returns up to `maxItems` recent headlines relevant to the given market title/ticker.
 * Matches by keyword overlap between the headline and the market description.
 */
export function getRelevantNews(marketTitle: string, maxItems = 3): string {
  if (cachedHeadlines.length === 0) return "";

  const titleWords = marketTitle
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4);

  // Score headlines by keyword match overlap
  const scored = cachedHeadlines.map((item) => {
    const haystack = (item.title + " " + item.description).toLowerCase();
    const matchCount = titleWords.filter((w) => haystack.includes(w)).length;
    const recencyHours = (Date.now() - item.pubDate.getTime()) / 3_600_000;
    const recencyBoost = recencyHours < 2 ? 3 : recencyHours < 12 ? 1 : 0;
    return { item, score: matchCount + recencyBoost };
  });

  const relevant = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxItems);

  if (relevant.length === 0) {
    // Fall back to the 3 most recent headlines regardless of relevance
    return cachedHeadlines.slice(0, 2)
      .map((h) => `[${h.source}] ${h.title}`)
      .join("\n");
  }

  return relevant.map((s) => `[${s.item.source}] ${s.item.title}`).join("\n");
}

export function getAllRecentHeadlines(max = 10): NewsItem[] {
  return cachedHeadlines.slice(0, max);
}
