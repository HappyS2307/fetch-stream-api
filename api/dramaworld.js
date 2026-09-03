const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const dramaworld = require('./dramaworld');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// ==========================================
// TARGET DOMAINS
// ==========================================

const ANIMESALT_BASE = "https://animesalt.ac";
const TOONSTREAM_BASE = "https://toon-stream.site";
const DRAMAWORLD_BASE = "https://dramaworld.site";

const TMDB_API_KEY =
    process.env.TMDB_API_KEY ||
    "ed9311c3613b06f414be99abaec5dd86";

// ==========================================
// GLOBAL REQUEST HEADERS
// ==========================================

const getHeaders = (refererUrl) => ({
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/124.0.0.0 Safari/537.36',

    'Accept':
        'text/html,application/xhtml+xml,application/xml;q=0.9,' +
        'image/avif,image/webp,*/*;q=0.8',

    'Accept-Language':
        'en-US,en;q=0.9',

    'Referer':
        refererUrl || 'https://google.com'
});

// ==========================================
// URL SANITIZER
// ==========================================

const fixUrl = (url) => {
    if (!url) return url;

    let cleanUrl = url.trim();

    if (
        !cleanUrl.endsWith('/') &&
        !cleanUrl.includes('?')
    ) {
        cleanUrl += '/';
    }

    return cleanUrl;
};

// ==========================================
// ERROR HANDLER
// ==========================================

const handleScraperError = (
    res,
    err,
    contextMessage
) => {

    const statusCode =
        err.response
            ? err.response.status
            : 500;

    let message =
        contextMessage;

    if (statusCode === 404) {
        message =
            "Target resource or page not found";
    }

    if (statusCode === 403) {
        message =
            "Access blocked by target server (Cloudflare / WAF)";
    }

    return res
        .status(statusCode)
        .json({
            error: message,
            upstream_status: statusCode,
            details: err.message
        });
};

// ==========================================
// TYPE DETECTOR
// ==========================================

const detectType = (
    link,
    classText
) => {

    if (
        link &&
        link.includes('/movies/')
    ) {
        return 'movie';
    }

    if (
        classText &&
        classText.includes('type-movies')
    ) {
        return 'movie';
    }

    return 'series';
};

// ==========================================
// ANIMESALT SEARCH
// ==========================================

const searchAnimeSalt = async (query) => {

    try {

        const { data } =
            await axios.get(
                `${ANIMESALT_BASE}/?s=${encodeURIComponent(query)}`,
                {
                    headers:
                        getHeaders(ANIMESALT_BASE),
                    maxRedirects: 5
                }
            );

        const $ =
            cheerio.load(data);

        const results = [];

        $('ul.post-lst li').each(
            (index, element) => {

                const classText =
                    $(element)
                        .attr('class') || '';

                const title =
                    $(element)
                        .find('h2.entry-title')
                        .text()
                        .trim();

                let link =
                    $(element)
                        .find('a.lnk-blk')
                        .attr('href');

                let image =
                    $(element)
                        .find('img')
                        .attr('data-src') ||
                    $(element)
                        .find('img')
                        .attr('src');

                if (
                    image &&
                    image.startsWith('//')
                ) {
                    image =
                        'https:' + image;
                }

                if (link) {

                    if (
                        !link.startsWith('http')
                    ) {
                        link =
                            `${ANIMESALT_BASE}${link}`;
                    }

                    link =
                        fixUrl(link);
                }

                const type =
                    detectType(
                        link,
                        classText
                    );

                if (title && link) {

                    results.push({
                        title,
                        link,
                        image,
                        type,
                        source: 'AnimeSalt'
                    });
                }
            }
        );

        return results;

    } catch {

        return [];
    }
};

// ==========================================
// TOONSTREAM SEARCH
// ==========================================

