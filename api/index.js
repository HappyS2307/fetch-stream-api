const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Target Domain Configurations
// Keep multiple fallbacks because these public sites can change domains.
const ANIMESALT_BASES = [
    "https://animesalt.ac",
    "https://animesalt.cx",
    "https://animesalt.in",
    "https://animesalt.me"
];

const TOONSTREAM_BASES = [
    "https://toonstream.vip",
    "https://toonstream.dad",
    "https://toon-stream.site"
];

let ACTIVE_ANIMESALT_BASE = null;
let ACTIVE_TOONSTREAM_BASE = null;
let ACTIVE_ANIMESALT_AT = 0;
let ACTIVE_TOONSTREAM_AT = 0;

const DOMAIN_CACHE_MS = 10 * 60 * 1000;

const TMDB_API_KEY =
    process.env.TMDB_API_KEY ||
    "ed9311c3613b06f414be99abaec5dd86";

// Global Request Headers Generator
const getHeaders = (refererUrl) => ({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': refererUrl || 'https://google.com'
});

const getFinalBase = (response, fallbackBase) => {
    try {
        const finalUrl =
            response?.request?.res?.responseUrl ||
            response?.request?.responseURL ||
            fallbackBase;

        return new URL(finalUrl).origin;
    } catch {
        return fallbackBase;
    }
};

const probeDomain = async (base, label) => {
    try {
        const response = await axios.get(base, {
            headers: getHeaders(base),
            timeout: 7000,
            maxRedirects: 5,
            validateStatus: status => status >= 200 && status < 500
        });

        if (response.status >= 200 && response.status < 400) {
            const finalBase = getFinalBase(response, base);
            console.log(`[DOMAIN] ${label}: ${base} -> ${finalBase} (${response.status})`);
            return finalBase;
        }

        console.log(`[DOMAIN] ${label}: ${base} returned HTTP ${response.status}`);
    } catch (err) {
        console.log(`[DOMAIN] ${label}: ${base} failed: ${err.message}`);
    }

    return null;
};

const getWorkingBase = async (type, forceRefresh = false) => {
    const now = Date.now();

    if (
        type === 'animesalt' &&
        !forceRefresh &&
        ACTIVE_ANIMESALT_BASE &&
        now - ACTIVE_ANIMESALT_AT < DOMAIN_CACHE_MS
    ) {
        return ACTIVE_ANIMESALT_BASE;
    }

    if (
        type === 'toonstream' &&
        !forceRefresh &&
        ACTIVE_TOONSTREAM_BASE &&
        now - ACTIVE_TOONSTREAM_AT < DOMAIN_CACHE_MS
    ) {
        return ACTIVE_TOONSTREAM_BASE;
    }

    const candidates =
        type === 'animesalt'
            ? ANIMESALT_BASES
            : TOONSTREAM_BASES;

    for (const candidate of candidates) {
        const working = await probeDomain(
            candidate,
            type === 'animesalt' ? 'AnimeSalt' : 'ToonStream'
        );

        if (working) {
            if (type === 'animesalt') {
                ACTIVE_ANIMESALT_BASE = working;
                ACTIVE_ANIMESALT_AT = Date.now();
            } else {
                ACTIVE_TOONSTREAM_BASE = working;
                ACTIVE_TOONSTREAM_AT = Date.now();
            }

            return working;
        }
    }

    return null;
};

const getBaseCandidates = (type) =>
    type === 'animesalt'
        ? ANIMESALT_BASES
        : TOONSTREAM_BASES;

const buildUrlOnBase = (rawUrl, base) => {
    try {
        const parsed = new URL(rawUrl);
        const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
        return new URL(path || '/', base).href;
    } catch {
        return new URL(
            rawUrl.startsWith('/') ? rawUrl : `/${rawUrl}`,
            base
        ).href;
    }
};

const requestPageWithFallback = async (
    type,
    rawUrl,
    options = {}
) => {
    const bases = getBaseCandidates(type);
    const originalUrl = fixUrl(rawUrl);

    let firstUrl = originalUrl;

    try {
        const originalOrigin = new URL(originalUrl).origin;
        const matchingBase = bases.find(
            base => new URL(base).origin === originalOrigin
        );

        if (matchingBase) {
            firstUrl = originalUrl;
        } else {
            firstUrl = buildUrlOnBase(
                originalUrl,
                await getWorkingBase(type) || bases[0]
            );
        }
    } catch {}

    const urls = [
        firstUrl,
        ...bases.map(base => buildUrlOnBase(originalUrl, base))
    ].filter((url, index, arr) => arr.indexOf(url) === index);

    let lastError = null;

    for (const url of urls) {
        try {
            const parsed = new URL(url);
            const base = parsed.origin;

            const response = await axios.get(url, {
                headers: {
                    ...getHeaders(options.referer || base),
                    ...(options.headers || {})
                },
                timeout: options.timeout || 12000,
                maxRedirects: 5
            });

            const finalBase = getFinalBase(response, base);

            if (type === 'animesalt') {
                ACTIVE_ANIMESALT_BASE = finalBase;
                ACTIVE_ANIMESALT_AT = Date.now();
            } else {
                ACTIVE_TOONSTREAM_BASE = finalBase;
                ACTIVE_TOONSTREAM_AT = Date.now();
            }

            return {
                ...response,
                finalBase,
                requestedUrl: url
            };
        } catch (err) {
            lastError = err;
            console.log(
                `[${type.toUpperCase()} FALLBACK] ${url} failed: ${err.message}`
            );
        }
    }

    throw lastError || new Error(`No working ${type} domain found`);
};

// Clean URL Sanitizer
const fixUrl = (url) => {
    if (!url) return url;
    let cleanUrl = url.trim();

    if (!cleanUrl.endsWith('/') && !cleanUrl.includes('?')) {
        cleanUrl += '/';
    }
    return cleanUrl;
};

// Helper function to handle scraper errors gracefully
const handleScraperError = (res, err, contextMessage) => {
    const statusCode = err.response ? err.response.status : 500;
    let message = contextMessage;

    if (statusCode === 404) {
        message = "Target resource or page not found";
    } else if (statusCode === 403) {
        message = "Access blocked by target server (Cloudflare / WAF)";
    }

    return res.status(statusCode).json({
        error: message,
        upstream_status: statusCode,
        details: err.message
    });
};

// Helper to determine if link is a movie or series
const detectType = (link, classText) => {
    if (link && link.includes('/movies/')) return 'movie';
    if (classText && classText.includes('type-movies')) return 'movie';
    return 'series';
};

// ==========================================
// 1. EXTRACTOR HELPER LOGICS
// ==========================================

