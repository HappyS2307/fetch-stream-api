const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Target Domain Configurations
const ANIMESALT_BASE = "https://animesalt.ac";
const TOONSTREAM_BASE = "https://toonstream.vip";
const DRAMAWORLD_BASE = "https://dramaworld.site";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "ed9311c3613b06f414be99abaec5dd86";

// Global Request Headers Generator
const getHeaders = (refererUrl) => ({
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': refererUrl || 'https://google.com'
});

// Clean URL Sanitizer
const fixUrl = (url) => {
    if (!url) return url;
    let cleanUrl = url.trim();

    if (!cleanUrl.endsWith('/') && !cleanUrl.includes('?')) {
        cleanUrl += '/';
    }
    return cleanUrl;
};

// Helper to handle scraper errors
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

// Helper to determine if link is movie or series
const detectType = (link, classText) => {
    if (link && link.includes('/movies/')) return 'movie';
    if (classText && classText.includes('type-movies')) return 'movie';
    return 'series';
};

// ==========================================
// 1. EXTRACTOR HELPER LOGICS
// ==========================================

const searchAnimeSalt = async (query) => {
    try {
        const { data } = await axios.get(
            `${ANIMESALT_BASE}/?s=${encodeURIComponent(query)}`,
            {
                headers: getHeaders(ANIMESALT_BASE),
                maxRedirects: 5
            }
        );

        const $ = cheerio.load(data);
        const results = [];

        $('ul.post-lst li').each((index, element) => {
            const classText = $(element).attr('class') || '';
            const title = $(element).find('h2.entry-title').text().trim();

            let link = $(element).find('a.lnk-blk').attr('href');

            let image =
                $(element).find('img').attr('data-src') ||
                $(element).find('img').attr('src');

            if (image && image.startsWith('//')) {
                image = 'https:' + image;
            }

            if (link) {
                if (!link.startsWith('http')) {
                    link = `${ANIMESALT_BASE}${link}`;
                }

                link = fixUrl(link);
            }

            const type = detectType(link, classText);

            if (title && link) {
                results.push({
                    title,
                    link,
                    image,
                    type,
                    source: 'AnimeSalt'
                });
            }
        });

        return results;

    } catch {
        return [];
    }
};

