#!/usr/bin/env node

/**
 * generate_pming.js
 *
 * Deterministic weekly content curation pipeline.
 * - Fetches RSS feeds from pming-sources.json
 * - Scores articles using keyword heuristics
 * - Selects top 5 from distinct sources
 * - Generates a Hugo-compatible Markdown post
 *
 * No LLMs or external AI APIs. Pure deterministic logic.
 */

const Parser = require("rss-parser");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "..");
const SOURCES_FILE = path.join(REPO_ROOT, "pming-sources.json");
const POSTS_DIR = path.join(REPO_ROOT, "content", "posts");
const MAX_ARTICLES = 5;
const LOOKBACK_DAYS = 90;
const FEED_TIMEOUT_MS = 15000;

// ---------------------------------------------------------------------------
// Keyword scoring weights
// ---------------------------------------------------------------------------

const PM_KEYWORDS = [
  "strategy",
  "roadmap",
  "prioritization",
  "stakeholder",
  "discovery",
  "product-market fit",
  "product market fit",
  "okr",
  "kpi",
  "backlog",
  "sprint",
  "user research",
  "product sense",
  "product management",
  "feature",
  "MVP",
  "go-to-market",
  "gtm",
  "pricing",
  "monetization",
];

const DATA_TECH_KEYWORDS = [
  "data",
  "system",
  "architecture",
  "pipeline",
  "ml",
  "machine learning",
  "ai",
  "artificial intelligence",
  "llm",
  "analytics",
  "experimentation",
  "a/b test",
  "ab test",
  "recommendation",
  "infrastructure",
  "platform",
  "engineering",
  "algorithm",
  "model",
  "deep learning",
];

const LEADERSHIP_KEYWORDS = [
  "leadership",
  "career",
  "scale",
  "growth",
  "culture",
  "hiring",
  "management",
  "team",
  "mentor",
  "promotion",
  "influence",
  "decision",
];

const PM_WEIGHT = 3;
const DATA_TECH_WEIGHT = 2;
const LEADERSHIP_WEIGHT = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Score an article based on keyword matches in title + summary.
 * Returns { keywordScore, lengthScore, totalScore }.
 */
function scoreArticle(article) {
  const text = `${article.title || ""} ${article.contentSnippet || ""} ${article.summary || ""}`.toLowerCase();

  let keywordScore = 0;

  for (const kw of PM_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) {
      keywordScore += PM_WEIGHT;
    }
  }

  for (const kw of DATA_TECH_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) {
      keywordScore += DATA_TECH_WEIGHT;
    }
  }

  for (const kw of LEADERSHIP_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) {
      keywordScore += LEADERSHIP_WEIGHT;
    }
  }

  // Length score: character count of content snippet (tiebreaker)
  const contentLength = (article.contentSnippet || article.summary || "").length;
  // Normalize to 0-5 range (5000 chars → 5 pts)
  const lengthScore = Math.min(contentLength / 1000, 5);

  const totalScore = keywordScore + lengthScore;

  return { keywordScore, lengthScore, totalScore };
}

/**
 * Parse a date from an RSS item. Returns a Date or null.
 */