const searchAnimeSalt = async (query) => {
    const searchPaths = [
        `/?s=${encodeURIComponent(query)}`,
        `/search/?s=${encodeURIComponent(query)}`,
        `/s?q=${encodeURIComponent(query)}`
    ];

    const bases = ANIMESALT_BASES;
    const preferred = await getWorkingBase('animesalt');
    const orderedBases = [
        ...(preferred ? [preferred] : []),
        ...bases
    ].filter((base, index, arr) => arr.indexOf(base) === index);

    for (const base of orderedBases) {
        for (const path of searchPaths) {
            const searchUrl = `${base}${path}`;

            try {
                const response = await axios.get(searchUrl, {
                    headers: getHeaders(base),
                    timeout: 12000,
                    maxRedirects: 5
                });

                const data = response.data;
                const finalBase = getFinalBase(response, base);

                ACTIVE_ANIMESALT_BASE = finalBase;
                ACTIVE_ANIMESALT_AT = Date.now();

                const $ = cheerio.load(data);
                const results = [];
                const seen = new Set();

                $('ul.post-lst li, article, .bsx, .flw-item').each(
                    (index, element) => {
                        const classText = $(element).attr('class') || '';

                        const title =
                            $(element)
                                .find(
                                    'h2.entry-title, h3.entry-title, h2, h3, h4, .title, .film-name, .entry-title'
                                )
                                .first()
                                .text()
                                .trim();

                        let link =
                            $(element).find('a.lnk-blk').attr('href') ||
                            $(element).find('a[href*="/series/"]').first().attr('href') ||
                            $(element).find('a[href*="/movies/"]').first().attr('href') ||
                            $(element).find('a[href]').first().attr('href');

                        let image =
                            $(element).find('img').attr('data-src') ||
                            $(element).find('img').attr('src');

                        if (!link || !title) return;

                        try {
                            link = new URL(link, finalBase).href;
                        } catch {
                            return;
                        }

                        link = fixUrl(link);

                        if (seen.has(link)) return;
                        seen.add(link);

                        if (image && image.startsWith('//')) {
                            image = 'https:' + image;
                        } else if (image) {
                            try {
                                image = new URL(image, finalBase).href;
                            } catch {}
                        }

                        results.push({
                            title,
                            link,
                            image: image || null,
                            type: detectType(link, classText),
                            source: 'AnimeSalt'
                        });
                    }
                );

                if (results.length) {
                    return results.slice(0, 30);
                }
            } catch (err) {
                console.error(
                    `[AnimeSalt] Search failed for ${searchUrl}:`,
                    err.message
                );
            }
        }
    }

    return [];
};

const searchToonStream = async (query) => {
    const searchPaths = [
        `/s?q=${encodeURIComponent(query)}`,
        `/?s=${encodeURIComponent(query)}`,
        `/search/?s=${encodeURIComponent(query)}`
    ];

    const preferred = await getWorkingBase('toonstream');
    const orderedBases = [
        ...(preferred ? [preferred] : []),
        ...TOONSTREAM_BASES
    ].filter((base, index, arr) => arr.indexOf(base) === index);

    for (const base of orderedBases) {
        for (const path of searchPaths) {
            const searchUrl = `${base}${path}`;

            try {
                const response = await axios.get(searchUrl, {
                    headers: getHeaders(base),
                    timeout: 12000,
                    maxRedirects: 5
                });

                const data = response.data;
                const finalBase = getFinalBase(response, base);

                ACTIVE_TOONSTREAM_BASE = finalBase;
                ACTIVE_TOONSTREAM_AT = Date.now();

                const $ = cheerio.load(data);
                const results = [];
                const seen = new Set();

                $(
                    'ul.post-lst li, article, .bsx, .flw-item, .film_list-wrap .flw-item, .c-tabs-item__content'
                ).each((index, element) => {
                    const classText = $(element).attr('class') || '';

                    let link =
                        $(element).find('a.lnk-blk').attr('href') ||
                        $(element).find('a[href*="/series/"]').first().attr('href') ||
                        $(element).find('a[href*="/movies/"]').first().attr('href') ||
                        $(element).find('a[href]').first().attr('href');

                    let title =
                        $(element)
                            .find(
                                'h2.entry-title, h3.entry-title, h2, h3, h4, .title, .film-name, .film-name a, .entry-title'
                            )
                            .first()
                            .text()
                            .trim();

                    if (!title && link) {
                        title =
                            $(element)
                                .find('a[title]')
                                .first()
                                .attr('title') || '';
                    }

                    let image =
                        $(element).find('img').attr('data-src') ||
                        $(element).find('img').attr('data-lazy-src') ||
                        $(element).find('img').attr('src');

                    if (!link || !title) return;

                    try {
                        link = new URL(link, finalBase).href;
                    } catch {
                        return;
                    }

                    link = fixUrl(link);

                    const lowerLink = link.toLowerCase();

                    const looksLikeContent =
                        lowerLink.includes('/series/') ||
                        lowerLink.includes('/movies/') ||
                        lowerLink.includes('/anime/') ||
                        lowerLink.includes('/show/') ||
                        lowerLink.includes('/watch/');

                    if (!looksLikeContent || seen.has(link)) return;

                    seen.add(link);

                    if (image && image.startsWith('//')) {
                        image = 'https:' + image;
                    } else if (image) {
                        try {
                            image = new URL(image, finalBase).href;
                        } catch {}
                    }

                    results.push({
                        title,
                        link,
                        image: image || null,
                        type: detectType(link, classText),
                        source: 'ToonStream'
                    });
                });

                if (!results.length) {
                    $('a[href]').each((index, element) => {
                        let link = $(element).attr('href');
                        if (!link) return;

                        try {
                            link = new URL(link, finalBase).href;
                        } catch {
                            return;
                        }

                        link = fixUrl(link);

                        const lowerLink = link.toLowerCase();

                        const looksLikeContent =
                            lowerLink.includes('/series/') ||
                            lowerLink.includes('/movies/') ||
                            lowerLink.includes('/anime/') ||
                            lowerLink.includes('/show/') ||
                            lowerLink.includes('/watch/');

                        if (!looksLikeContent || seen.has(link)) return;

                        let title =
                            $(element).attr('title')?.trim() ||
                            $(element).find('img').attr('alt')?.trim() ||
                            $(element).text().trim();

                        if (!title) {
                            const parent = $(element).closest(
                                'article, li, .bsx, .flw-item, .film_list-wrap'
                            );

                            title = parent
                                .find(
                                    'h2, h3, h4, .title, .film-name, .entry-title'
                                )
                                .first()
                                .text()
                                .trim();
                        }

                        if (!title || title.length < 2) return;

                        seen.add(link);

                        let image =
                            $(element).find('img').attr('data-src') ||
                            $(element).find('img').attr('data-lazy-src') ||
                            $(element).find('img').attr('src') ||
                            null;

                        if (image && image.startsWith('//')) {
                            image = 'https:' + image;
                        } else if (image) {
                            try {
                                image = new URL(image, finalBase).href;
                            } catch {}
                        }

                        results.push({
                            title,
                            link,
                            image,
                            type: detectType(
                                link,
                                $(element).closest('[class]').attr('class') || ''
                            ),
                            source: 'ToonStream'
                        });
                    });
                }

                if (results.length) {
                    return results.slice(0, 30);
                }
            } catch (err) {
                console.error(
                    `[ToonStream] Search failed for ${searchUrl}:`,
                    err.message
                );
            }
        }
    }

    return [];
};