const searchToonStream = async (query) => {
    const searchUrls = [
        `${TOONSTREAM_BASE}/s?q=${encodeURIComponent(query)}`,
        `${TOONSTREAM_BASE}/?s=${encodeURIComponent(query)}`,
        `${TOONSTREAM_BASE}/search/?s=${encodeURIComponent(query)}`
    ];

    for (const searchUrl of searchUrls) {
        try {
            const { data } = await axios.get(searchUrl, {
                headers: getHeaders(TOONSTREAM_BASE),
                maxRedirects: 5,
                timeout: 12000
            });

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

                if (!link.startsWith('http')) {
                    link =
                        `${TOONSTREAM_BASE}` +
                        `${link.startsWith('/') ? '' : '/'}` +
                        link;
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
                }

                if (image && image.startsWith('/')) {
                    image = `${TOONSTREAM_BASE}${image}`;
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

                    if (!link.startsWith('http')) {
                        link =
                            `${TOONSTREAM_BASE}` +
                            `${link.startsWith('/') ? '' : '/'}` +
                            link;
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
                        title =
                            parent
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
                    }

                    if (image && image.startsWith('/')) {
                        image = `${TOONSTREAM_BASE}${image}`;
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
                `ToonStream search failed for ${searchUrl}:`,
                err.message
            );
        }
    }

    return [];
};

const searchDramaWorld = async (query) => {
    try {
        const { data } = await axios.get(
            `${DRAMAWORLD_BASE}/?s=${encodeURIComponent(query)}`,
            {
                headers: getHeaders(DRAMAWORLD_BASE),
                maxRedirects: 5,
                timeout: 10000
            }
        );

        const $ = cheerio.load(data);
        const results = [];
        const seen = new Set();

        $('a[href]').each((i, el) => {
            let link = $(el).attr('href');

            const title =
                $(el)
                    .find('h1,h2,h3,h4,h5,h6,.title,.entry-title')
                    .first()
                    .text()
                    .trim()
                || $(el).attr('title')
                || $(el).text().trim();

            if (!link || !title) return;

            if (!link.startsWith('http')) {
                link =
                    `${DRAMAWORLD_BASE}` +
                    `${link.startsWith('/') ? '' : '/'}` +
                    link;
            }

            if (
                !link.startsWith(DRAMAWORLD_BASE) ||
                !link.includes('/watch/')
            ) {
                return;
            }

            link = fixUrl(link);
            if (seen.has(link)) return;

            seen.add(link);

            let image =
                $(el).find('img').attr('data-src') ||
                $(el).find('img').attr('src') ||
                null;

            if (image && image.startsWith('//')) {
                image = `https:${image}`;
            }

            if (image && image.startsWith('/')) {
                image = `${DRAMAWORLD_BASE}${image}`;
            }

            results.push({
                title,
                link,
                image,
                type: 'series',
                source: 'DramaWorld'
            });
        });

        return results.slice(0, 20);

    } catch {
        return [];
    }
};

const getDramaWorldEpisodes = async (rawUrl) => {
    const pageUrl = fixUrl(rawUrl);

    const { data } = await axios.get(pageUrl, {
        headers: getHeaders(DRAMAWORLD_BASE),
        maxRedirects: 5,
        timeout: 10000
    });

    const $ = cheerio.load(data);
    const episodes = [];
    const seen = new Set();

    $('a[href*="/watch/"]').each((i, el) => {
        let link = $(el).attr('href');
        if (!link) return;

        if (!link.startsWith('http')) {
            link =
                `${DRAMAWORLD_BASE}` +
                `${link.startsWith('/') ? '' : '/'}` +
                link;
        }

        link = fixUrl(link);
        if (seen.has(link)) return;

        const text = $(el).text().trim();
        const match =
            link.match(/episode[-_ ]?(\d+)/i) ||
            text.match(/episode\s*(\d+)/i);

        if (!match) return;

        seen.add(link);
        const epNum = match[1];

        episodes.push({
            epNum,
            title: text || `Episode ${epNum}`,
            link,
            image:
                $(el).find('img').attr('data-src') ||
                $(el).find('img').attr('src') ||
                null
        });
    });

    if (!episodes.length) {
        const match = pageUrl.match(/episode[-_ ]?(\d+)/i);
        if (match) {
            episodes.push({
                epNum: match[1],
                title:
                    $('h1,h2,.entry-title')
                        .first()
                        .text()
                        .trim()
                    || `Episode ${match[1]}`,
                link: pageUrl,
                image: null
            });
        }
    }

    episodes.sort(
        (a, b) => Number(a.epNum) - Number(b.epNum)
    );

    return episodes;
};

const getDramaWorldStreams = async (rawUrl) => {
    const epUrl = fixUrl(rawUrl);

    const { data } = await axios.get(epUrl, {
        headers: getHeaders(DRAMAWORLD_BASE),
        maxRedirects: 5,
        timeout: 10000
    });

    const $ = cheerio.load(data);
    const streams = [];
    const downloads = [];
    const seen = new Set();

    const title =
        $('h1,h2,.entry-title')
            .first()
            .text()
            .trim()
        || null;

    let poster =
        $('.post-thumbnail img').attr('src') ||
        $('.post-thumbnail img').attr('data-src') ||
        null;

    let backdrop =
        $('.bghd img').attr('src') ||
        $('.bghd img').attr('data-src') ||
        null;

    if (poster && poster.startsWith('//')) {
        poster = `https:${poster}`;
    }

    if (backdrop && backdrop.startsWith('//')) {
        backdrop = `https:${backdrop}`;
    }

    if (poster && poster.startsWith('/')) {
        poster = `${DRAMAWORLD_BASE}${poster}`;
    }

    if (backdrop && backdrop.startsWith('/')) {
        backdrop = `${DRAMAWORLD_BASE}${backdrop}`;
    }

    $('iframe').each((i, el) => {
        let src =
            $(el).attr('src') ||
            $(el).attr('data-src');

        if (!src || src === 'about:blank') return;

        if (src.startsWith('/')) {
            src = `${DRAMAWORLD_BASE}${src}`;
        }

        if (
            !/^https?:\/\//i.test(src) ||
            seen.has(src)
        ) {
            return;
        }

        seen.add(src);

        streams.push({
            server: 'DramaWorld Online Watch',
            language: 'Default',
            link: src,
            type: 'embed'
        });
    });

    $('a.download-link-btn[href], a[href*="/stream/download/"]')
        .each((i, el) => {
            let link = $(el).attr('href');
            if (!link) return;

            if (link.startsWith('/')) {
                link = `${DRAMAWORLD_BASE}${link}`;
            }

            if (!/^https?:\/\//i.test(link)) return;

            const quality =
                $(el)
                    .find('.dl-quality')
                    .text()
                    .trim()
                || null;

            const server =
                $(el)
                    .find('.dl-name')
                    .text()
                    .trim()
                || 'Download';

            downloads.push({
                server,
                quality,
                link
            });
        });

    return {
        title,
        poster_image: poster,
        thumbnail_image: backdrop,
        streams,
        downloads
    };
};

const resolveEmbedUrl = async (embedUrl) => {
    try {
        const { data } = await axios.get(embedUrl, {
            headers: getHeaders(TOONSTREAM_BASE),
            timeout: 3000,
            maxRedirects: 5
        });

        const $ = cheerio.load(data);

        const nestedIframe =
            $('iframe').attr('src') ||
            $('iframe').attr('data-src');

        if (nestedIframe) {
            return nestedIframe;
        }

        let directVideoUrl = null;

        $('script').each((i, el) => {
            const scriptContent = $(el).html();

            if (scriptContent) {
                const m3u8Match =
                    scriptContent.match(
                        /(https?:\/\/[^\s"'`]+\.m3u8[^\s"'`]*)/i
                    );

                const mp4Match =
                    scriptContent.match(
                        /(https?:\/\/[^\s"'`]+\.mp4[^\s"'`]*)/i
                    );

                if (m3u8Match) {
                    directVideoUrl = m3u8Match[1].replace(/\\/g, '');
                } else if (mp4Match) {
                    directVideoUrl = mp4Match[1].replace(/\\/g, '');
                }
            }
        });

        return directVideoUrl || embedUrl;

    } catch (err) {
        return embedUrl;
    }
};

// ==========================================
// 2. EXPRESS ROUTES / ENDPOINTS
// ==========================================

// HOME STATUS ENDPOINT
app.get('/', (req, res) => {
    res.json({
        status: "Active",
        message: "FetchStream Scraper API is running.",
        sources: [
            "AnimeSalt",
            "ToonStream",
            "DramaWorld"
        ]
    });
});

// A. COMBINED SEARCH
app.get('/search', async (req, res) => {
    const query = req.query.q;

    if (!query) {
        return res.status(400).json({
            error: "Query parameter 'q' is required"
        });
    }

    const [
        saltResults,
        toonResults,
        dramaResults
    ] = await Promise.all([
        searchAnimeSalt(query),
        searchToonStream(query),
        searchDramaWorld(query)
    ]);

    res.json({
        query,
        total:
            saltResults.length +
            toonResults.length +
            dramaResults.length,
        results: [
            ...saltResults,
            ...toonResults,
            ...dramaResults
        ]
    });
});

// B. DEDICATED ANIME SALT ENDPOINTS
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

app.get('/animesalt/episodes', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({
            error: "URL is required"
        });
    }

    const pageUrl = fixUrl(rawUrl);

    try {
        const { data } = await axios.get(pageUrl, {
            headers: getHeaders(ANIMESALT_BASE),
            maxRedirects: 5
        });

        const $ = cheerio.load(data);
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
                if (!link.startsWith('http')) {
                    link = `${ANIMESALT_BASE}${link}`;
                }
                link = fixUrl(link);
            }

            let image =
                $(element).find('img').attr('data-src') ||
                $(element).find('img').attr('src');

            if (image && image.startsWith('//')) {
                image = 'https:' + image;
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
            episodes
        });

    } catch (err) {
        handleScraperError(
            res,
            err,
            "Failed to load episodes from AnimeSalt"
        );
    }
});

app.get('/animesalt/streams', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({
            error: "URL is required"
        });
    }

    const epUrl = fixUrl(rawUrl);

    try {
        const { data } = await axios.get(epUrl, {
            headers: getHeaders(ANIMESALT_BASE),
            maxRedirects: 5
        });

        const $ = cheerio.load(data);
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

        if (poster && poster.startsWith('//')) {
            poster = `https:${poster}`;
        }

        if (backdrop && backdrop.startsWith('//')) {
            backdrop = `https:${backdrop}`;
        }

        $('#aa-options iframe').each((index, element) => {
            const src =
                $(element).attr('src') ||
                $(element).attr('data-src');

            if (!src) return;

            if (src.includes('?data=')) {
                try {
                    const urlObj = new URL(src);
                    const base64Data = urlObj.searchParams.get('data');

                    if (base64Data) {
                        const decodedJson =
                            Buffer
                                .from(base64Data, 'base64')
                                .toString('utf-8');

                        const parsedStreams = JSON.parse(decodedJson);

                        parsedStreams.forEach(stream => {
                            streamSources.push({
                                server: 'Abyss (Multi-Lang)',
                                language: stream.language,
                                link: stream.link
                            });
                        });
                    }
                } catch {}
            } else {
                let serverName = 'Server';

                if (src.includes('as-cdn')) {
                    serverName = 'playX';
                }

                streamSources.push({
                    server: serverName,
                    language: 'Default',
                    link: src
                });
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

                if (link) {
                    if (link.startsWith('/')) {
                        link = `${ANIMESALT_BASE}${link}`;
                    }

                    downloadSources.push({
                        server: server || 'Download',
                        language: lang || 'Default',
                        quality: quality || 'HD',
                        link: fixUrl(link)
                    });
                }
            });

        res.json({
            title: title || null,
            poster_image: poster || null,
            thumbnail_image: backdrop || null,
            streams: streamSources,
            downloads: downloadSources
        });

    } catch (err) {
        handleScraperError(
            res,
            err,
            "Failed to load streams from AnimeSalt"
        );
    }
});

// C. DEDICATED TOON STREAM ENDPOINTS
app.get('/toonstream/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Query 'q' is required" });

    const results = await searchToonStream(query);
    res.json({ source: "ToonStream", results });
});

