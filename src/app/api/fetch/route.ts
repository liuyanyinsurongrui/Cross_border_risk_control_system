import { NextRequest, NextResponse } from 'next/server';
import * as cheerio from 'cheerio';
import type { ScrapedContent, ScrapedImage } from '@/lib/types';
import { isAccessDeniedText } from '@/lib/adult-audit';

const FETCH_TIMEOUT_MS = 10000;
const MAX_TEXT_CONTENT_LENGTH = 5000;
const MAX_PRODUCT_IMAGES = 12;
const MAX_DETAIL_IMAGES = 8;
const MAX_TOTAL_IMAGES = MAX_PRODUCT_IMAGES + MAX_DETAIL_IMAGES;
const MAX_JSON_TEXT_VALUES = 8;
const MAX_RAW_DETAIL_FRAGMENTS = 6;

interface FetchPageResult {
  ok: boolean;
  statusCode: number;
  html?: string;
}

interface ScrapePageResult {
  content?: ScrapedContent;
  statusCode: number;
  error?: string;
  pageState?: 'ok' | 'http-error' | 'access-denied' | 'empty' | 'insufficient-content';
}

/**
 * 缃戦〉鍐呭鎶撳彇 API 鈥?绾師鐢?fetch + cheerio 瀹炵幇
 * 涓嶄娇鐢?FetchClient SDK锛岄浂 token 娑堣€? * 
 * 鏂囧瓧鎻愬彇绛栫暐锛氱簿鍑嗗畾浣嶅晢鍝佸尯鍩燂紝鍙彁鍙栦骇鍝佺浉鍏崇殑鏂囧瓧鍐呭
 * 鍥剧墖鎻愬彇绛栫暐锛氬垎涓哄晢鍝佺礌鏉愬浘锛坓allery/涓诲浘锛夊拰鍟嗗搧璇︽儏鍥撅紙鎻忚堪鍖哄煙鐨勫浘鐗囷級
 */

// ============ 宸ュ叿鍑芥暟 ============

/** 鍒ゆ柇URL鏄惁涓洪潪浜у搧鍥剧墖锛坙ogo/icon/鏀粯鍥炬爣绛夊櫔澹帮級 */
function isNonProductImage(url: string): boolean {
  const lower = url.toLowerCase();
  const noisePatterns = [
    'sprite', 'icon', 'logo', 'favicon', 'pixel', '1x1',
    'tracking', 'analytics', 'badge', 'banner-ad', 'advertisement',
    'placeholder', 'loading', 'spinner', 'arrow', 'chevron',
    'close', 'menu', 'hamburger', 'search-icon', 'social',
    'payment', 'payment/', 'payment_icon', 'visa', 'mastercard', 'paypal', 'apple-pay',
    'google-pay', 'shop-pay', 'american_express', 'diners_club', 'discover',
    'klarna', 'afterpay', 'affirm', 'stripe',
    'safe-checkout', 'safe_checkout', 'secure-checkout',
    'trust', 'secure', 'lock', 'star-empty', 'rating-empty',
    '.gif', 'assets/', 'email-icon', 'whatsapp', 'facebook',
    'twitter', 'instagram', 'pinterest', 'youtube', 'tiktok',
  ];
  return noisePatterns.some(p => lower.includes(p));
}

/** 澶勭悊鍥剧墖URL锛氱浉瀵硅矾寰勮浆缁濆璺緞锛屽幓闄ゅ昂瀵稿悗缂€ */
function normalizeImageUrl(imgUrl: string, baseUrl: string): string | null {
  if (!imgUrl || !imgUrl.trim() || imgUrl.startsWith('data:') || imgUrl === '#') return null;

  let processedUrl = imgUrl.trim();

  if (processedUrl.startsWith('//')) {
    processedUrl = 'https:' + processedUrl;
  } else if (processedUrl.startsWith('/')) {
    try {
      const urlObj = new URL(baseUrl);
      processedUrl = urlObj.origin + processedUrl;
    } catch {
      return null;
    }
  }

  if (isNonProductImage(processedUrl)) return null;

  // 杩囨护澶皬鐨勭缉鐣ュ浘锛堝 50x50锛?
  const sizeMatch = processedUrl.match(/(\d{1,3})x(\d{1,3})/);
  if (sizeMatch) {
    const w = parseInt(sizeMatch[1]);
    const h = parseInt(sizeMatch[2]);
    if (w < 50 && h < 50) return null;
  }

  // 鍘绘帀 Shopify 灏哄鍚庣紑锛堝 _100x100.jpg 鈫?.jpg锛?  processedUrl = processedUrl.replace(/_\d+x\d+\.(jpg|jpeg|png|webp|avif|gif)$/i, '.$1');
  // 鍘绘帀鍏朵粬灏哄鏍煎紡
  processedUrl = processedUrl.replace(/-\d+x\d+\.(jpg|jpeg|png|webp|avif|gif)$/i, '.$1');

  return processedUrl;
}

function extractUrlFromSrcSet(srcset: string): string | null {
  const candidates = srcset
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry.split(/\s+/)[0])
    .filter(Boolean);

  return candidates.at(-1) ?? null;
}