// ==========================================
// PUBLIC STREAM RESOLVER
// ==========================================

// ==========================================
// PUBLIC STREAM RESOLVER
// ==========================================

const resolvePublicStreamUrl = async (
    embedUrl,
    refererUrl = ACTIVE_TOONSTREAM_BASE || TOONSTREAM_BASES[0]
) => {
    try {
        const { data } = await axios.get(embedUrl, {
            headers: {
                ...getHeaders(refererUrl),
                Referer: refererUrl
            },
            timeout: 8000,
            maxRedirects: 5
        });

        const $ = cheerio.load(data);

        const media = [];
        const iframes = [];

        // Direct video/source tags
        $('video source, source').each((i, el) => {
            let src =
                $(el).attr('src') ||
                $(el).attr('data-src');

            if (!src) return;

            try {
                src = new URL(src, embedUrl).href;

                if (/\.(m3u8|mp4)(\?|$)/i.test(src)) {
                    media.push(src);
                }
            } catch {}
        });

        // Nested public iframe
        $('iframe').each((i, el) => {
            let src =
                $(el).attr('src') ||
                $(el).attr('data-src') ||
                $(el).attr('data-lazy-src');

            if (!src || src === 'about:blank') {
                return;
            }

            try {
                src = new URL(src, embedUrl).href;

                if (/^https?:\/\//i.test(src)) {
                    iframes.push(src);
                }
            } catch {}
        });

        // Public m3u8/mp4 links inside scripts
        $('script').each((i, el) => {
            const text = $(el).html() || '';

            const matches =
                text.match(
                    /https?:\/\/[^\s"'`\\<>]+?\.(?:m3u8|mp4)(?:\?[^\s"'`\\<>]*)?/gi
                ) || [];

            for (let link of matches) {
                link = link
                    .replace(/\\u0026/g, '&')
                    .replace(/\\\//g, '/')
                    .replace(/\\/g, '');

                media.push(link);
            }
        });

        return {
            media: [...new Set(media)],
            iframes: [...new Set(iframes)]
        };
    } catch (err) {
        console.log(
            `[STREAM RESOLVE] ${embedUrl}: ${err.message}`
        );

        return {
            media: [],
            iframes: []
        };
    }
};


const RAREANIMES_BASE = "https://www.rareanimes.mov";

const fetchRareAnimesPage = async (rawUrl) => {
    const url = new URL(rawUrl || "/", RAREANIMES_BASE).href;

    const response = await axios.get(url, {
        headers: getHeaders(RAREANIMES_BASE),
        timeout: 15000,
        maxRedirects: 5
    });

    return {
        data: response.data,
        url
    };
};

const extractRareAnimesRelatedData = (html) => {
    const source = String(html || "");

    const marker = "const relatedData";
    const markerIndex = source.indexOf(marker);

    if (markerIndex === -1) {
        console.error("[RareAnimes] relatedData marker not found");
        return {};
    }

    const start = source.indexOf("{", markerIndex);

    if (start === -1) {
        console.error("[RareAnimes] relatedData object start not found");
        return {};
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < source.length; i++) {
        const char = source[i];

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }

            if (char === "\\") {
                escaped = true;
                continue;
            }

            if (char === '"') {
                inString = false;
            }

            continue;
        }

        if (char === '"') {
            inString = true;
            continue;
        }

        if (char === "{") {
            depth++;
        } else if (char === "}") {
            depth--;

            if (depth === 0) {
                end = i + 1;
                break;
            }
        }
    }

    if (end === -1) {
        console.error("[RareAnimes] relatedData object end not found");
        return {};
    }

    const jsonText = source.slice(start, end);

    try {
        return JSON.parse(jsonText);
    } catch (err) {
        console.error(
            "[RareAnimes] relatedData JSON parse failed:",
            err.message
        );
        return {};
    }
};

const searchRareAnimes = async (query) => {
    const cleanQuery = String(query || "").trim();

    if (!cleanQuery) {
        return [];
    }

    const searchUrl =
        RAREANIMES_BASE +
        "/?s=" +
        encodeURIComponent(cleanQuery);

    try {
        const response = await axios.get(searchUrl, {
            headers: getHeaders(RAREANIMES_BASE),
            timeout: 15000,
            maxRedirects: 5
        });

        const $ = cheerio.load(response.data);
        const results = [];
        const seen = new Set();
        const queryLower = cleanQuery.toLowerCase();

        $("a[href]").each((index, element) => {
            const title = $(element)
                .text()
                .replace(/\s+/g, " ")
                .trim();

            const href = $(element).attr("href");

            if (!title || !href) {
                return;
            }

            let link;

            try {
                link = new URL(href, RAREANIMES_BASE).href;
            } catch {
                return;
            }

            const parsed = new URL(link);

            if (parsed.hostname !== "www.rareanimes.mov") {
                return;
            }

            if (
                parsed.pathname === "/" &&
                !parsed.searchParams.has("s")
            ) {
                return;
            }

            const blockedPaths = [
                "/category/",
                "/tag/",
                "/page/",
                "/author/",
                "/search/"
            ];

            if (
                blockedPaths.some(path =>
                    parsed.pathname.includes(path)
                )
            ) {
                return;
            }

            if (
                parsed.searchParams.has("s") ||
                parsed.searchParams.has("url")
            ) {
                return;
            }

            if (!title.toLowerCase().includes(queryLower)) {
                return;
            }

            link = fixUrl(link);

            if (seen.has(link)) {
                return;
            }

            seen.add(link);

            results.push({
                title,
                link,
                type: "series",
                source: "RareAnimes"
            });
        });

        return results.slice(0, 30);
    } catch (err) {
        console.error("[RareAnimes] Search failed:", err.message);
        return [];
    }
};