function parseDate(item) {
  const raw = item.isoDate || item.pubDate || item.date;
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Format a Date as "Month DD, YYYY".
 */
function formatDateHuman(date) {
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * Format a Date as YYYY-MM-DD.
 */
function formatDateISO(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Extract all links from previously generated weekly curation posts.
 */
function getPreviouslyPublishedLinks() {
  const links = new Set();
  if (!fs.existsSync(POSTS_DIR)) return links;
  
  const files = fs.readdirSync(POSTS_DIR);
  for (const file of files) {
    if (file.endsWith("-weekly-pming.md")) {
      const content = fs.readFileSync(path.join(POSTS_DIR, file), "utf-8");
      // Look for Markdown links: [Title](https://...)
      const regex = /\]\((https?:\/\/[^\s\)]+)\)/g;
      let match;
      while ((match = regex.exec(content)) !== null) {
        links.add(match[1]);
      }
    }
  }
  return links;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main() {
  console.log("📰 PMing Weekly Curation Pipeline");
  console.log("==================================\n");

  // 1. Load sources
  const sources = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf-8"));
  console.log(`Loaded ${sources.length} sources from pming-sources.json\n`);

  // Load previously published links to avoid duplicates
  const publishedLinks = getPreviouslyPublishedLinks();
  console.log(`Loaded ${publishedLinks.size} previously published links to prevent duplicates.\n`);

  const parser = new Parser({
    timeout: FEED_TIMEOUT_MS,
    headers: {
      "User-Agent": "PMingCurator/1.0 (GitHub Pages Blog)",
    },
  });

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - LOOKBACK_DAYS);

  // 2. Fetch all feeds and collect scored articles
  const allCandidates = []; // { source, title, link, date, score }

  for (const source of sources) {
    console.log(`  Fetching: ${source.name} ...`);
    try {
      const feed = await parser.parseURL(source.feed);
      const items = (feed.items || [])
        .map((item) => {
          const date = parseDate(item);
          return { ...item, _parsedDate: date };
        })
        .filter((item) => {
          if (!item._parsedDate) return false;
          if (item._parsedDate < cutoffDate) return false;
          const link = item.link || source.url;
          if (publishedLinks.has(link)) return false;
          return true;
        });

      if (items.length === 0) {
        console.log(`    ⚠ No articles within last ${LOOKBACK_DAYS} days\n`);
        continue;
      }

      // Score each item
      const scored = items.map((item) => {
        const { totalScore, keywordScore } = scoreArticle(item);
        return {
          source: source.name,
          sourceUrl: source.url,
          title: (item.title || "Untitled").trim(),
          link: item.link || source.url,
          date: item._parsedDate,
          score: totalScore,
          keywordScore,
        };
      });

      // Pick the best article from this source
      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];
      console.log(
        `    ✅ ${items.length} articles found. Best: "${best.title}" (score: ${best.score.toFixed(1)})\n`
      );

      // Keep all scored articles (we may need fallbacks)
      allCandidates.push(...scored);
    } catch (err) {
      console.log(`    ❌ Failed: ${err.message}\n`);
    }
  }

  if (allCandidates.length === 0) {
    console.error("\n❌ No articles fetched from any source. Exiting.");
    process.exit(1);
  }

  // 3. Select top 5 from distinct sources
  // First, get the best article per source
  const bestPerSource = new Map();
  for (const c of allCandidates) {
    if (!bestPerSource.has(c.source) || c.score > bestPerSource.get(c.source).score) {
      bestPerSource.set(c.source, c);
    }
  }

  // Sort source-best articles by score
  const sortedBest = [...bestPerSource.values()].sort((a, b) => b.score - a.score);

  let selected = [];

  // Pick top 5 distinct sources
  for (const candidate of sortedBest) {
    if (selected.length >= MAX_ARTICLES) break;
    selected.push(candidate);
  }

  // If we don't have 5 yet, fill from all candidates (allowing duplicates per source)
  if (selected.length < MAX_ARTICLES) {
    const selectedLinks = new Set(selected.map((s) => s.link));
    const remaining = allCandidates
      .filter((c) => !selectedLinks.has(c.link))
      .sort((a, b) => b.score - a.score);

    for (const candidate of remaining) {
      if (selected.length >= MAX_ARTICLES) break;
      selected.push(candidate);
    }
  }

  // Final sort by score descending
  selected.sort((a, b) => b.score - a.score);

  console.log("\n🏆 Selected Articles:");
  console.log("---------------------");
  for (let i = 0; i < selected.length; i++) {
    const a = selected[i];
    console.log(`  ${i + 1}. [${a.source}] "${a.title}" (score: ${a.score.toFixed(1)}, date: ${formatDateISO(a.date)})`);
  }

  // 4. Generate the Markdown post
  const now = new Date();
  const dateStr = formatDateISO(now);
  const dateHuman = formatDateHuman(now);
  const filename = `${dateStr}-weekly-pming.md`;
  const filepath = path.join(POSTS_DIR, filename);

  // Build TOML front matter (IST timezone)
  const frontMatter = [
    "+++",
    `date = '${dateStr}T00:00:00+05:30'`,
    `draft = false`,
    `title = 'Weekly PMing Reads - ${dateHuman}'`,
    `categories = ['PMing']`,
    `tags = ['weekly-reads', 'product-management', 'curation']`,
    "+++",
  ].join("\n");

  // Build body
  const bodyLines = [
    "",
    `*A curated selection of the most interesting product management, data, and tech leadership reads from the past week.*`,
    "",
  ];

  for (let i = 0; i < selected.length; i++) {
    const a = selected[i];
    const pubDate = formatDateHuman(a.date);
    bodyLines.push(
      `${i + 1}. [${a.title}](${a.link}) — *${a.source}* · ${pubDate}`
    );
    bodyLines.push("");
  }

  bodyLines.push("---");
  bodyLines.push("");
  bodyLines.push(
    `*This post was automatically curated from ${sources.length} RSS feeds using a deterministic keyword-scoring pipeline. [View sources](https://github.com/harshmishra2991/harshmishra2991.github.io/blob/src/pming-sources.json).*`
  );
  bodyLines.push("");

  const content = frontMatter + "\n" + bodyLines.join("\n");

  // Ensure posts directory exists
  if (!fs.existsSync(POSTS_DIR)) {
    fs.mkdirSync(POSTS_DIR, { recursive: true });
  }

  fs.writeFileSync(filepath, content, "utf-8");

  console.log(`\n✅ Generated: ${filepath}`);
  console.log(`   Title: Weekly PMing Reads - ${dateHuman}`);
  console.log(`   Articles: ${selected.length}`);

  return filepath;
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