function extractBackgroundImageUrls(style: string): string[] {
  const matches = style.match(/url\((['"]?)(.*?)\1\)/gi) ?? [];
  return matches
    .map((match) => {
      const urlMatch = match.match(/url\((['"]?)(.*?)\1\)/i);
      return urlMatch?.[2]?.trim() ?? '';
    })
    .filter(Boolean);
}

function decodeEscapedHtml(fragment: string): string {
  return fragment
    .replace(/\\u003c/gi, '<')
    .replace(/\\u003e/gi, '>')
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0027/gi, "'")
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\\//g, '/')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'");
}

function getImageDedupKey(imageUrl: string): string {
  try {
    const normalized = new URL(imageUrl);
    const removableParams = [
      'width',
      'height',
      'w',
      'h',
      'dpr',
      'fit',
      'crop',
      'quality',
      'q',
      'format',
      'fm',
      'auto',
      'trim',
      'ixlib',
      's',
      'sig',
      'signature',
      'token',
      'expires',
      'policy',
    ];

    removableParams.forEach((param) => normalized.searchParams.delete(param));
    normalized.hash = '';
    normalized.pathname = normalized.pathname.replace(/([_-])\d+x\d+(?=\.[a-z0-9]+$)/i, '');

    return normalized.toString();
  } catch {
    return imageUrl;
  }
}

function collectImageCandidates(
  $: cheerio.CheerioAPI,
  element: unknown
): string[] {
  const $el = $(element as never);
  const attrCandidates = [
    $el.attr('data-src'),
    $el.attr('data-lazy-src'),
    $el.attr('data-original'),
    $el.attr('data-zoom-image'),
    $el.attr('data-large_image'),
    $el.attr('data-bg'),
    $el.attr('data-background'),
    extractUrlFromSrcSet($el.attr('data-srcset') || ''),
    extractUrlFromSrcSet($el.attr('srcset') || ''),
    $el.attr('src'),
  ].filter((value): value is string => Boolean(value && value.trim()));

  const style = $el.attr('style') || '';
  const backgroundCandidates = extractBackgroundImageUrls(style);

  const pictureCandidates = $el
    .closest('picture')
    .find('source')
    .map((_index, source) => {
      const $source = $(source);
      return (
        extractUrlFromSrcSet($source.attr('srcset') || '') ||
        extractUrlFromSrcSet($source.attr('data-srcset') || '') ||
        ''
      );
    })
    .get()
    .filter(Boolean);

  return [...attrCandidates, ...backgroundCandidates, ...pictureCandidates];
}

function isLikelyUtilityContainer(
  $: cheerio.CheerioAPI,
  element: unknown
): boolean {
  const $el = $(element as never);
  const context = [
    $el.attr('class'),
    $el.attr('id'),
    $el.parent().attr('class'),
    $el.parent().attr('id'),
    $el.closest('header, footer, nav, aside, dialog').attr('class'),
    $el.closest('header, footer, nav, aside, dialog').attr('id'),
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(' ')
    .toLowerCase();

  const utilityKeywords = [
    'popup',
    'notification',
    'widget',
    'toast',
    'sales-pop',
    'modal',
    'header',
    'navbar',
    'nav-',
    'footer',
    'copyright',
    'newsletter',
    'subscribe',
    'sticky',
    'floating',
    'drawer',
  ];

  return utilityKeywords.some((keyword) => context.includes(keyword));
}

function isDecorativeImageElement(
  $: cheerio.CheerioAPI,
  element: unknown,
  imageUrl: string
): boolean {
  if (isLikelyUtilityContainer($, element)) return true;
  const $el = $(element as never);
  const container = $el.closest('section, article, div, aside, footer, li');
  const context = [
    imageUrl,
    $el.attr('alt'),
    $el.attr('title'),
    $el.attr('aria-label'),
    $el.attr('class'),
    $el.attr('id'),
    $el.parent().attr('class'),
    $el.parent().attr('id'),
    container.attr('class'),
    container.attr('id'),
    container.text().replace(/\s+/g, ' ').trim().slice(0, 300),
  ]
    .filter((value): value is string => Boolean(value && value.trim()))
    .join(' ')
    .toLowerCase();

  const decorativeKeywords = [
    'payment',
    'payment_icon',
    'footer_payment',
    'paypal',
    'visa',
    'mastercard',
    'discover',
    'american express',
    'american_express',
    'diners club',
    'diners_club',
    'google pay',
    'shop pay',
    'apple pay',
    'powered by stripe',
    'guaranteed safe checkout',
    'safe checkout',
    'secure checkout',
    'trusted checkout',
    'trust badge',
  ];

  return decorativeKeywords.some((keyword) => context.includes(keyword));
}

/** 浠?HTML 鐗囨涓彁鍙栧浘鐗嘦RL鍒楄〃 */
function extractImagesFromHtml(
  htmlFragment: string,
  baseUrl: string,
  maxImages: number
): string[] {
  if (!htmlFragment || (!htmlFragment.includes('<img') && !htmlFragment.includes('background-image'))) {
    return [];
  }

  const $ = cheerio.load(htmlFragment);
  const urls: string[] = [];
  const seen = new Set<string>();

  $('img').each((_i, el) => {
    if (urls.length >= maxImages) return;
    const $img = $(el);
    const candidates = collectImageCandidates($, el);
    for (const candidate of candidates) {
      if (isDecorativeImageElement($, el, candidate)) continue;
      const normalized = normalizeImageUrl(candidate, baseUrl);
      if (!normalized) continue;

      const dedupKey = getImageDedupKey(normalized);
      if (seen.has(dedupKey)) continue;

      seen.add(dedupKey);
      urls.push(normalized);
      break;
    }
  });

  $('[style*="background-image"]').each((_i, el) => {
    if (urls.length >= maxImages) return;
    const $el = $(el);
    for (const candidate of collectImageCandidates($, el)) {
      if (isDecorativeImageElement($, el, candidate)) continue;
      const normalized = normalizeImageUrl(candidate, baseUrl);
      if (!normalized) continue;

      const dedupKey = getImageDedupKey(normalized);
      if (seen.has(dedupKey)) continue;

      seen.add(dedupKey);
      urls.push(normalized);
      break;
    }
  });

  return urls;
}

function extractImageUrlsFromFragment(
  fragment: string,
  baseUrl: string,
  maxImages: number
): string[] {
  if (!fragment || !fragment.trim()) return [];

  const decodedFragment = decodeEscapedHtml(fragment);
  const urls = extractImagesFromHtml(decodedFragment, baseUrl, maxImages);
  if (urls.length >= maxImages) return urls;

  const seen = new Set(urls.map((imageUrl) => getImageDedupKey(imageUrl)));
  const directUrlMatches =
    decodedFragment.match(/(?:https?:)?\/\/[^"'()<>\s]+?\.(?:jpg|jpeg|png|webp|avif|gif)(?:\?[^"'()<>\s]*)?/gi) ?? [];

  for (const candidate of directUrlMatches) {
    if (urls.length >= maxImages) break;

    const normalized = normalizeImageUrl(candidate, baseUrl);
    if (!normalized) continue;

    const dedupKey = getImageDedupKey(normalized);
    if (seen.has(dedupKey)) continue;

    seen.add(dedupKey);
    urls.push(normalized);
  }

  return urls;
}

/** 娓呯悊 HTML 杞负绾枃鏈?*/
function htmlToText(html: string): string {
  if (!html || !/[<>]/.test(html)) {
    return html.trim();
  }

  const $ = cheerio.load(html);
  // 绉婚櫎涓嶉渶瑕佺殑鍏冪礌
  $('script, style, noscript, svg, button, input, select, textarea').remove();
  let text = $.text();
  // 娓呯悊澶氫綑绌虹櫧
  text = text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return text;
}

// ============ 宓屽叆鐨?Product JSON 鎻愬彇 ============

interface ProductJsonData {
  title?: string;
  image?: string;
  body_html?: string;
  description?: string;
  content?: string;
  post_content?: string;
  gallery?: Array<Record<string, string>>;
  medias?: Array<Record<string, string>>;
  images?: Array<Record<string, string> | string>;
  feature_image?: Record<string, string> | string;
  variants?: Array<Record<string, unknown>>;
  price?: string | number;
  min_price?: string | number;
  sale_price?: string | number;
  sku?: string;
  [key: string]: unknown;
}

/** 浠庨〉闈?HTML 涓彁鍙栧祵鍏ョ殑 product JSON 鏁版嵁锛圫hopify 绛夊父瑙佹ā寮忥級 */
function extractProductJson(html: string): ProductJsonData | null {
  // 鏂规硶1: 鏌ユ壘 "product": {...} 妯″紡锛岄獙璇佸惈 gallery/price/sku/variants 鎵嶇畻鏈夋晥
  const productJsonPattern = /"product"\s*:\s*(\{[^}]*"title")/;
  const productJsonMatch = html.match(productJsonPattern);
  if (productJsonMatch) {
    const startIdx = html.indexOf(productJsonMatch[0]) + '"product":'.length;
    let depth = 0;
    let endIdx = startIdx;
    for (let i = startIdx; i < Math.min(startIdx + 80000, html.length); i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) { endIdx = i + 1; break; }
      }
    }
    try {
      const candidate = JSON.parse(html.substring(startIdx, endIdx)) as ProductJsonData;
      if (candidate.gallery || candidate.price || candidate.min_price || candidate.sku || candidate.variants) {
        return candidate;
      }
    } catch {
      // 瑙ｆ瀽澶辫触锛岀户缁皾璇?
    }
  }

  // 鏂规硶2: 鏌ユ壘 <script> 鏍囩涓寘鍚?gallery+title 鐨勭嫭绔婮SON
  const scriptRegex = /<script[^>]*>\s*(\{[\s\S]*?"gallery"[\s\S]*?"title"[\s\S]*?\})\s*<\/script>/i;
  const scriptMatch = html.match(scriptRegex);
  if (scriptMatch) {
    try {
      const candidate = JSON.parse(scriptMatch[1]) as ProductJsonData;
      if (candidate.gallery && candidate.title) return candidate;
    } catch {
      // 瑙ｆ瀽澶辫触锛屽皾璇曞畬鏁存彁鍙?
      const rawStart = html.indexOf(scriptMatch[1]);
      let depth = 0;
      let endIdx = rawStart;
      for (let i = rawStart; i < Math.min(rawStart + 80000, html.length); i++) {
        if (html[i] === '{') depth++;
        else if (html[i] === '}') {
          depth--;
          if (depth === 0) { endIdx = i + 1; break; }
        }
      }
      try {
        const candidate = JSON.parse(html.substring(rawStart, endIdx)) as ProductJsonData;
        if (candidate.gallery && candidate.title) return candidate;
      } catch {
        // 鏈€缁堜篃澶辫触
      }
    }
  }

  return null;
}

function extractJsonStringValues(
  html: string,
  patterns: RegExp[],
  maxValues: number
): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null && results.length < maxValues) {
      const decoded = match[1]
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, ' ')
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
        .replace(/\\(.)/g, '$1')
        .trim();

      if (!decoded || seen.has(decoded)) continue;
      seen.add(decoded);
      results.push(decoded);
    }

    if (results.length >= maxValues) break;
  }

  return results;
}

function extractScriptComponentImageUrls(
  html: string,
  baseUrl: string,
  maxImages: number,
  excludeKeys: Set<string>
): string[] {
  if (!html || maxImages <= 0) return [];

  const results: string[] = [];
  const seen = new Set(excludeKeys);
  const entryPattern = /"key":"([^"]+)","target":"image","value":"((?:[^"\\]|\\.)*)"/gi;
  const skipKeyKeywords = [
    'avatar',
    'comment',
    'user',
    'icon',
    'logo',
    'badge',
    'payment',
    'trust',
    'secure',
    'author',
    'reviewer',
  ];

  let match: RegExpExecArray | null;
  while ((match = entryPattern.exec(html)) !== null && results.length < maxImages) {
    const key = match[1].toLowerCase();
    if (skipKeyKeywords.some((keyword) => key.includes(keyword))) {
      continue;
    }

    const rawUrl = match[2].replace(/\\\//g, '/').trim();
    const normalized = normalizeImageUrl(rawUrl, baseUrl);
    if (!normalized) continue;

    const dedupKey = getImageDedupKey(normalized);
    if (seen.has(dedupKey)) continue;

    seen.add(dedupKey);
    results.push(normalized);
  }

  return results;
}

// ============ 涓绘姄鍙栧嚱鏁?============

function normalizeRequestUrl(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;

  const withProtocol =
    trimmed.startsWith('http://') || trimmed.startsWith('https://')
      ? trimmed
      : `https://${trimmed}`;

  try {
    const parsed = new URL(withProtocol);
    if (!parsed.hostname.includes('.')) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

async function fetchPage(url: string): Promise<FetchPageResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      },
      redirect: 'follow',
    });

    const statusCode = response.status;
    if (!response.ok) {
      return { ok: false, statusCode };
    }

    return {
      ok: true,
      statusCode,
      html: await response.text(),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function scrapePage(url: string): Promise<ScrapePageResult> {
  try {
    const page = await fetchPage(url);
    if (!page.ok || !page.html) {
      return {
        statusCode: page.statusCode,
        error: `网页状态异常：HTTP ${page.statusCode}`,
        pageState: 'http-error',
      };
    }

    const html = page.html;

    /** 杩囨护 Shopify 妯℃澘榛樿鏂囨湰鍣０ */
    function filterTemplateNoise(text: string): string {
      const noisePatterns = [
        /You can use this popup[^.]*\./gi,
        /Image with text overlay/gi,
        /Use overlay text[^.]*\./gi,
        /Subscribe to our newsletter/gi,
        /A short sentence describing[^.]*\./gi,
        /Talk about your brand/gi,
        /Use this text to share information[^.]*\./gi,
        /Describe a product[^.]*\./gi,
        /Share announcements[^.]*\./gi,
        /Welcome to subscribe to our email/gi,
        /If you have any questions[^.]*\./gi,
        /we will give you the best help/gi,
        /DMCA report/gi,
        /TRACK YOUR ORDER/gi,
        /RETURN POLICY/gi,
        /SHIPPING INFORMATION/gi,
        /TERMS OF SERVICE/gi,
        /PRIVACY POLICY/gi,
        /CONTACT US/gi,
        /ABOUT US/gi,
        /FAQS?$/gim,
      ];
      let result = text;
      for (const pattern of noisePatterns) {
        result = result.replace(pattern, '');
      }
      return result.replace(/\n{3,}/g, '\n\n').replace(/[ \t]+\n/g, '\n').trim();
    }

    // 2. 鎻愬彇宓屽叆鐨?product JSON 鏁版嵁
    const productJson = extractProductJson(html);

    const textParts: string[] = [];
    let descriptionHtml = '';
    let usedJsonForDescription = false;

    // 3.1 浜у搧鏍囬 鈥?浼樺厛浠?JSON / <title> 蹇€熸彁鍙?
    const productTitle =
      productJson?.title?.trim() ||
      html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, ' ').trim() ||
      '';
    if (productTitle) textParts.push(productTitle);

    if (productJson) {
      const descFields = ['post_content', 'body_html', 'body', 'content', 'detail', 'description', 'description_html'];
      for (const field of descFields) {
        const val = productJson[field];
        if (typeof val === 'string' && val.length > 10) {
          const cleanDesc = htmlToText(val);
          if (cleanDesc.length > 10) {
            textParts.push(cleanDesc);
            descriptionHtml = val; // 淇濈暀鍘熷HTML鐢ㄤ簬鍚庣画鎻愬彇璇︽儏鍥?
            usedJsonForDescription = true;
            break;
          }
        }
      }

      // 鍙樹綋/瑙勬牸淇℃伅
      if (productJson.variants && Array.isArray(productJson.variants)) {
        const variantInfo = productJson.variants.slice(0, 10)
          .map((v: Record<string, unknown>) => {
            const vTitle = v.title as string | undefined;
            const vPrice = v.price ?? v.sale_price;
            return vTitle ? vTitle + (vPrice ? ' ($' + String(vPrice) + ')' : '') : '';
          })
          .filter(Boolean)
          .join(', ');
        if (variantInfo) textParts.push('瑙勬牸: ' + variantInfo);
      }

      // 浠锋牸
      const price = productJson.min_price ?? productJson.price ?? productJson.sale_price;
      if (price) textParts.push('浠锋牸: $' + String(price));
    }

    const $ = cheerio.load(html);

    if (!productTitle) {
      const titleSelectors = [
        'h1.product-title', 'h1.product__title', 'h1.product-single__title',
        'h1.title', '.product-title h1', '.product__title h1',
        '#product-form-wrap h1', '.product-info h1',
        'h1[class*="product"]', 'h1[class*="title"]',
      ];
      for (const sel of titleSelectors) {
        const el = $(sel).first();
        if (el.length && el.text().trim().length > 2) {
          textParts.unshift(el.text().trim());
          break;
        }
      }
    }

    // 3.3 濡傛灉 productJson 娌℃湁瓒冲鍐呭锛屼粠 DOM 鎻愬彇鎻忚堪鍖哄煙
    if (!usedJsonForDescription) {
      const descriptionSelectors = [
        '.product-description', '.product__description', '.rte',
        '#product-description', '.product-single__description',
        '.product-content', '.description.rte',
        '#product-form-wrap .description', '#product-form-wrap .rte',
        '[id*="product"] .description', '[id*="product"] .rte',
        '.product-detail', '.product-details',
        '.product-info .description', '.product-info .rte',
        '.product-single__description.rte',
        '.tab-content .description', '.tab-content .rte',
        '[role="tabpanel"] .description', '[role="tabpanel"] .rte',
      ];

      let descriptionText = '';
      for (const sel of descriptionSelectors) {
        const el = $(sel).first();
        if (el.length) {
          const rawText = el.text().trim();
          // 杩囨护妯℃澘鍣０鍚庡啀鍒ゆ柇
          const cleanText = filterTemplateNoise(rawText);
          if (cleanText.length > 20) {
            descriptionText = cleanText;
            descriptionHtml = $.html(el) || '';
            break;
          }
        }
      }

      // 濡傛灉绮剧‘閫夋嫨鍣ㄦ病鎵惧埌锛屽皾璇曟洿瀹芥硾鐨勫尮閰?
      if (!descriptionText) {
        const broadSelectors = [
          'div[class*="description"]', 'div[class*="detail"]',
          'section[class*="description"]', 'section[class*="detail"]',
          'div[id*="description"]', 'div[id*="detail"]',
          'div[class*="product-content"]', 'div[class*="rich-text"]',
        ];
        for (const sel of broadSelectors) {
          const el = $(sel).first();
          if (el.length) {
            const rawText = el.text().trim();
            const cleanText = filterTemplateNoise(rawText);
            if (cleanText.length > 20) {
              descriptionText = cleanText;
              descriptionHtml = $.html(el) || '';
              break;
            }
          }
        }
      }

      if (descriptionText) {
        textParts.push(descriptionText);
      }
    }

    // 3.4 濡傛灉浠嶇劧澶皯锛屼粠 JSON 姝ｅ垯鍏滃簳鎻愬彇
    let finalTextContent = filterTemplateNoise(textParts.join('\n\n'));

    if (finalTextContent.length < 100) {
      const jsonTexts = extractJsonStringValues(
        html,
        [
          /"(?:title|name|description|body|content|detail|summary)":\s*"([^"]{20,})"/gi,
          /"(?:product_title|product_name|product_description)":\s*"([^"]{10,})"/gi,
        ],
        MAX_JSON_TEXT_VALUES
      );
      if (jsonTexts.length > 0) {
        finalTextContent = filterTemplateNoise(jsonTexts.join('\n\n'));
      }
    }

    finalTextContent = finalTextContent.slice(0, MAX_TEXT_CONTENT_LENGTH);

    // ============ 4. 鎻愬彇鍥剧墖 鈥?鍒嗕负鍟嗗搧绱犳潗鍥惧拰璇︽儏鍥?============
    const productImages: ScrapedImage[] = [];
    const detailImages: ScrapedImage[] = [];
    const seenProductUrls = new Set<string>();
    const seenDetailUrls = new Set<string>();
    const hasEnoughProductImages = () => productImages.length >= MAX_PRODUCT_IMAGES;
    const hasEnoughDetailImages = () => detailImages.length >= MAX_DETAIL_IMAGES;
    const hasReachedImageTargets = () => hasEnoughProductImages() && hasEnoughDetailImages();

    function isProductImage(imgUrl: string): boolean {
      const normalized = normalizeImageUrl(imgUrl, url);
      if (!normalized) return false;
      return seenProductUrls.has(getImageDedupKey(normalized));
    }

    function addProductImage(imgUrl: string) {
      const normalized = normalizeImageUrl(imgUrl, url);
      if (!normalized) return;
      const dedupKey = getImageDedupKey(normalized);
      if (seenProductUrls.has(dedupKey)) return;
      if (hasEnoughProductImages()) return;
      seenProductUrls.add(dedupKey);
      productImages.push({ url: normalized, originalUrl: normalized, source: 'product' });
    }

    function addDetailImage(imgUrl: string) {
      const normalized = normalizeImageUrl(imgUrl, url);
      if (!normalized) return;
      const dedupKey = getImageDedupKey(normalized);
      if (seenProductUrls.has(dedupKey)) return;
      if (seenDetailUrls.has(dedupKey)) return;
      if (hasEnoughDetailImages()) return;
      seenDetailUrls.add(dedupKey);
      detailImages.push({ url: normalized, originalUrl: normalized, source: 'detail' });
    }

    // ---- 4.1 浠庡祵鍏ョ殑 productJson 鎻愬彇绱犳潗鍥?----
    if (productJson) {
      // feature_image 鈫?绱犳潗鍥?
      const featureImg = productJson.feature_image;
      if (featureImg) {
        if (typeof featureImg === 'string') addProductImage(featureImg);
        else if (typeof featureImg === 'object' && featureImg.url) addProductImage(featureImg.url);
      }
      // image 瀛楁
      const mainImg = productJson.image;
      if (typeof mainImg === 'string') addProductImage(mainImg);

      // gallery/medias/images 鏁扮粍 鈫?绱犳潗鍥?
      const mediaArrays = [
        productJson.medias ?? productJson.images ?? productJson.gallery,
      ] as Array<Array<Record<string, string> | string>>;
      for (const medias of mediaArrays) {
        if (hasEnoughProductImages()) break;
        if (medias && Array.isArray(medias)) {
          for (const media of medias) {
            if (hasEnoughProductImages()) break;
            if (typeof media === 'string') {
              addProductImage(media);
            } else if (typeof media === 'object') {
              if (media.url) addProductImage(media.url);
              if (media.thumbnail) addProductImage(media.thumbnail);
              if (media.display_url) addProductImage(media.display_url);
              if (media.original_url) addProductImage(media.original_url);
            }
          }
        }
      }

      // variants 涓殑鍥剧墖 鈫?绱犳潗鍥?
      if (productJson.variants && Array.isArray(productJson.variants)) {
        for (const variant of productJson.variants) {
          const v = variant as Record<string, unknown>;
          if (typeof v.image === 'string') addProductImage(v.image);
          if (v.feature_image && typeof v.feature_image === 'object') {
            const fi = v.feature_image as Record<string, string>;
            if (fi.url) addProductImage(fi.url);
          }
          if (hasEnoughProductImages()) break;
        }
      }

      // ---- 4.2 浠?productJson 鐨?content/body_html 鎻愬彇璇︽儏鍥?----
      if (!hasEnoughDetailImages()) {
        const contentFields = ['post_content', 'body_html', 'body', 'content', 'detail', 'description_html'];
        for (const field of contentFields) {
          if (hasEnoughDetailImages()) break;
          const val = productJson[field];
          if (typeof val === 'string' && val.trim().length > 0) {
            const remainingSlots = MAX_DETAIL_IMAGES - detailImages.length;
            const imgUrls = extractImageUrlsFromFragment(val, url, remainingSlots);
            for (const imgUrl of imgUrls) {
              if (isProductImage(imgUrl)) continue;
              addDetailImage(imgUrl);
            }
          }
        }
      }
    }

    // ---- 4.3 浠庨〉闈?HTML 鐨?gallery JSON 鏁扮粍鎻愬彇绱犳潗鍥?----
    const galleryKeys = ['gallery', 'medias', 'photos', 'slides', 'carousel', 'swiper', 'slider', 'product_images'];
    for (const key of galleryKeys) {
      if (hasEnoughProductImages()) break;
      const arrayRegex = new RegExp('"' + key + '"\\s*:\\s*\\[', 'i');
      const arrayMatch = arrayRegex.exec(html);
      if (arrayMatch) {
        const startIdx = arrayMatch.index + arrayMatch[0].length - 1;
        let depth = 0;
        let endIdx = startIdx;
        for (let i = startIdx; i < Math.min(startIdx + 30000, html.length); i++) {
          if (html[i] === '[') depth += 1;
          else if (html[i] === ']') {
            depth -= 1;
            if (depth === 0) { endIdx = i + 1; break; }
          }
        }
        try {
          const arrayData = JSON.parse(html.slice(startIdx, endIdx)) as Array<Record<string, unknown>>;
          for (const item of arrayData) {
            if (hasEnoughProductImages()) break;
            for (const field of ['url', 'thumbnail', 'image', 'src', 'poster', 'display_url', 'original_url']) {
              const val = item[field];
              if (typeof val === 'string' && val.length > 5) addProductImage(val);
            }
          }
        } catch {
          // JSON 瑙ｆ瀽澶辫触
        }
      }
    }

    // ---- 4.4 浠?HTML 涓?"content" 瀛楁锛坲nicode杞箟锛夋彁鍙栬鎯呭浘 ----
    const hasJsonProductImages = productImages.length > 0;
    const rawDetailFragments = extractJsonStringValues(
      html,
      [/"(?:post_content|body_html|content|detail|description_html|description)"\s*:\s*"((?:[^"\\]|\\.)*)"/gi],
      MAX_RAW_DETAIL_FRAGMENTS
    );
    for (const fragment of rawDetailFragments) {
      if (hasEnoughDetailImages()) break;
      const imgUrls = extractImageUrlsFromFragment(fragment, url, MAX_DETAIL_IMAGES - detailImages.length);
      for (const imgUrl of imgUrls) {
        const normalized = normalizeImageUrl(imgUrl, url);
        if (normalized && !seenProductUrls.has(getImageDedupKey(normalized))) {
          addDetailImage(imgUrl);
        }
      }
    }

    // ---- 4.5 浣跨敤 cheerio 浠庢弿杩板尯鍩?DOM 绮惧噯鎻愬彇璇︽儏鍥?----
    if (descriptionHtml && !hasEnoughDetailImages()) {
      const descImgUrls = extractImageUrlsFromFragment(descriptionHtml, url, MAX_DETAIL_IMAGES - detailImages.length);
      for (const imgUrl of descImgUrls) {
        const normalized = normalizeImageUrl(imgUrl, url);
        if (normalized && !seenProductUrls.has(getImageDedupKey(normalized))) {
          addDetailImage(imgUrl);
        }
      }
    }

    // 濡傛灉娌℃湁 descriptionHtml 浣?DOM 涓瓨鍦ㄦ弿杩板尯鍩?
    if (detailImages.length === 0 && !hasEnoughDetailImages()) {
      const descSelectors = [
        '.product-description', '.product__description', '.rte',
        '#product-description', '.product-single__description',
        '.product-content', '.description',
        'div[class*="description"]', 'div[class*="detail"]',
        'div[class*="rich-text"]',
      ];
      for (const sel of descSelectors) {
        const el = $(sel).first();
        if (el.length) {
          const imgs = el.find('img');
          imgs.each((_i, img) => {
            if (hasEnoughDetailImages()) return;
            const src = $(img).attr('data-src') || $(img).attr('data-lazy-src') || $(img).attr('src') || '';
            const normalized = normalizeImageUrl(src, url);
            if (
              normalized &&
              !seenProductUrls.has(getImageDedupKey(normalized)) &&
              !seenDetailUrls.has(getImageDedupKey(normalized))
            ) {
              addDetailImage(src);
            }
          });
          if (detailImages.length > 0) break;
        }
      }
    }

    // ---- 4.6 浠庡晢鍝佸浘搴撳尯鍩熸彁鍙栫礌鏉愬浘锛堝鏋?JSON 娌℃彁渚涳級 ----
    if (!hasJsonProductImages && !hasEnoughProductImages()) {
      const gallerySelectors = [
        '.product-gallery', '.product-single__photos',
        '.product__photos', '.product-images',
        '.product-slider', '.gallery',
        '[class*="product-gallery"]', '[class*="product-photos"]',
        '[class*="product-images"]', '[class*="product-media"]',
      ];
      for (const sel of gallerySelectors) {
        const el = $(sel).first();
        if (el.length) {
          const imgs = el.find('img');
          imgs.each((_i, img) => {
            if (hasEnoughProductImages()) return;
            const src = $(img).attr('data-src') || $(img).attr('data-lazy-src') || $(img).attr('data-zoom-image') || $(img).attr('src') || '';
            const normalized = normalizeImageUrl(src, url);
            if (normalized && !seenProductUrls.has(getImageDedupKey(normalized))) {
              addProductImage(src);
            }
          });
          if (productImages.length > 0) break;
        }
      }
    }

    // ---- 4.7 JSON-LD 缁撴瀯鍖栨暟鎹彁鍙栧浘鐗?----
    $('script[type="application/ld+json"]').each((_i, el) => {
      if (hasReachedImageTargets()) return;
      try {
        const jsonData = JSON.parse($(el).html() || '');
        const extractLdImages = (obj: unknown, target: 'product' | 'detail') => {
          if (!obj || typeof obj !== 'object') return;
          if (Array.isArray(obj)) {
            obj.forEach(item => extractLdImages(item, target));
            return;
          }
          const record = obj as Record<string, unknown>;
          const addFn = target === 'product' ? addProductImage : addDetailImage;
          for (const [key, value] of Object.entries(record)) {
            const isImageKey = ['image', 'images', 'thumbnailUrl', 'contentUrl', 'primaryImageOfPage'].includes(key);
            if (isImageKey) {
              if (typeof value === 'string') addFn(value);
              else if (Array.isArray(value)) {
                value.forEach(v => {
                  if (typeof v === 'string') addFn(v);
                  else if (v && typeof v === 'object' && 'url' in (v as Record<string, unknown>)) addFn((v as {url: string}).url);
                });
              } else if (value && typeof value === 'object' && 'url' in (value as Record<string, unknown>)) {
                addFn((value as {url: string}).url);
              }
            }
            if (typeof value === 'object' && value !== null) {
              extractLdImages(value, hasJsonProductImages ? 'detail' : 'product');
            }
          }
        };
        extractLdImages(jsonData, hasJsonProductImages ? 'detail' : 'product');
      } catch {
        // JSON 瑙ｆ瀽澶辫触
      }
    });

    // ---- 4.8 从脚本组件配置里补抓详情图（适配图片藏在 JSON schema 的页面） ----
    if (!hasEnoughDetailImages()) {
      const contextualDetailUrls = extractScriptComponentImageUrls(
        html,
        url,
        MAX_DETAIL_IMAGES - detailImages.length,
        new Set([...seenProductUrls, ...seenDetailUrls])
      );

      for (const imgUrl of contextualDetailUrls) {
        addDetailImage(imgUrl);
      }
    }

    // ---- 4.8 鏈€鍚庡厹搴曪細濡傛灉浠嶇劧娌℃湁浠讳綍鍥剧墖锛屼粠鏁翠釜椤甸潰鐨?img 鏍囩鎻愬彇 ----
    if (productImages.length + detailImages.length < 2) {
      $('img').each((_i, el) => {
        if (productImages.length + detailImages.length >= MAX_TOTAL_IMAGES) return;
        const $img = $(el);
        if (isLikelyUtilityContainer($, el)) return;
        const src = $img.attr('data-src') || $img.attr('data-lazy-src') || $img.attr('src') || '';
        const normalized = normalizeImageUrl(src, url);
        if (!normalized) return;

        // 鍒ゆ柇鏄惁鍦ㄨ鎯呭尯鍩?
        const isInDetailArea = $img.closest(
          '.product-description, .rte, #product-description, .description, [class*="detail"], [class*="description"]'
        ).length > 0;

        if (isInDetailArea) {
          addDetailImage(src);
        } else {
          addProductImage(src);
        }
      });
    }

    // 浼樺厛淇濈暀鐪嬭捣鏉ュ儚浜у搧鍥剧墖鐨刄RL
    const sortFn = (a: ScrapedImage, b: ScrapedImage) => {
      const productKeywords = ['product', 'item', 'goods', 'variant', 'catalog', 'media', 'shopify', 'cdn.shopify', 'cdn/image', 'cdn.fastcdnshop'];
      const aScore = productKeywords.some(k => a.url.toLowerCase().includes(k)) ? 0 : 1;
      const bScore = productKeywords.some(k => b.url.toLowerCase().includes(k)) ? 0 : 1;
      return aScore - bScore;
    };
    productImages.sort(sortFn);
    detailImages.sort(sortFn);

    const finalProductImages = productImages.slice(0, MAX_PRODUCT_IMAGES);
    const finalProductKeys = new Set(finalProductImages.map((img) => getImageDedupKey(img.url)));
    const finalDetailImages = detailImages
      .filter((img) => !finalProductKeys.has(getImageDedupKey(img.url)))
      .slice(0, MAX_DETAIL_IMAGES);
    const allImages = [...finalProductImages, ...finalDetailImages];

    const finalTitle = productTitle || url;
    const finalBodyText = (finalTextContent || '').trim();

    if (isAccessDeniedText(finalTitle) || isAccessDeniedText(finalBodyText)) {
      return {
        statusCode: page.statusCode,
        error: '页面访问受限或返回授权失败内容',
        pageState: 'access-denied',
        content: {
          title: finalTitle,
          textContent: finalBodyText || '页面访问受限',
          productImages: finalProductImages,
          detailImages: finalDetailImages,
          images: allImages,
          url,
          statusCode: page.statusCode,
        },
      };
    }

    if (!finalBodyText && allImages.length === 0) {
      return {
        statusCode: page.statusCode,
        error: '页面未提取到有效文字或图片',
        pageState: 'empty',
        content: {
          title: finalTitle,
          textContent: '',
          productImages: finalProductImages,
          detailImages: finalDetailImages,
          images: allImages,
          url,
          statusCode: page.statusCode,
        },
      };
    }

    if (finalBodyText.replace(/\s+/g, '').length < 20 && allImages.length === 0) {
      return {
        statusCode: page.statusCode,
        error: '页面内容过少，无法稳定判断',
        pageState: 'insufficient-content',
        content: {
          title: finalTitle,
          textContent: finalBodyText,
          productImages: finalProductImages,
          detailImages: finalDetailImages,
          images: allImages,
          url,
          statusCode: page.statusCode,
        },
      };
    }

    return {
      statusCode: page.statusCode,
      pageState: 'ok',
      content: {
        title: finalTitle,
        textContent: finalBodyText || '未能提取到有效文本内容',
        productImages: finalProductImages,
        detailImages: finalDetailImages,
        images: allImages,
        url,
        statusCode: page.statusCode,
      },
    };
  } catch (error) {
    return {
      statusCode: 0,
      error: error instanceof Error ? error.message : '网页抓取失败',
      pageState: 'http-error',
    };
  }
}

export async function POST(request: NextRequest) {
  try {
    const { url } = (await request.json()) as { url: string };
    const normalizedUrl = normalizeRequestUrl(url);

    if (!normalizedUrl) {
      return NextResponse.json(
        { success: false, error: '请提供有效的链接地址' },
        { status: 400 }
      );
    }

    const scrapedResult = await scrapePage(normalizedUrl);

    if (scrapedResult.error || !scrapedResult.content) {
      return NextResponse.json({
        success: false,
        error: scrapedResult.error || '网页抓取失败，请检查链接是否可访问',
        statusCode: scrapedResult.statusCode || undefined,
        pageState: scrapedResult.pageState,
        content: scrapedResult.content,
      });
    }

    return NextResponse.json({
      success: true,
      content: scrapedResult.content,
      fetchMethod: 'native-fetch+cheerio',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : '网页抓取失败';
    return NextResponse.json({ success: false, error: `网页抓取失败：${message}` });
  }
}