const getRareAnimesEpisodes = (html) => {
    const relatedData = extractRareAnimesRelatedData(html);
    const seasons = [];

    // Legacy/current public-page format: relatedData -> SEA_* -> episodes[]
    for (const [key, group] of Object.entries(relatedData)) {
        if (!/^SEA_\d+$/i.test(key) || !group) {
            continue;
        }

        const match = String(group.title || key).match(/(\d+)/);
        const seasonNum = match ? match[1] : key.replace(/\D/g, "");

        const episodes = Array.isArray(group.episodes)
            ? group.episodes
                .filter(ep => ep && ep.id)
                .map((ep, index) => ({
                    epNum: String(ep.e || index + 1),
                    title:
                        ep.ep_name ||
                        group.title ||
                        "Episode " + String(ep.e || index + 1),
                    link:
                        RAREANIMES_BASE +
                        "/?url=" +
                        encodeURIComponent(String(ep.id)),
                    image: ep.img || group.poster || null
                }))
            : [];

        if (!episodes.length) continue;

        seasons.push({
            name: group.title || ("Season " + seasonNum),
            seasonNum,
            episodes
        });
    }

    // Current public-page fallback:
    // episode pages are exposed as public links containing ?url=<episode-id>.
    if (!seasons.length) {
        const $ = cheerio.load(String(html || ""));
        const episodes = [];
        const seen = new Set();

        $('a[href]').each((index, element) => {
            const href = $(element).attr('href');
            if (!href) return;

            let link;
            try {
                link = new URL(href, RAREANIMES_BASE).href;
            } catch {
                return;
            }

            const parsed = new URL(link);
            const episodeId = parsed.searchParams.get('url');

            if (
                parsed.hostname !== 'www.rareanimes.mov' &&
                parsed.hostname !== 'rareanimes.mov'
            ) {
                return;
            }

            if (!episodeId || seen.has(episodeId)) return;

            const text =
                $(element)
                    .text()
                    .replace(/\s+/g, ' ')
                    .trim() ||
                $(element).attr('title')?.trim() ||
                $(element).find('img').attr('alt')?.trim() ||
                '';

            // Keep only links that look like episode entries.
            const looksLikeEpisode =
                /\b(?:episode|ep|e)\s*[-_.:#]?\s*\d+\b/i.test(text) ||
                /\b\d+\b/.test(text);

            if (!looksLikeEpisode) return;

            const numberMatch =
                text.match(/\b(?:episode|ep|e)\s*[-_.:#]?\s*(\d+)\b/i) ||
                text.match(/\b(\d+)\b/);

            const epNum =
                numberMatch?.[1] ||
                String(episodes.length + 1);

            let image =
                $(element).find('img').attr('data-src') ||
                $(element).find('img').attr('data-lazy-src') ||
                $(element).find('img').attr('src') ||
                null;

            if (image) {
                try {
                    image = new URL(image, RAREANIMES_BASE).href;
                } catch {
                    image = null;
                }
            }

            seen.add(episodeId);

            episodes.push({
                epNum: String(epNum),
                title: text || `Episode ${epNum}`,
                link,
                image
            });
        });

        episodes.sort((a, b) => Number(a.epNum) - Number(b.epNum));

        if (episodes.length) {
            const seasonMatch =
                String(
                    $('h1').first().text() ||
                    $('title').text() ||
                    ''
                ).match(/season\s*(\d+)/i);

            const seasonNum = seasonMatch?.[1] || '1';

            seasons.push({
                name: `Season ${seasonNum}`,
                seasonNum,
                episodes
            });
        }
    }

    seasons.sort(
        (a, b) => Number(a.seasonNum) - Number(b.seasonNum)
    );

    return {
        seasons,
        episodes: seasons[0]?.episodes || []
    };
};

// ==========================================
// 2. EXPRESS ROUTES
// ==========================================

// HOME
app.get('/', (req, res) => {
    res.json({
        status: "Active",
        message: "FetchStream Scraper API is running.",
        sources: [
            "AnimeSalt",
            "ToonStream",
            "RareAnimes"
        ]
    });
});

// ==========================================
// COMBINED SEARCH
// ==========================================

app.get('/search', async (req, res) => {
    const query = req.query.q;

    if (!query) {
        return res.status(400).json({
            error: "Query parameter 'q' is required"
        });
    }

    const [saltResults, toonResults, rareResults] =
        await Promise.all([
            searchAnimeSalt(query),
            searchToonStream(query),
            searchRareAnimes(query)
        ]);

    res.json({
        query,
        total:
            saltResults.length +
            toonResults.length +
            rareResults.length,
        results: [
            ...saltResults,
            ...toonResults,
            ...rareResults
        ]
    });
});

// ==========================================
// ANIME SALT SEARCH
// ==========================================

app.get('/animesalt/search', async (req, res) => {
    const query = req.query.q;

    if (!query) {
        return res.status(400).json({
            error: "Query 'q' is required"
        });
    }

    const results = await searchAnimeSalt(query);

    res.json({
        source: "AnimeSalt",
      results
    });
});

// ==========================================
// ANIME SALT EPISODES
// ==========================================

app.get('/animesalt/episodes', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({
            error: "URL is required"
        });
    }

    try {
        const response = await requestPageWithFallback(
            'animesalt',
            rawUrl,
            { timeout: 12000 }
        );

        const $ = cheerio.load(response.data);
        const base = response.finalBase;

        const episodes = [];
        const seasons = [];

        $('.season-btn').each((i, el) => {
            const name = $(el).text().trim();
            const seasonNum = $(el).attr('data-season');
            const postId = $(el).attr('data-post');

            if (seasonNum && postId) {
                seasons.push({
                    name,
                    seasonNum,
                    postId
                });
            }
        });

        $('#episode_by_temp li').each((i, element) => {
            const epNum =
                $(element)
                    .find('.num-epi')
                    .text()
                    .trim();

            const title =
                $(element)
                    .find('h2.entry-title')
                    .text()
                    .trim();

            let link =
                $(element)
                    .find('a.lnk-blk')
                    .attr('href');

            if (link) {
                try {
                    link = new URL(link, base).href;
                } catch {
                    link = null;
                }

                if (link) {
                    link = fixUrl(link);
                }
            }

            let image =
                $(element).find('img').attr('data-src') ||
                $(element).find('img').attr('src');

            if (image && image.startsWith('//')) {
                image = 'https:' + image;
            } else if (image) {
                try {
                    image = new URL(image, base).href;
                } catch {}
            }

            if (link) {
                episodes.push({
                    epNum: epNum || (i + 1).toString(),
                    title,
                    link,
                    image: image || null
                });
            }
        });

        res.json({
            seasons,
            episodes,
            source_base: base
        });
    } catch (err) {
        handleScraperError(
            res,
            err,
            "Failed to load episodes from AnimeSalt"
        );
    }
});
// ==========================================
// ANIME SALT STREAMS
// ==========================================

app.get('/animesalt/streams', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({
            error: "URL is required"
        });
    }

    try {
        const response = await requestPageWithFallback(
            'animesalt',
            rawUrl,
            { timeout: 12000 }
        );

        const $ = cheerio.load(response.data);
        const base = response.finalBase;

        const streamSources = [];
        const downloadSources = [];

        const title = $('h1').text().trim();

        let poster =
            $('.post-thumbnail img').attr('src') ||
            $('.post-thumbnail img').attr('data-src') ||
            $('.bd img[src*="tmdb.org"]').attr('src') ||
            $('.bd img').first().attr('src');

        let backdrop =
            $('.bghd img.TPostBg').attr('src') ||
            $('.bghd img').attr('src') ||
            $('.bghd img').attr('data-src');

        if (poster) {
            try {
                poster = new URL(poster, base).href;
            } catch {}
        }

        if (backdrop) {
            try {
                backdrop = new URL(backdrop, base).href;
            } catch {}
        }

        $('#aa-options iframe').each((index, element) => {
            const src =
                $(element).attr('src') ||
                $(element).attr('data-src');

            if (!src) return;

            if (src.includes('?data=')) {
                try {
                    const urlObj = new URL(src, base);
                    const base64Data = urlObj.searchParams.get('data');

                    if (base64Data) {
                        const decodedJson =
                            Buffer.from(base64Data, 'base64').toString('utf-8');

                        const parsedStreams = JSON.parse(decodedJson);

                        if (Array.isArray(parsedStreams)) {
                            parsedStreams.forEach(stream => {
                                if (!stream?.link) return;

                                streamSources.push({
                                    server: 'Abyss (Multi-Lang)',
                                    language: stream.language || 'Default',
                                    link: stream.link
                                });
                            });
                        }
                    }
                } catch {}
            } else {
                let serverName = 'Server';

                if (src.includes('as-cdn')) {
                    serverName = 'playX';
                }

                try {
                    streamSources.push({
                        server: serverName,
                        language: 'Default',
                        link: new URL(src, base).href
                    });
                } catch {}
            }
        });

        $('#mdl-download .download-links table tbody tr')
            .each((i, el) => {
                const server =
                    $(el)
                        .find('td')
                        .first()
                        .text()
                        .replace(/#\d+\s*/g, '')
                        .trim();

                const lang =
                    $(el)
                        .find('td:nth-child(2)')
                        .text()
                        .trim();

                const quality =
                    $(el)
                        .find('td:nth-child(3)')
                        .text()
                        .trim();

                let link =
                    $(el)
                        .find('a')
                        .attr('href');

                if (!link) return;

                try {
                    link = new URL(link, base).href;
                } catch {
                    return;
                }

                downloadSources.push({
                    server: server || 'Download',
                    language: lang || 'Default',
                    quality: quality || 'HD',
                    link: fixUrl(link)
                });
            });

        res.json({
            title: title || null,
            poster_image: poster || null,
            thumbnail_image: backdrop || null,
            streams: streamSources,
            downloads: downloadSources,
            source_base: base
        });
    } catch (err) {
        handleScraperError(
            res,
            err,
            "Failed to load streams from AnimeSalt"
        );
    }
});

