const axios = require("axios");
const cheerio = require("cheerio");

const DRAMAWORLD_BASE = "https://dramaworld.site";

const REQUEST_HEADERS = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",

    "Accept":
        "text/html,application/xhtml+xml,application/xml;q=0.9," +
        "image/avif,image/webp,*/*;q=0.8",

    "Accept-Language":
        "en-US,en;q=0.9",

    "Referer":
        `${DRAMAWORLD_BASE}/`
};

function absoluteUrl(url, base = DRAMAWORLD_BASE) {
    if (!url) return null;

    try {
        return new URL(url, base).href;
    } catch {
        return null;
    }
}

function cleanText(text) {
    return String(text || "")
        .replace(/\s+/g, " ")
        .trim();
}

async function fetchPage(url) {
    const response = await axios.get(url, {
        headers: REQUEST_HEADERS,
        timeout: 15000,
        maxRedirects: 5,
        validateStatus: status =>
            status >= 200 && status < 400
    });

    return {
        html: response.data,
        finalUrl: response.request?.res?.responseUrl || url
    };
}

/*
 * DramaWorld's player token is a URL-safe/base64 JSON object.
 *
 * We ONLY decode the publicly exposed token.
 * We do not forge signatures, modify expiry values,
 * or bypass protected media.
 */
function decodePublicPlayerToken(token) {
    if (!token) return null;

    try {
        let value = String(token).trim();

        // Base64URL -> normal Base64
        value = value
            .replace(/-/g, "+")
            .replace(/_/g, "/");

        while (value.length % 4 !== 0) {
            value += "=";
        }

        const decoded =
            Buffer.from(value, "base64")
                .toString("utf8");

        const parsed = JSON.parse(decoded);

        return {
            url: parsed.u || null,
            expires: parsed.e || null,
            signature: parsed.s || null,
            label: parsed.l || null,
            type: parsed.t || null
        };

    } catch {
        return null;
    }
}

function extractPlayerTokenFromEmbed(embedUrl) {
    if (!embedUrl) return null;

    const marker = "/stream/embed/";

    const index =
        embedUrl.indexOf(marker);

    if (index === -1) {
        return null;
    }

    return embedUrl
        .slice(index + marker.length)
        .split("?")[0]
        .split("#")[0]
        .trim();
}

function buildPublicStream(embedUrl, serverName) {
    const token =
        extractPlayerTokenFromEmbed(embedUrl);

    const decoded =
        decodePublicPlayerToken(token);

    return {
        server:
            serverName || "Online Watch",

        type:
            "stream",

        embed_url:
            embedUrl,

        // This is the URL explicitly encoded
        // inside DramaWorld's public player token.
        stream_url:
            decoded?.url || embedUrl,

        expires:
            decoded?.expires || null,

        token:
            token || null
    };
}
// ============================================================
// SEARCH
// ============================================================

async function search(query) {
    if (!query || !String(query).trim()) {
        return [];
    }

    const q =
        String(query).trim();

    const searchUrl =
        `${DRAMAWORLD_BASE}/?s=${encodeURIComponent(q)}`;

    const { html } =
        await fetchPage(searchUrl);

    const $ =
        cheerio.load(html);

    const results = [];
    const seen = new Set();

    /*
     * DramaWorld uses /drama/<slug> for show pages.
     * We intentionally ignore /watch/ links here so
     * search returns the series/movie itself.
     */

    $("a[href]").each((index, element) => {

        const href =
            absoluteUrl(
                $(element).attr("href")
            );

        if (!href) return;

        const url =
            new URL(href);

        if (
            url.hostname !==
            new URL(DRAMAWORLD_BASE).hostname
        ) {
            return;
        }

        if (!url.pathname.startsWith("/drama/")) {
            return;
        }

        const title =
            cleanText(
                $(element).text()
            );

        if (!title) return;

        if (seen.has(href)) return;

        seen.add(href);

        let image =
            $(element)
                .find("img")
                .first()
                .attr("src") ||
            $(element)
                .find("img")
                .first()
                .attr("data-src");

        image =
            absoluteUrl(image);

        results.push({
            title,
            link: href,
            image,
            source: "DramaWorld"
        });
    });

    return results.slice(0, 30);
}

// ============================================================
// EPISODES
// ============================================================