const searchToonStream = async (query) => {

    try {

        const { data } =
            await axios.get(
                `${TOONSTREAM_BASE}/s?q=${encodeURIComponent(query)}`,
                {
                    headers:
                        getHeaders(TOONSTREAM_BASE),
                    maxRedirects: 5
                }
            );

        const $ =
            cheerio.load(data);

        const results = [];

        $('ul.post-lst li').each(
            (index, element) => {

                const classText =
                    $(element)
                        .attr('class') || '';

                const title =
                    $(element)
                        .find('h2.entry-title')
                        .text()
                        .trim();

                let link =
                    $(element)
                        .find('a.lnk-blk')
                        .attr('href');

                let image =
                    $(element)
                        .find('img')
                        .attr('data-src') ||
                    $(element)
                        .find('img')
                        .attr('src');

                if (
                    image &&
                    image.startsWith('//')
                ) {
                    image =
                        'https:' + image;
                }

                if (link) {

                    if (
                        !link.startsWith('http')
                    ) {
                        link =
                            `${TOONSTREAM_BASE}${
                                link.startsWith('/')
                                    ? ''
                                    : '/'
                            }${link}`;
                    }

                    link =
                        fixUrl(link);
                }

                const type =
                    detectType(
                        link,
                        classText
                    );

                if (title && link) {

                    results.push({
                        title,
                        link,
                        image,
                        type,
                        source: 'ToonStream'
                    });
                }
            }
        );

        return results;

    } catch {

        return [];
    }
};

// ==========================================
// TOONSTREAM EMBED RESOLVER
// ==========================================