// ==========================================
// TOONSTREAM SEARCH
// ==========================================

app.get('/toonstream/search', async (req, res) => {
    const query = req.query.q;

    if (!query) {
        return res.status(400).json({
            error: "Query 'q' is required"
        });
    }

    const results = await searchToonStream(query);

    res.json({
        source: "ToonStream",
        results
    });
});

// ==========================================
// TOONSTREAM EPISODES
// ==========================================

app.get('/toonstream/episodes', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({
            error: "URL is required"
        });
    }

    try {
        const response = await requestPageWithFallback(
            'toonstream',
            rawUrl,
            { timeout: 12000 }
        );

        const $ = cheerio.load(response.data);
        const base = response.finalBase;

        const episodes = [];
        const seasons = [];

        $('.season-btn').each((i, el) => {
            const name = $(el).text().trim();
            const seasonNum = $(el).attr('data-season');
            const url = $(el).attr('data-url');

            if (seasonNum) {
                seasons.push({
                    name,
                    seasonNum,
                    ajaxUrl: url
                });
            }
        });

        $('#episode_by_temp li').each((i, element) => {
            const epNum =
                $(element)
                    .find('.num-epi')
                    .text()
                    .trim();

            const title =
                $(element)
                    .find('h5.entry-title1')
                    .text()
                    .trim();

            let link =
                $(element)
                    .find('a.lnk-blk')
                    .attr('href');

            if (link) {
                try {
                    link = new URL(link, base).href;
                } catch {
                    link = null;
                }

                if (link) {
                    link = fixUrl(link);
                }
            }

            let image =
                $(element).find('img').attr('data-src') ||
                $(element).find('img').attr('src');

            if (image && image.startsWith('//')) {
                image = 'https:' + image;
            } else if (image) {
                try {
                    image = new URL(image, base).href;
                } catch {}
            }

            if (link) {
                episodes.push({
                    epNum: epNum || (i + 1).toString(),
                    title,
                    link,
                    image: image || null
                });
            }
        });

        res.json({
            seasons,
            episodes,
            source_base: base
        });
    } catch (err) {
        handleScraperError(
            res,
            err,
            "Failed to load episodes from ToonStream"
        );
    }
});
// ==========================================
// TOONSTREAM STREAMS - IMPROVED
// ==========================================

