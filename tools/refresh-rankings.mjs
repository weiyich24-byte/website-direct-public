#!/usr/bin/env node
// 自动刷新 Pages 仓库根目录的 rankings.json（静态站运行时榜单数据）。
// 页面解析逻辑复制自源码库 lib/model-rankings.ts，修改任何一处时必须同步另一处。
// 抓取或解析失败时退出码为 1 且不改动现有 rankings.json，线上站点不受影响。
// 用法：node tools/refresh-rankings.mjs
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE_URL = "https://artificialanalysis.ai/leaderboards/models";
const IMAGE_SOURCE_URL = "https://artificialanalysis.ai/image/leaderboard/text-to-image/";
const VIDEO_SOURCE_URL = "https://artificialanalysis.ai/video/leaderboard/text-to-video";
const ARTIFICIAL_ANALYSIS_ORIGIN = "https://artificialanalysis.ai";
const PAGE_TIMEOUT_MS = 20_000;
const MAX_PAGE_BYTES = 6_000_000;

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function decodeNextChunks(html) {
  const chunks = [];
  const pattern = /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)<\/script>/g;
  for (const match of html.matchAll(pattern)) {
    try {
      chunks.push(JSON.parse(`"${match[1]}"`));
    } catch {
      // Ignore unrelated or truncated RSC chunks.
    }
  }
  return chunks.join("");
}

function readJsonArray(source, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) return JSON.parse(source.slice(start, index + 1));
    }
  }
  throw new Error("排行榜页面数据不完整");
}

function extractModels(html) {
  const decoded = decodeNextChunks(html);
  const marker = '"models":[';
  let offset = 0;
  while ((offset = decoded.indexOf(marker, offset)) >= 0) {
    const rows = readJsonArray(decoded, offset + marker.length - 1);
    if (rows.some((row) => "intelligenceIndex" in row || "codingIndex" in row)) {
      return rows.map((row) => ({
        name: String(row.name || ""),
        shortName: String(row.shortName || row.name || ""),
        creator: String(row.modelCreatorName || ""),
        releaseDate: String(row.releaseDate || ""),
        deprecated: row.deprecated === true,
        intelligenceIndex: finiteNumber(row.intelligenceIndex),
        priceInput: finiteNumber(row.price1mInputTokens),
        priceOutput: finiteNumber(row.price1mOutputTokens),
      }));
    }
    offset += marker.length;
  }
  throw new Error("没有找到公开排行榜数据");
}

function officialCreatorLogo(value) {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value, ARTIFICIAL_ANALYSIS_ORIGIN);
    return url.origin === ARTIFICIAL_ANALYSIS_ORIGIN && url.pathname.startsWith("/img/logos/") ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function extractMediaRankings(html, kind) {
  const decoded = decodeNextChunks(html);
  const marker = '[[null,[{"formatted":{"rank":1';
  const start = decoded.indexOf(marker);
  if (start < 0) throw new Error("没有找到公开媒体排行榜数据");
  const outer = readJsonArray(decoded, start);
  const firstGroup = Array.isArray(outer[0]) ? outer[0] : [];
  const rows = Array.isArray(firstGroup[1]) ? firstGroup[1] : [];
  const rankings = rows
    .map((row) => row.values)
    .filter((values) => Boolean(values && values.isCurrent === true && finiteNumber(values.elo) !== null))
    .slice(0, 20)
    .map((values, index) => ({
      rank: index + 1,
      name: String(values.name || ""),
      variant: String(values.name || ""),
      creator: String(values.creator?.name || ""),
      creatorLogo: officialCreatorLogo(values.creator?.logo),
      score: Math.round(finiteNumber(values.elo) || 0),
      releaseDate: String(values.released || ""),
      priceInput: null,
      priceOutput: null,
      priceValue: finiteNumber(kind === "image" ? values.pricePer1kImages : values.pricePerMinute),
    }));
  if (rankings.length < 20) throw new Error("公开媒体排行榜数据不足");
  return rankings;
}

function modelFamily(value) {
  return value
    .replace(/\s*\((?:adaptive reasoning,?\s*)?(?:max|xhigh|high|medium|low)(?: effort)?\)\s*/gi, " ")
    .replace(/\s*\((?:max|xhigh|high|medium|low)\)\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function displayName(model) {
  return model.shortName
    .replace(/\s*\((?:max|xhigh|high|medium|low)\)\s*/gi, "")
    .replace(/\s*\(with fallback\)\s*/gi, "")
    .trim();
}

function rankModels(models) {
  const seen = new Set();
  return models
    .filter((model) => !model.deprecated && model.intelligenceIndex !== null)
    .sort((a, b) => b.intelligenceIndex - a.intelligenceIndex)
    .filter((model) => {
      const family = modelFamily(model.shortName || model.name);
      if (seen.has(family)) return false;
      seen.add(family);
      return true;
    })
    .slice(0, 20)
    .map((model, index) => ({
      rank: index + 1,
      name: displayName(model),
      variant: model.shortName,
      creator: model.creator,
      score: Number(model.intelligenceIndex.toFixed(1)),
      releaseDate: model.releaseDate,
      priceInput: model.priceInput,
      priceOutput: model.priceOutput,
    }));
}

async function fetchPublicHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "text/html", "user-agent": "Material-Intelligence-Rankings/1.0" },
    });
    if (!response.ok) throw new Error(`排行榜数据源返回 HTTP ${response.status}`);
    const html = await response.text();
    if (html.length > MAX_PAGE_BYTES) throw new Error("排行榜页面过大");
    return html;
  } finally {
    clearTimeout(timeout);
  }
}

const [modelsHtml, imageHtml, videoHtml] = await Promise.all([
  fetchPublicHtml(SOURCE_URL),
  fetchPublicHtml(IMAGE_SOURCE_URL),
  fetchPublicHtml(VIDEO_SOURCE_URL),
]);

const intelligence = rankModels(extractModels(modelsHtml));
if (intelligence.length < 20) throw new Error("综合能力榜数据不足 20 条");

const rankings = {
  schemaVersion: 4,
  source: "Artificial Analysis",
  sourceUrl: SOURCE_URL,
  sourceUrls: { intelligence: SOURCE_URL, image: IMAGE_SOURCE_URL, video: VIDEO_SOURCE_URL },
  fetchedAt: new Date().toISOString(),
  mode: "scheduled",
  intelligence,
  image: extractMediaRankings(imageHtml, "image"),
  video: extractMediaRankings(videoHtml, "video"),
};

const target = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "rankings.json");
const rankingData = (value) => JSON.stringify([value.schemaVersion, value.sourceUrls, value.intelligence, value.image, value.video]);
let previous = null;
try {
  previous = JSON.parse(await readFile(target, "utf8"));
} catch {
  // 首次运行或现有文件损坏时直接重写。
}
if (previous && rankingData(previous) === rankingData(rankings)) {
  console.log(`榜单数据无变化（上次抓取于 ${previous.fetchedAt}），保持现有 rankings.json。`);
} else {
  await writeFile(target, `${JSON.stringify(rankings, null, 2)}\n`, "utf8");
  console.log(`rankings.json 已更新：fetchedAt=${rankings.fetchedAt}`);
}