async function episodes(seriesUrl) {

    const pageUrl =
        absoluteUrl(seriesUrl);

    if (!pageUrl) {
        throw new Error(
            "Invalid DramaWorld series URL"
        );
    }

    const { html } =
        await fetchPage(pageUrl);

    const $ =
        cheerio.load(html);

    const results = [];
    const seen = new Set();

    /*
     * Actual DramaWorld HTML contains:
     *
     * /watch/my-bias-my-boss-episode-10
     * /watch/my-bias-my-boss-episode-9
     * ...
     *
     * in both mobile and sidebar episode lists.
     */

    $('a[href*="/watch/"]').each(
        (index, element) => {

            const link =
                absoluteUrl(
                    $(element).attr("href")
                );

            if (!link) return;

            if (seen.has(link)) return;

            seen.add(link);

            const text =
                cleanText(
                    $(element).text()
                );

            const match =
                link.match(
                    /episode[-_ ]?(\d+)/i
                );

            const epNum =
                match
                    ? Number(match[1])
                    : index + 1;

            results.push({
                epNum,
                title:
                    text ||
                    `Episode ${epNum}`,

                link,

                source:
                    "DramaWorld"
            });
        }
    );

    /*
     * If the supplied URL itself is an episode page
     * and no episode list was detected, return it.
     */

    if (
        results.length === 0 &&
        pageUrl.includes("/watch/")
    ) {

        const match =
            pageUrl.match(
                /episode[-_ ]?(\d+)/i
            );

        const epNum =
            match
                ? Number(match[1])
                : 1;

        results.push({
            epNum,

            title:
                cleanText(
                    $("h2.wic-title, h1, h2")
                        .first()
                        .text()
                ) ||
                `Episode ${epNum}`,

            link:
                pageUrl,

            source:
                "DramaWorld"
        });
    }

    results.sort(
        (a, b) =>
            Number(a.epNum) -
            Number(b.epNum)
    );

    return results;
}

// ============================================================
// STREAMS
// ============================================================

async function streams(episodeUrl) {

    const pageUrl =
        absoluteUrl(episodeUrl);

    if (!pageUrl) {
        throw new Error(
            "Invalid DramaWorld episode URL"
        );
    }

    const { html } =
        await fetchPage(pageUrl);

    const $ =
        cheerio.load(html);

    const streamsList = [];
    const seen = new Set();

    const title =
        cleanText(
            $("h2.wic-title")
                .first()
                .text()
        ) ||
        cleanText(
            $("h1")
                .first()
                .text()
        );

    const seriesTitle =
        cleanText(
            $(".wic-series-link")
                .first()
                .text()
        );

    let poster =
        $('meta[property="og:image"]')
            .attr("content") ||

        $('meta[name="twitter:image"]')
            .attr("content");

    poster =
        absoluteUrl(
            poster,
            pageUrl
        );

    /*
     * Actual source:
     *
     * <iframe src="/stream/embed/TOKEN">
     *
     * We extract this publicly exposed iframe.
     */

    $("iframe").each(
        (index, element) => {

            let src =
                $(element).attr("src") ||
                $(element).attr("data-src");

            if (!src) return;

            src =
                absoluteUrl(
                    src,
                    pageUrl
                );

            if (!src) return;

            if (
                !src.includes(
                    "/stream/embed/"
                )
            ) {
                return;
            }

            if (seen.has(src)) return;

            seen.add(src);

            streamsList.push(
                buildPublicStream(
                    src,
                    "Online Watch"
                )
            );
        }
    );

    /*
     * Also inspect server buttons.
     *
     * DramaWorld explicitly stores the same player
     * token in:
     *
     * data-token="..."
     *
     * and switchServer() builds:
     *
     * /stream/embed/ + token
     */

    $(".server-btn").each(
        (index, element) => {

            const token =
                $(element)
                    .attr("data-token");

            if (!token) return;

            const serverName =
                cleanText(
                    $(element).text()
                ) ||
                `Server ${index + 1}`;

            const embedUrl =
                `${DRAMAWORLD_BASE}/stream/embed/${token}`;

            if (seen.has(embedUrl)) return;

            seen.add(embedUrl);

            streamsList.push(
                buildPublicStream(
                    embedUrl,
                    serverName
                )
            );
        }
    );
      /*
     * Remove duplicate stream URLs while preserving order.
     */

    const uniqueStreams = [];

    const streamSeen =
        new Set();

    for (const stream of streamsList) {

        const key =
            stream.stream_url ||
            stream.embed_url;

        if (!key) continue;

        if (streamSeen.has(key)) {
            continue;
        }

        streamSeen.add(key);

        uniqueStreams.push(stream);
    }

    return {
        title:
            title || null,

        series:
            seriesTitle || null,

        episode_url:
            pageUrl,

        poster_image:
            poster || null,

        streams:
            uniqueStreams,

        source:
            "DramaWorld"
    };
}

// ============================================================
// ERROR-SAFE WRAPPERS
// ============================================================

async function safeSearch(query) {
    try {
        return await search(query);
    } catch (error) {
        throw new Error(
            `DramaWorld search failed: ${error.message}`
        );
    }
}

async function safeEpisodes(url) {
    try {
        return await episodes(url);
    } catch (error) {
        throw new Error(
            `DramaWorld episodes failed: ${error.message}`
        );
    }
}

async function safeStreams(url) {
    try {
        return await streams(url);
    } catch (error) {
        throw new Error(
            `DramaWorld streams failed: ${error.message}`
        );
    }
}

// ============================================================
// EXPORT
// ============================================================

module.exports = {
    search: safeSearch,
    episodes: safeEpisodes,
    streams: safeStreams,

    // Export helpers too, useful when connecting
    // this module with index.js later.
    decodePublicPlayerToken,
    extractPlayerTokenFromEmbed
};