app.get('/toonstream/streams', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({
            error: "URL is required"
        });
    }

    const epUrl = fixUrl(rawUrl);

    try {
        const response = await requestPageWithFallback(
            'toonstream',
            epUrl,
            {
                timeout: 12000,
                referer: ACTIVE_TOONSTREAM_BASE || TOONSTREAM_BASES[0]
            }
        );

        const $ = cheerio.load(response.data);
        const base = response.finalBase;

        const streamCandidates = [];
        const downloadSources = [];

        const title =
            $('h1.entry-title').text().trim() ||
            $('h1').first().text().trim();

        let poster =
            $('.post-thumbnail img').attr('src') ||
            $('.post-thumbnail img').attr('data-src') ||
            $('.post-thumbnail img').attr('data-lazy-src');

        let backdrop =
            $('.bghd img.TPostBg').attr('src') ||
            $('.bghd img').attr('data-src') ||
            $('.bghd img').attr('src');

        if (poster) {
            try {
                poster = new URL(poster, base).href;
            } catch {}
        }

        if (backdrop) {
            try {
                backdrop = new URL(backdrop, base).href;
            } catch {}
        }

        const serverMap = {};

        $(
            '.video-options .aa-tbs-video li, ' +
            '.video-options li, ' +
            '.aa-tbs-video li'
        ).each((i, el) => {
            const a = $(el).find('a').first();

            const id =
                a.attr('href') ||
                a.attr('data-target') ||
                a.attr('data-id');

            const name =
                $(el).find('.server').text().trim() ||
                $(el).find('.title').text().trim() ||
                a.text().trim() ||
                `Server ${i + 1}`;

            if (id) {
                serverMap[id.replace(/^#/, '').trim()] = name;
            }
        });

        $(
            'iframe, ' +
            '.video iframe, ' +
            '.video-player iframe'
        ).each((i, el) => {
            let src =
                $(el).attr('src') ||
                $(el).attr('data-src') ||
                $(el).attr('data-lazy-src');

            if (!src || src === 'about:blank') return;

            try {
                src = new URL(src, base).href;
            } catch {
                return;
            }

            if (!/^https?:\/\//i.test(src)) return;

            const videoParent = $(el).closest('.video');

            const id =
                videoParent.attr('id') ||
                $(el).closest('[id]').attr('id');

            const server =
                serverMap[id] ||
                $(el)
                    .closest('li')
                    .find('.server')
                    .text()
                    .trim() ||
                `Server ${i + 1}`;

            streamCandidates.push({
                server,
                link: src,
                type: 'embed'
            });
        });

        $('video source, source').each((i, el) => {
            let src =
                $(el).attr('src') ||
                $(el).attr('data-src');

            if (!src) return;

            try {
                src = new URL(src, base).href;
            } catch {
                return;
            }

            if (/\.(m3u8|mp4)(\?|$)/i.test(src)) {
                streamCandidates.push({
                    server: `Direct ${i + 1}`,
                    language: 'Default',
                    link: src,
                    type: /\.m3u8/i.test(src) ? 'm3u8' : 'mp4'
                });
            }
        });

        $('script').each((i, el) => {
            const scriptText = $(el).html() || '';

            const matches =
                scriptText.match(
                    /https?:\/\/[^\s"'`\\<>]+?\.(?:m3u8|mp4)(?:\?[^\s"'`\\<>]*)?/gi
                ) || [];

            for (let link of matches) {
                link = link
                    .replace(/\\u0026/g, '&')
                    .replace(/\\\//g, '/')
                    .replace(/\\/g, '');

                streamCandidates.push({
                    server: 'Direct',
                    language: 'Default',
                    link,
                    type: /\.m3u8/i.test(link) ? 'm3u8' : 'mp4'
                });
            }
        });

        const resolved = [];
        const seenPlayers = new Set();

        for (const candidate of streamCandidates) {
            if (
                !candidate.link ||
                seenPlayers.has(candidate.link)
            ) {
                continue;
            }

            seenPlayers.add(candidate.link);

            if (candidate.type !== 'embed') {
                resolved.push(candidate);
                continue;
            }

            const result =
                await resolvePublicStreamUrl(
                    candidate.link,
                    base
                );

            if (result.media.length) {
                for (const media of result.media) {
                    resolved.push({
                        server: candidate.server,
                        language: 'Default',
                        link: media,
                        type: /\.m3u8/i.test(media) ? 'm3u8' : 'mp4'
                    });
                }
            } else {
                resolved.push(candidate);
            }

            for (const nested of result.iframes) {
                if (
                    nested === candidate.link ||
                    seenPlayers.has(nested)
                ) {
                    continue;
                }

                seenPlayers.add(nested);

                resolved.push({
                    server: `${candidate.server} Player`,
                    language: 'Default',
                    link: nested,
                    type: 'embed'
                });
            }
        }

        $(
            '.cyber-modal .links-list .link-row, ' +
            '.links-list .link-row'
        ).each((i, el) => {
            const a =
                $(el)
                    .find('a.download-btn, a')
                    .first();

            let link = a.attr('href');

            if (!link) return;

            try {
                link = new URL(link, base).href;
            } catch {
                return;
            }

            if (!/^https?:\/\//i.test(link)) return;

            downloadSources.push({
                server:
                    $(el)
                        .find('.server-name')
                        .text()
                        .trim() ||
                    $(el)
                        .find('.dl-name')
                        .text()
                        .trim() ||
                    `Mirror ${i + 1}`,
                link
            });
        });

        const uniqueStreams = [];
        const streamSeen = new Set();

        for (const item of resolved) {
            if (!item.link) continue;

            const link = String(item.link).trim();

            if (!link || streamSeen.has(link)) continue;

            streamSeen.add(link);

            uniqueStreams.push({
                ...item,
                link
            });
        }

        const uniqueDownloads = [];
        const downloadSeen = new Set();

        for (const item of downloadSources) {
            if (!item.link) continue;

            const link = String(item.link).trim();

            if (!link || downloadSeen.has(link)) continue;

            downloadSeen.add(link);

            uniqueDownloads.push({
                ...item,
                link
            });
        }

        console.log(
            `[TOONSTREAM STREAMS] ${title || epUrl} -> ` +
            `${uniqueStreams.length} streams, ` +
            `${uniqueDownloads.length} downloads`
        );

        res.json({
            title: title || null,
            poster_image: poster || null,
            thumbnail_image: backdrop || null,
            streams: uniqueStreams,
            downloads: uniqueDownloads,
            total_streams: uniqueStreams.length,
            source_base: base
        });
    } catch (err) {
        console.error(
            `[TOONSTREAM STREAMS ERROR] ${epUrl}:`,
            err.message
        );

        handleScraperError(
            res,
            err,
            "Failed to load streams from ToonStream"
        );
    }
});


/* =========================================
   RAREANIMES DOM EPISODE PLAYER GROUPING
   ========================================= */

const extractRareAnimesEpisodePlayers = ($) => {
    const links = [];

    $('a[href]').each((index, element) => {
        const href = String($(element).attr('href') || '').trim();
        const label = $(element).text().replace(/\s+/g, ' ').trim();

        if (!href || !label) return;

        let absolute;
        try {
            absolute = new URL(href, RAREANIMES_BASE).href;
        } catch {
            return;
        }

        let parsed;
        try {
            parsed = new URL(absolute);
        } catch {
            return;
        }

        if (
            parsed.hostname !== 'codedew.com' ||
            !parsed.pathname.startsWith('/zipper/')
        ) {
            return;
        }

        const serverMatch =
            label.match(/watch\s*multi\s*quality/i) ||
            label.match(/hubcloud/i) ||
            label.match(/watch\s*now/i) ||
            label.match(/dlbeta/i);

        if (!serverMatch) return;

        let server = 'Player';
        if (/watch\s*multi\s*quality/i.test(label)) server = 'Watch Quality';
        else if (/hubcloud/i.test(label)) server = 'HubCloud';
        else if (/watch\s*now/i.test(label)) server = 'WatchNow';
        else if (/dlbeta/i.test(label)) server = 'DLBeta';

        links.push({
            index,
            server,
            link: absolute
        });
    });

    if (!links.length) return [];

    const findEpisodeNumber = (element) => {
        let node = $(element);

        for (let depth = 0; depth < 8 && node.length; depth++) {
            const text = node.text().replace(/\s+/g, ' ').trim();

            const match =
                text.match(/(?:episode|ep)\s*[-#: ]?\s*(\d{1,4})/i) ||
                text.match(/(?:e)\s*(\d{1,4})(?:\b|$)/i);

            if (match) return Number(match[1]);

            node = node.parent();
        }

        return null;
    };

    const rawGroups = [];
    const used = new Set();

    $('a[href]').each((index, element) => {
        if (!links.some(item => item.index === index)) return;

        const epNum = findEpisodeNumber(element);
        if (epNum == null) return;

        const key = String(epNum);
        if (!rawGroups.some(group => group.epNum === epNum)) {
            rawGroups.push({
                epNum,
                title: `Episode ${epNum}`,
                streams: []
            });
        }

        const group = rawGroups.find(item => item.epNum === epNum);
        const link = links.find(item => item.index === index);

        if (link && !used.has(link.link)) {
            used.add(link.link);
            group.streams.push({
                server: link.server,
                language: 'Default',
                link: link.link,
                type: 'player',
                public: true
            });
        }
    });

    if (rawGroups.length) {
        return rawGroups.sort((a, b) => a.epNum - b.epNum);
    }

    // Current RareAnimes pages expose repeated public server-link sets.
    // When episode labels are not present in the DOM, preserve those public
    // links and group them in their observed four-server sets.
    const fallback = [];
    const chunkSize = 4;

    for (let i = 0; i < links.length; i += chunkSize) {
        const chunk = links.slice(i, i + chunkSize);

        fallback.push({
            epNum: Math.floor(i / chunkSize) + 1,
            title: `Episode ${Math.floor(i / chunkSize) + 1}`,
            streams: chunk.map(item => ({
                server: item.server,
                language: 'Default',
                link: item.link,
                type: 'player',
                public: true
            }))
        });
    }

    return fallback;
};

/* =========================================
   RAREANIMES SEARCH
   ========================================= */

app.get('/rareanimes/search', async (req, res) => {
    const query = req.query.q;

    if (!query) {
        return res.status(400).json({
            error: "Query 'q' is required"
        });
    }

    const results = await searchRareAnimes(query);

    res.json({
        source: "RareAnimes",
        results
    });
});

/* =========================================
   RAREANIMES EPISODES
   ========================================= */

app.get('/rareanimes/episodes', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({
            error: "URL is required"
        });
    }

    try {
        const page = await fetchRareAnimesPage(rawUrl);
        const $ = cheerio.load(page.data);

        const grouped = extractRareAnimesEpisodePlayers($);

        const episodes = grouped.map(item => ({
            epNum: item.epNum,
            title: item.title || `Episode ${item.epNum}`,
            link: rawUrl,
            streams: item.streams
        }));

        res.json({
            source: "RareAnimes",
            seasons: [],
            episodes,
            mapped_episodes: episodes.length,
            source_base: RAREANIMES_BASE,
            mapping: episodes.length
                ? "dom_episode_labels"
                : "unmapped"
        });
    } catch (err) {
        handleScraperError(
            res,
            err,
            "Failed to load episodes from RareAnimes"
        );
    }
});;

/* =========================================
   RAREANIMES DEBUG
   ========================================= */

app.get('/rareanimes/debug', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({
            error: "URL is required"
        });
    }

    try {
        const page = await fetchRareAnimesPage(rawUrl);
        const html = String(page.data || "");
        const markerIndex = html.indexOf("const relatedData");
        const seaMatches = html.match(/"SEA_\d+"/g) || [];
        const iframeMatches = html.match(/https?:\/\/[^"\'\s<>]+/g) || [];

        res.json({
            success: true,
            requested_url: rawUrl,
            final_url: page.url,
            html_length: html.length,
            relatedData_found: markerIndex !== -1,
            relatedData_position: markerIndex,
            season_key_count: new Set(seaMatches).size,
            season_keys_sample: [...new Set(seaMatches)].slice(0, 20),
            iframe_urls_sample: iframeMatches
                .filter(url => /argon|embed/i.test(url))
                .slice(0, 10)
        });
    } catch (err) {
        handleScraperError(
            res,
            err,
            "RareAnimes debug failed"
        );
    }
});


/* =========================================
   RAREANIMES CONTENT DEBUG
   ========================================= */

app.get('/rareanimes/debug-content', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({
            error: "URL is required"
        });
    }

    try {
        const page = await fetchRareAnimesPage(rawUrl);
        const html = String(page.data || "");

        const keywords = [
            "SEA_",
            "episode",
            "Episode",
            "iframe",
            "argon",
            "razorshell",
            "Homecoming",
            "relatedData",
            "openRelatedModal",
            "videoPlayer"
        ];

        const matches = {};

        for (const keyword of keywords) {
            const index = html.indexOf(keyword);

            matches[keyword] = {
                found: index !== -1,
                position: index,
                snippet:
                    index !== -1
                        ? html.slice(
                              Math.max(0, index - 500),
                              Math.min(html.length, index + 1500)
                          )
                        : null
            };
        }

        res.json({
            success: true,
            final_url: page.url,
            html_length: html.length,
            matches
        });
    } catch (err) {
        handleScraperError(
            res,
            err,
            "RareAnimes content debug failed"
        );
    }
});

/* =========================================
   RAREANIMES LINK DEBUG
   ========================================= */

app.get('/rareanimes/debug-links', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({ error: "URL is required" });
    }

    try {
        const page = await fetchRareAnimesPage(rawUrl);
        const html = String(page.data || "");
        const $ = cheerio.load(html);

        const hrefs = [];
        const onclicks = [];
        const scripts = [];

        $('a[href]').each((i, el) => {
            const href = $(el).attr('href') || '';
            const text = $(el).text().replace(/\s+/g, ' ').trim();

            if (
                /[?&]url=/i.test(href) ||
                /episode|ep\b|watch|play/i.test(text) ||
                /[?&]url=/i.test($(el).attr('onclick') || '')
            ) {
                hrefs.push({
                    text: text.slice(0, 160),
                    href: href.slice(0, 500),
                    onclick: ($(el).attr('onclick') || '').slice(0, 700)
                });
            }
        });

        $('[onclick]').each((i, el) => {
            const onclick = $(el).attr('onclick') || '';
            if (/url=|episode|ep\b|watch|play/i.test(onclick)) {
                onclicks.push(onclick.slice(0, 1000));
            }
        });

        $('script').each((i, el) => {
            const text = $(el).html() || '';
            if (/url=|episode|SEA_|watch|play/i.test(text)) {
                scripts.push(text.slice(0, 3000));
            }
        });

        res.json({
            success: true,
            final_url: page.url,
            html_length: html.length,
            href_matches: hrefs.slice(0, 100),
            onclick_matches: [...new Set(onclicks)].slice(0, 50),
            script_matches: scripts.slice(0, 20)
        });
    } catch (err) {
        handleScraperError(res, err, "RareAnimes link debug failed");
    }
});