app.get('/toonstream/episodes', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: "URL is required" });

    const pageUrl = fixUrl(rawUrl);

    try {
        const { data } = await axios.get(pageUrl, {
            headers: getHeaders(TOONSTREAM_BASE),
            maxRedirects: 5
        });

        const $ = cheerio.load(data);
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
            const epNum = $(element).find('.num-epi').text().trim();
            const title = $(element).find('h5.entry-title1').text().trim();

            let link = $(element).find('a.lnk-blk').attr('href');

            if (link) {
                if (!link.startsWith('http')) {
                    link = `${TOONSTREAM_BASE}${link.startsWith('/') ? '' : '/'}${link}`;
                }
                link = fixUrl(link);
            }

            let image =
                $(element).find('img').attr('data-src') ||
                $(element).find('img').attr('src');

            if (image && image.startsWith('//')) {
                image = 'https:' + image;
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
            episodes
        });

    } catch (err) {
        handleScraperError(
            res,
            err,
            "Failed to load episodes from ToonStream"
        );
    }
});

app.get('/toonstream/streams', async (req, res) => {
    const rawUrl = req.query.url;
    if (!rawUrl) return res.status(400).json({ error: "URL is required" });

    const epUrl = fixUrl(rawUrl);

    try {
        const { data } = await axios.get(epUrl, {
            headers: getHeaders(TOONSTREAM_BASE),
            maxRedirects: 5
        });

        const $ = cheerio.load(data);
        const rawStreams = [];
        const downloadSources = [];

        const title = $('h1.entry-title').text().trim();

        let poster =
            $('.post-thumbnail img').attr('src') ||
            $('.post-thumbnail img').attr('data-src');

        let backdrop =
            $('.bghd img.TPostBg').attr('src') ||
            $('.bghd img').attr('src') ||
            $('.bghd img').attr('data-src');

        if (poster && poster.startsWith('/')) {
            poster = `${TOONSTREAM_BASE}${poster}`;
        }

        if (backdrop && backdrop.startsWith('/')) {
            backdrop = `${TOONSTREAM_BASE}${backdrop}`;
        }

        if (backdrop && backdrop.startsWith('//')) {
            backdrop = `https:${backdrop}`;
        }

        if (poster && poster.startsWith('//')) {
            poster = `https:${poster}`;
        }

        const serverMap = {};

        $('.video-options .aa-tbs-video li').each((i, el) => {
            const optionId = $(el).find('a.btn').attr('href');
            const serverName =
                $(el).find('.server').text().trim() ||
                `Server ${i + 1}`;

            if (optionId) {
                serverMap[optionId.replace('#', '')] = serverName;
            }
        });

        $('.video-player .video').each((i, el) => {
            const id = $(el).attr('id');

            let src =
                $(el).find('iframe').attr('src') ||
                $(el).find('iframe').attr('data-src');

            if (!src || src === 'about:blank') return;

            if (src.startsWith('/')) {
                src = `${TOONSTREAM_BASE}${src}`;
            }

            const serverName = serverMap[id] || `Server ${i + 1}`;

            rawStreams.push({
                serverName,
                link: src
            });
        });

        const resolvedStreams = await Promise.all(
            rawStreams.map(async (stream) => {
                if (stream.link.includes('/embed/')) {
                    const bypassedLink = await resolveEmbedUrl(stream.link);

                    return {
                        server: stream.serverName,
                        link: bypassedLink,
                        is_bypassed: bypassedLink !== stream.link
                    };
                }

                return {
                    server: stream.serverName,
                    link: stream.link,
                    is_bypassed: false
                };
            })
        );

        $('.cyber-modal .links-list .link-row').each((i, el) => {
            const serverName = $(el).find('.server-name').text().trim();
            const downloadLink = $(el).find('a.download-btn').attr('href');

            if (downloadLink) {
                downloadSources.push({
                    server: serverName || `Mirror ${i + 1}`,
                    link: downloadLink
                });
            }
        });

        res.json({
            title: title || null,
            poster_image: poster || null,
            thumbnail_image: backdrop || null,
            streams: resolvedStreams,
            downloads: downloadSources
        });

    } catch (err) {
        handleScraperError(
            res,
            err,
            "Failed to load streams from ToonStream"
        );
    }
});
// D. DRAMAWORLD ENDPOINTS
app.get('/dramaworld/search', async (req, res) => {
    const query = req.query.q;

    if (!query) {
        return res.status(400).json({
            error: "Query 'q' is required"
        });
    }

    const results = await searchDramaWorld(query);

    res.json({
        source: "DramaWorld",
        results
    });
});

