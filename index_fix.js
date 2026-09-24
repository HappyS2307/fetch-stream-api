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
            "ToonStream"
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

    const [saltResults, toonResults] = await Promise.all([
        searchAnimeSalt(query),
        searchToonStream(query)
    ]);

    res.json({
        query,
        total: saltResults.length + toonResults.length,
        results: [
            ...saltResults,
            ...toonResults
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

                  
                          
     