app.get('/rareanimes/episode-structure', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({ error: "URL is required" });
    }

    try {
        const page = await fetchRareAnimesPage(rawUrl);
        const $ = cheerio.load(page.data);
        const items = [];

        $('a[href]').each((index, element) => {
            const label = $(element).text().replace(/\s+/g, ' ').trim();
            const href = String($(element).attr('href') || '');

            if (
                !/watchmultiquality|hubcloud|watchnow|dlbeta/i.test(label) ||
                !/^https?:\/\/codedew\.com\/zipper\//i.test(
                    new URL(href, page.url || RAREANIMES_BASE).href
                )
            ) {
                return;
            }

            const ancestors = [];
            let node = $(element);

            for (let depth = 0; depth < 8 && node.length; depth++) {
                const el = node[0];
                const tag = String(el.name || '').toLowerCase();
                const id = String(node.attr('id') || '');
                const cls = String(node.attr('class') || '');
                const text = node.text().replace(/\s+/g, ' ').trim();

                ancestors.push({
                    depth,
                    tag,
                    id,
                    class: cls.slice(0, 200),
                    text: text.slice(0, 500),
                    player_count: node.find('a[href]').filter((i, child) =>
                        /watchmultiquality|hubcloud|watchnow|dlbeta/i.test(
                            $(child).text().replace(/\s+/g, ' ').trim()
                        )
                    ).length
                });

                node = node.parent();
            }

            items.push({
                index,
                label,
                href: href.slice(0, 500),
                ancestors
            });
        });

        res.json({
            success: true,
            final_url: page.url,
            player_count: items.length,
            items: items.slice(0, 40)
        });
    } catch (err) {
        handleScraperError(res, err, "RareAnimes episode structure debug failed");
    }
});