const resolveEmbedUrl = async (
    embedUrl
) => {

    try {

        const { data } =
            await axios.get(
                embedUrl,
                {
                    headers:
                        getHeaders(TOONSTREAM_BASE),
                    timeout: 3000,
                    maxRedirects: 5
                }
            );

        const $ =
            cheerio.load(data);

        const nestedIframe =
            $('iframe').attr('src') ||
            $('iframe').attr('data-src');

        if (nestedIframe) {
            return nestedIframe;
        }

        let directVideoUrl = null;

        $('script').each(
            (i, el) => {

                const scriptContent =
                    $(el).html();

                if (!scriptContent) {
                    return;
                }

                const m3u8Match =
                    scriptContent.match(
                        /(https?:\/\/[^\s"'`]+\.m3u8[^\s"'`]*)/i
                    );

                const mp4Match =
                    scriptContent.match(
                        /(https?:\/\/[^\s"'`]+\.mp4[^\s"'`]*)/i
                    );

                if (m3u8Match) {

                    directVideoUrl =
                        m3u8Match[1]
                            .replace(/\\/g, '');

                } else if (mp4Match) {

                    directVideoUrl =
                        mp4Match[1]
                            .replace(/\\/g, '');
                }
            }
        );

        return (
            directVideoUrl ||
            embedUrl
        );

    } catch {

        return embedUrl;
    }
};

// ==========================================
// HOME
// ==========================================

app.get('/', (req, res) => {

    res.json({
        status: "Active",

        message:
            "FetchStream Scraper API is running.",

        sources: [
            "AnimeSalt",
            "ToonStream",
            "DramaWorld"
        ]
    });
});

// ==========================================
// COMBINED SEARCH
// ==========================================

app.get('/search', async (req, res) => {

    const query =
        req.query.q;

    if (!query) {

        return res
            .status(400)
            .json({
                error:
                    "Query parameter 'q' is required"
            });
    }

    const [
        saltResults,
        toonResults,
        dramaResults
    ] = await Promise.all([
        searchAnimeSalt(query),
        searchToonStream(query),
        dramaworld.search(query)
            .catch(() => [])
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
// ==========================================
// ANIMESALT EPISODES
// ==========================================

const getAnimeSaltEpisodes = async (url) => {

    const { data } =
        await axios.get(
            url,
            {
                headers:
                    getHeaders(ANIMESALT_BASE),
                maxRedirects: 5
            }
        );

    const $ =
        cheerio.load(data);

    const episodes = [];

    $('ul.eplister li').each(
        (index, element) => {

            const link =
                $(element)
                    .find('a')
                    .attr('href');

            const number =
                $(element)
                    .find('.epl-num')
                    .text()
                    .trim();

            const title =
                $(element)
                    .find('.epl-title')
                    .text()
                    .trim();

            if (link) {

                episodes.push({
                    epNum:
                        Number(number) ||
                        index + 1,

                    title:
                        title ||
                        `Episode ${number || index + 1}`,

                    link:
                        link.startsWith('http')
                            ? link
                            : `${ANIMESALT_BASE}${link}`,

                    source:
                        'AnimeSalt'
                });
            }
        }
    );

    return episodes;
};


// ==========================================
// TOONSTREAM EPISODES
// ==========================================

const getToonStreamEpisodes = async (
    url
) => {

    const { data } =
        await axios.get(
            url,
            {
                headers:
                    getHeaders(TOONSTREAM_BASE),
                maxRedirects: 5
            }
        );

    const $ =
        cheerio.load(data);

    const episodes = [];

    $('ul.eplister li').each(
        (index, element) => {

            const link =
                $(element)
                    .find('a')
                    .attr('href');

            const number =
                $(element)
                    .find('.epl-num')
                    .text()
                    .trim();

            const title =
                $(element)
                    .find('.epl-title')
                    .text()
                    .trim();

            if (link) {

                episodes.push({
                    epNum:
                        Number(number) ||
                        index + 1,

                    title:
                        title ||
                        `Episode ${number || index + 1}`,

                    link:
                        link.startsWith('http')
                            ? link
                            : `${TOONSTREAM_BASE}${link}`,

                    source:
                        'ToonStream'
                });
            }
        }
    );

    return episodes;
};


// ==========================================
// ANIMESALT STREAMS
// ==========================================

const getAnimeSaltStreams = async (
    episodeUrl
) => {

    const { data } =
        await axios.get(
            episodeUrl,
            {
                headers:
                    getHeaders(ANIMESALT_BASE),
                maxRedirects: 5
            }
        );

    const $ =
        cheerio.load(data);

    const streams = [];

    $('iframe').each(
        (index, element) => {

            let src =
                $(element).attr('src') ||
                $(element).attr('data-src');

            if (!src) return;

            if (
                src.startsWith('//')
            ) {
                src =
                    'https:' + src;
            }

            if (
                !src.startsWith('http')
            ) {
                src =
                    `${ANIMESALT_BASE}${src}`;
            }

            streams.push({
                server:
                    `Server ${index + 1}`,

                type:
                    'embed',

                link:
                    src
            });
        }
    );

    return streams;
};


// ==========================================
// TOONSTREAM STREAMS
// ==========================================

const getToonStreamStreams = async (
    episodeUrl
) => {

    const { data } =
        await axios.get(
            episodeUrl,
            {
                headers:
                    getHeaders(TOONSTREAM_BASE),
                maxRedirects: 5
            }
        );

    const $ =
        cheerio.load(data);

    const streams = [];

    $('iframe').each(
        (index, element) => {

            let src =
                $(element).attr('src') ||
                $(element).attr('data-src');

            if (!src) return;

            if (
                src.startsWith('//')
            ) {
                src =
                    'https:' + src;
            }

            if (
                !src.startsWith('http')
            ) {
                src =
                    `${TOONSTREAM_BASE}${src}`;
            }

            streams.push({
                server:
                    `Server ${index + 1}`,

                type:
                    'embed',

                link:
                    src
            });
        }
    );

    return streams;
};


// ==========================================
// DRAMAWORLD SEARCH
// ==========================================

app.get(
    '/dramaworld/search',
    async (req, res) => {

        const query =
            req.query.q;

        if (!query) {

            return res
                .status(400)
                .json({
                    error:
                        "Query parameter 'q' is required"
                });
        }

        try {

            const results =
                await dramaworld.search(query);

            res.json({

                source:
                    'DramaWorld',

                query,

                total:
                    results.length,

                results
            });

        } catch (err) {

            handleScraperError(
                res,
                err,
                'DramaWorld search failed'
            );
        }
    }
);


// ==========================================
// DRAMAWORLD EPISODES
// ==========================================

app.get(
    '/dramaworld/episodes',
    async (req, res) => {

        const url =
            req.query.url;

        if (!url) {

            return res
                .status(400)
                .json({
                    error:
                        "Query parameter 'url' is required"
                });
        }

        try {

            const episodes =
                await dramaworld.episodes(url);

            res.json({

                source:
                    'DramaWorld',

                total:
                    episodes.length,

                episodes
            });

        } catch (err) {

            handleScraperError(
                res,
                err,
                'DramaWorld episodes failed'
            );
        }
    }
);


// ==========================================
// DRAMAWORLD STREAMS
// ==========================================

app.get(
    '/dramaworld/streams',
    async (req, res) => {

        const url =
            req.query.url;

        if (!url) {

            return res
                .status(400)
                .json({
                    error:
                        "Query parameter 'url' is required"
                });
        }

        try {

            const result =
                await dramaworld.streams(url);

            res.json(result);

        } catch (err) {

            handleScraperError(
                res,
                err,
                'DramaWorld streams failed'
            );
        }
    }
);


// ==========================================
// SOURCE-SPECIFIC EPISODES
// ==========================================

app.get(
    '/animesalt/episodes',
    async (req, res) => {

        const url =
            req.query.url;

        if (!url) {

            return res
                .status(400)
                .json({
                    error:
                        "Query parameter 'url' is required"
                });
        }

        try {

            const episodes =
                await getAnimeSaltEpisodes(url);

            res.json({
                source:
                    'AnimeSalt',

                total:
                    episodes.length,

                episodes
            });

        } catch (err) {

            handleScraperError(
                res,
                err,
                'AnimeSalt episodes failed'
            );
        }
    }
);


app.get(
    '/toonstream/episodes',
    async (req, res) => {

        const url =
            req.query.url;

        if (!url) {

            return res
                .status(400)
                .json({
                    error:
                        "Query parameter 'url' is required"
                });
        }

        try {

            const episodes =
                await getToonStreamEpisodes(url);

            res.json({
                source:
                    'ToonStream',

                total:
                    episodes.length,

                episodes
            });

        } catch (err) {

            handleScraperError(
                res,
                err,
                'ToonStream episodes failed'
            );
        }
    }
);


// ==========================================
// SOURCE-SPECIFIC STREAMS
// ==========================================

app.get(
    '/animesalt/streams',
    async (req, res) => {

        const url =
            req.query.url;

        if (!url) {

            return res
                .status(400)
                .json({
                    error:
                        "Query parameter 'url' is required"
                });
        }

        try {

            const streams =
                await getAnimeSaltStreams(url);

            res.json({
                source:
                    'AnimeSalt',

                total:
                    streams.length,

                streams
            });

        } catch (err) {

            handleScraperError(
                res,
                err,
                'AnimeSalt streams failed'
            );
        }
    }
);


app.get(
    '/toonstream/streams',
    async (req, res) => {

        const url =
            req.query.url;

        if (!url) {

            return res
                .status(400)
                .json({
                    error:
                        "Query parameter 'url' is required"
                });
        }

        try {

            const streams =
                await getToonStreamStreams(url);

            res.json({
                source:
                    'ToonStream',

                total:
                    streams.length,

                streams
            });

        } catch (err) {

            handleScraperError(
                res,
                err,
                'ToonStream streams failed'
            );
        }
    }
);
// ==========================================
// TMDB OFFICIAL METADATA SERVICE
// ==========================================

const tmdbRequest = async (
    endpoint,
    params = {}
) => {

    if (!TMDB_API_KEY) {
        throw new Error(
            "TMDB API key is not configured"
        );
    }

    const response =
        await axios.get(
            `https://api.themoviedb.org/3${endpoint}`,
            {
                params: {
                    api_key:
                        TMDB_API_KEY,

                    ...params
                },

                timeout: 10000
            }
        );

    return response.data;
};


// ==========================================
// TMDB SEARCH
// ==========================================

app.get(
    '/tmdb/search',
    async (req, res) => {

        const query =
            req.query.q;

        if (!query) {

            return res
                .status(400)
                .json({
                    error:
                        "Query parameter 'q' is required"
                });
        }

        try {

            const data =
                await tmdbRequest(
                    '/search/multi',
                    {
                        query,
                        language:
                            req.query.language ||
                            'en-US',

                        include_adult:
                            false
                    }
                );

            const results =
                (data.results || [])
                    .filter(
                        item =>
                            item.media_type ===
                            'movie' ||
                            item.media_type ===
                            'tv'
                    )
                    .map(item => ({

                        id:
                            item.id,

                        title:
                            item.title ||
                            item.name,

                        original_title:
                            item.original_title ||
                            item.original_name,

                        type:
                            item.media_type,

                        overview:
                            item.overview || '',

                        poster:
                            item.poster_path
                                ? `https://image.tmdb.org/t/p/w500${item.poster_path}`
                                : null,

                        backdrop:
                            item.backdrop_path
                                ? `https://image.tmdb.org/t/p/w1280${item.backdrop_path}`
                                : null,

                        release_date:
                            item.release_date ||
                            item.first_air_date ||
                            null,

                        rating:
                            item.vote_average ||
                            0
                    }));

            res.json({
                query,
                total:
                    results.length,
                results
            });

        } catch (err) {

            handleScraperError(
                res,
                err,
                'TMDB search failed'
            );
        }
    }
);


// ==========================================
// TMDB MOVIE DETAILS
// ==========================================

app.get(
    '/tmdb/movie/:id',
    async (req, res) => {

        try {

            const data =
                await tmdbRequest(
                    `/movie/${req.params.id}`,
                    {
                        language:
                            req.query.language ||
                            'en-US'
                    }
                );

            res.json(data);

        } catch (err) {

            handleScraperError(
                res,
                err,
                'TMDB movie request failed'
            );
        }
    }
);


// ==========================================
// TMDB TV DETAILS
// ==========================================

app.get(
    '/tmdb/tv/:id',
    async (req, res) => {

        try {

            const data =
                await tmdbRequest(
                    `/tv/${req.params.id}`,
                    {
                        language:
                            req.query.language ||
                            'en-US'
                    }
                );

            res.json(data);

        } catch (err) {

            handleScraperError(
                res,
                err,
                'TMDB TV request failed'
            );
        }
    }
);


// ==========================================
// TMDB TV EPISODE DETAILS
// ==========================================

app.get(
    '/tmdb/tv/:id/season/:season/episode/:episode',
    async (req, res) => {

        try {

            const {
                id,
                season,
                episode
            } = req.params;

            const data =
                await tmdbRequest(
                    `/tv/${id}/season/${season}/episode/${episode}`,
                    {
                        language:
                            req.query.language ||
                            'en-US'
                    }
                );

            res.json(data);

        } catch (err) {

            handleScraperError(
                res,
                err,
                'TMDB episode request failed'
            );
        }
    }
);


// ==========================================
// HEALTH CHECK
// ==========================================

app.get(
    '/health',
    (req, res) => {

        res.json({

            status:
                'ok',

            service:
                'FetchStream Scraper API',

            sources: [
                'AnimeSalt',
                'ToonStream',
                'DramaWorld'
            ],

            timestamp:
                new Date().toISOString()
        });
    }
);


// ==========================================
// 404 HANDLER
// ==========================================

app.use(
    (req, res) => {

        res.status(404).json({

            error:
                'Endpoint not found',

            path:
                req.originalUrl
        });
    }
);


// ==========================================
// GLOBAL ERROR HANDLER
// ==========================================

app.use(
    (err, req, res, next) => {

        console.error(
            'Unhandled error:',
            err
        );

        if (res.headersSent) {
            return next(err);
        }

        res.status(500).json({

            error:
                'Internal server error',

            details:
                err.message
        });
    }
);


// ==========================================
// SERVER START
// ==========================================

app.listen(
    PORT,
    '0.0.0.0',
    () => {

        console.log(
            `FetchStream API running on port ${PORT}`
        );
    }
);