app.get('/dramaworld/episodes', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({
            error: "URL is required"
        });
    }

    try {
        const episodes = await getDramaWorldEpisodes(rawUrl);

        res.json({
            source: "DramaWorld",
            episodes
        });

    } catch (err) {
        handleScraperError(
            res,
            err,
            "Failed to load episodes from DramaWorld"
        );
    }
});

app.get('/dramaworld/streams', async (req, res) => {
    const rawUrl = req.query.url;

    if (!rawUrl) {
        return res.status(400).json({
            error: "URL is required"
        });
    }

    try {
        const result = await getDramaWorldStreams(rawUrl);
        res.json(result);

    } catch (err) {
        handleScraperError(
            res,
            err,
            "Failed to load streams from DramaWorld"
        );
    }
});

// E. TMDb OFFICIAL METADATA & EPISODE THUMBNAIL SERVICE
app.get('/tmdb/episode-thumbnail', async (req, res) => {
    const { title, season, episode } = req.query;

    if (!title || !season || !episode) {
        return res.status(400).json({
            error: "Query parameters 'title', 'season', and 'episode' are required."
        });
    }

    try {
        const searchUrl =
            `https://api.themoviedb.org/3/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(title)}`;

        const searchRes = await axios.get(searchUrl);
        const tvShow = searchRes.data.results[0];

        if (!tvShow) {
            return res.status(404).json({
                error: `No show found on TMDB matching '${title}'`
            });
        }

        const tvId = tvShow.id;

        const epUrl =
            `https://api.themoviedb.org/3/tv/${tvId}/season/${season}/episode/${episode}?api_key=${TMDB_API_KEY}`;

        const epRes = await axios.get(epUrl);
        const epData = epRes.data;

        if (epData && epData.still_path) {
            res.json({
                found: true,
                tv_id: tvId,
                show_title: tvShow.name,
                episode_name: epData.name || `Episode ${episode}`,
                overview: epData.overview || "",
                air_date: epData.air_date || null,
                thumbnails: {
                    w500: `https://image.tmdb.org/t/p/w500${epData.still_path}`,
                    w780: `https://image.tmdb.org/t/p/w780${epData.still_path}`,
                    original: `https://image.tmdb.org/t/p/original${epData.still_path}`
                }
            });
        } else {
            res.status(404).json({
                error: "Episode found on TMDB, but no screenshot (still_path) exists for it."
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

// Listen Port
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
});

module.exports = app;

            