app.get('/rareanimes/player-groups', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({ error: "URL is required" });
    }

    try {
        const page = await fetchRareAnimesPage(rawUrl);
        const $ = cheerio.load(page.data);
        const groups = [];
        const seen = new Set();

        $('p').each((index, element) => {
            const links = [];

            $(element).find('a[href]').each((_, child) => {
                const label = $(child).text().replace(/\s+/g, ' ').trim();
                let href = String($(child).attr('href') || '');

                if (!/watchmultiquality|hubcloud|watchnow|dlbeta/i.test(label)) return;

                try {
                    href = new URL(href, page.url || RAREANIMES_BASE).href;
                } catch {
                    return;
                }

                if (!/^https?:\/\/codedew\.com\/zipper\//i.test(href)) return;

                links.push({
                    server: /watchmultiquality/i.test(label)
                        ? 'Watch Quality'
                        : label,
                    link: href
                });
            });

            if (!links.length) return;

            const parent = $(element).parent();
            const previous = [];
            let sibling = $(element).prev();

            for (let i = 0; i < 5 && sibling.length; i++) {
                const text = sibling.text().replace(/\s+/g, ' ').trim();
                if (text) previous.push(text.slice(0, 500));
                sibling = sibling.prev();
            }

            const text = $(element).text().replace(/\s+/g, ' ').trim();

            const key = links.map(x => x.link).join('|');
            if (seen.has(key)) return;
            seen.add(key);

            groups.push({
                index,
                label: text,
                link_count: links.length,
                links,
                previous_siblings: previous,
                parent_tag: String(parent[0]?.name || ''),
                parent_class: String(parent.attr('class') || '').slice(0, 200),
                parent_text: parent.text().replace(/\s+/g, ' ').trim().slice(0, 800)
            });
        });

        res.json({
            success: true,
            final_url: page.url,
            group_count: groups.length,
            total_player_links: groups.reduce((n, g) => n + g.link_count, 0),
            groups
        });
    } catch (err) {
        handleScraperError(res, err, "RareAnimes player group debug failed");
    }
});


app.get('/rareanimes/streams', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({
            error: "URL is required"
        });
    }

    try {
        const page = await fetchRareAnimesPage(rawUrl);
        const $ = cheerio.load(page.data);

        const title =
            $('h1').first().text().replace(/\s+/g, ' ').trim() || null;

        const streams = [];
        const seen = new Set();

        $('a[href]').each((index, element) => {
            let href = $(element).attr('href');
            const label = $(element).text().replace(/\s+/g, ' ').trim();

            if (!href || !label) return;

            const normalized = label.toLowerCase();
            const isKnownPlayer =
                normalized.includes('watchmultiquality') ||
                normalized === 'hubcloud' ||
                normalized === 'watchnow' ||
                normalized === 'dlbeta';

            if (!isKnownPlayer) return;

            try {
                href = new URL(href, page.url || RAREANIMES_BASE).href;
            } catch {
                return;
            }

            if (!/^https?:\/\//i.test(href) || seen.has(href)) return;

            seen.add(href);

            streams.push({
                server: normalized.includes('watchmultiquality')
                    ? 'Watch Quality'
                    : label,
                language: 'Default',
                link: href,
                type: 'player',
                public: true
            });
        });

        $('iframe').each((index, element) => {
            let src =
                $(element).attr('src') ||
                $(element).attr('data-src') ||
                $(element).attr('data-lazy-src');

            if (!src || src === 'about:blank') return;

            try {
                src = new URL(src, page.url || RAREANIMES_BASE).href;
            } catch {
                return;
            }

            const parsed = new URL(src);

            if (
                parsed.hostname === 'www.rareanimes.mov' ||
                parsed.hostname === 'rareanimes.mov' ||
                parsed.hostname === 'wsrv.nl' ||
                parsed.hostname === 'www.google.com'
            ) {
                return;
            }

            if (seen.has(src)) return;

            seen.add(src);

            streams.push({
                server:
                    parsed.hostname === 'argon.razorshell.space' &&
                    parsed.pathname.startsWith('/embed/')
                        ? 'Argon'
                        : 'Player ' + String(streams.length + 1),
                language: 'Default',
                link: src,
                type: 'embed',
                public: true
            });
        });

        res.json({
            source: 'RareAnimes',
            title,
            streams,
            total_streams: streams.length,
            source_base: RAREANIMES_BASE
        });
    } catch (err) {
        handleScraperError(
            res,
            err,
            'Failed to load streams from RareAnimes'
        );
    }
});

// ==========================================
// TMDB EPISODE THUMBNAIL
// ==========================================

app.get('/tmdb/episode-thumbnail', async (req, res) => {
    const {
        title,
        season,
        episode
    } = req.query;

    if (
        !title ||
        !season ||
        !episode
    ) {
        return res.status(400).json({
            error:
                "Query parameters 'title', 'season', and 'episode' are required."
        });
    }

    try {
        const searchUrl =
            `https://api.themoviedb.org/3/search/tv` +
            `?api_key=${TMDB_API_KEY}` +
            `&query=${encodeURIComponent(title)}`;

        const searchRes =
            await axios.get(searchUrl);

        const tvShow =
            searchRes.data.results[0];

        if (!tvShow) {
            return res.status(404).json({
                error:
                    `No show found on TMDB matching '${title}'`
            });
        }

        const tvId =
            tvShow.id;

        const epUrl =
            `https://api.themoviedb.org/3/tv/` +
            `${tvId}/season/${season}/episode/${episode}` +
            `?api_key=${TMDB_API_KEY}`;

        const epRes =
            await axios.get(epUrl);

        const epData =
            epRes.data;

        if (
            epData &&
            epData.still_path
        ) {
            res.json({
                found: true,
                tv_id:
                    tvId,
                show_title:
                    tvShow.name,
                episode_name:
                    epData.name ||
                    `Episode ${episode}`,
                overview:
                    epData.overview || "",
                air_date:
                    epData.air_date ||
                    null,
                thumbnails: {
                    w500:
                        `https://image.tmdb.org/t/p/w500` +
                        `${epData.still_path}`,
                    w780:
                        `https://image.tmdb.org/t/p/w780` +
                        `${epData.still_path}`,
                    original:
                        `https://image.tmdb.org/t/p/original` +
                        `${epData.still_path}`
                }
            });
        } else {
            res.status(404).json({
                error:
                    "Episode found on TMDB, but no screenshot (still_path) exists for it."
            });
        }

    } catch (err) {
        handleScraperError(
            res,
            err,
            "Failed to query TMDB API"
        );
    }
});

// ==========================================
// START SERVER
// ==========================================

app.listen(
    PORT,
    '0.0.0.0',
    () => {
        console.log(
            `Server listening on port ${PORT}`
        );
    }
);

module.exports = app;

                  
                          
     
