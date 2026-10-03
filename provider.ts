// RareAnime online-stream provider for Seanime.
// Source: https://www.rareanimes.mov/
//
// RareAnimes splits some long-running shows across season pages and often
// sends "WatchMultiQuality" buttons to an external episode index. This
// provider therefore:
// 1) matches titles using the post URL slug (not generic menu labels),
// 2) groups season pages for long-running AniList entries,
// 3) only parses episode labels from the actual post content,
// 4) follows batch/index pages when the RareAnimes post does not expose
//    individual episode links itself.

declare type SubOrDub = "sub" | "dub" | "both";
declare type VideoSourceType = "mp4" | "m3u8" | "unknown";

declare interface Settings {
  episodeServers: string[];
  supportsDub: boolean;
}

declare interface Media {
  id: number;
  idMal?: number;
  status?: string;
  format?: string;
  englishTitle?: string;
  romajiTitle?: string;
  episodeCount?: number;
  synonyms: string[];
  isAdult: boolean;
}

declare interface SearchOptions {
  media: Media;
  query: string;
  dub: boolean;
  year?: number;
}

declare interface SearchResult {
  id: string;
  title: string;
  url: string;
  subOrDub: SubOrDub;
}

declare interface EpisodeDetails {
  id: string;
  number: number;
  url: string;
  title?: string;
}

declare interface VideoSubtitle {
  id: string;
  url: string;
  language: string;
  isDefault: boolean;
}

declare interface VideoSource {
  url: string;
  type: VideoSourceType;
  quality: string;
  label?: string;
  subtitles: VideoSubtitle[];
}

declare interface EpisodeServer {
  server: string;
  headers: Record<string, string>;
  videoSources: VideoSource[];
}

declare interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: any;
  noCloudflareBypass?: boolean;
  redirect?: "follow" | "manual" | "error";
  timeout?: number;
}

declare interface FetchResponse {
  status: number;
  statusText: string;
  ok: boolean;
  url: string;
  headers: Record<string, string>;
  cookies: Record<string, string>;
  text(): string;
  json<T = any>(): T;
}

declare function fetch(url: string, options?: FetchOptions): Promise<FetchResponse>;

interface RareLink {
  name: string;
  url: string;
}

interface RareEpisodeId {
  page: string;
  number: number;
  localNumber?: number;
  title?: string;
  links: RareLink[];
  batch?: boolean;
}

interface RareCollectionId {
  collection: string[];
  target: string;
  expected?: number;
}

interface Candidate {
  title: string;
  url: string;
  slugTitle: string;
  baseTitle: string;
  season: number;
  score: number;
  mappedTitle: string;
}

interface PageEpisodeResult {
  episodes: EpisodeDetails[];
  localCount: number;
}

const BASE_URL = "https://www.rareanimes.mov";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SERVER_NAMES = [
  "Auto",
  "WatchMultiQuality",
  "StreamBeta",
  "HubCloud",
  "WatchNow",
  "DLBeta",
  "Mega",
];

class Provider {
  getSettings(): Settings {
    return {
      episodeServers: SERVER_NAMES,
      supportsDub: true,
    };
  }

  private async request(url: string, referer?: string): Promise<FetchResponse> {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": USER_AGENT,
        ...(referer ? { Referer: referer } : {}),
      },
      redirect: "follow",
      timeout: 30,
    });

    if (!response.ok) {
      throw new Error("RareAnime: HTTP " + response.status + " for " + url);
    }
    return response;
  }

  private decodeHtml(value: string): string {
    return (value || "")
      .replace(/&amp;/g, "&")
      .replace(/&quot;|&#34;/g, '"')
      .replace(/&#039;|&#39;|&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#8211;|&ndash;/g, "–")
      .replace(/&#8212;|&mdash;/g, "—")
      .replace(/&#038;/g, "&");
  }

  private stripTags(value: string): string {
    return this.decodeHtml(
      (value || "")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    )
      .replace(/\s+/g, " ")
      .trim();
  }

  private absoluteUrl(url: string, base: string = BASE_URL): string {
    const clean = this.decodeHtml(url).trim();
    if (!clean) return "";
    if (/^https?:\/\//i.test(clean)) return clean;
    if (clean.startsWith("//")) return "https:" + clean;

    const originMatch = base.match(/^(https?:\/\/[^/]+)/i);
    const origin = originMatch ? originMatch[1] : BASE_URL;
    if (clean.startsWith("/")) return origin + clean;

    const baseNoQuery = base.replace(/[?#].*$/, "");
    const directory = baseNoQuery.endsWith("/")
      ? baseNoQuery
      : baseNoQuery.replace(/\/[^/]*$/, "/");

    if (clean.startsWith("./")) return directory + clean.slice(2);
    if (clean.startsWith("../")) {
      return origin + "/" + clean.replace(/^(\.\.\/)+/, "");
    }
    return directory + clean;
  }

  private normalizeTitle(value: string): string {
    return this.stripTags(value)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[’']/g, "")
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private slugTitle(url: string): string {
    const clean = url.replace(/[?#].*$/, "").replace(/\/+$/, "");
    const slug = clean.split("/").pop() || "";
    return this.decodeHtml(slug.replace(/[-_]+/g, " "));
  }

  private seasonNumber(value: string): number {
    const normalized = this.normalizeTitle(value);
    let match = normalized.match(/\bseason\s*0*(\d{1,3})\b/i);
    if (match) return parseInt(match[1], 10);
    match = normalized.match(/\bs\s*0*(\d{1,3})\b/i);
    if (match) return parseInt(match[1], 10);
    match = normalized.match(/\b(\d{1,3})(?:st|nd|rd|th)\s+season\b/i);
    return match ? parseInt(match[1], 10) : 0;
  }

  private baseTitle(value: string): string {
    return this.normalizeTitle(value)
      .replace(/\b(?:season|part)\s*0*\d{1,3}\b/g, " ")
      .replace(/\b\d{1,3}(?:st|nd|rd|th)\s+season\b/g, " ")
      .replace(/\bs\s*0*\d{1,3}\b/g, " ")
      .replace(/\b(?:hindi|tamil|telugu|malayalam|bengali|english|japanese)\b/g, " ")
      .replace(/\b(?:dub|dubbed|sub|subbed|multi|audio|episodes?|download|watch|online|hd|fhd|web|webrip|webdl|bluray|original|new)\b/g, " ")
      .replace(/\b(?:360p|480p|720p|1080p|2160p)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private words(value: string): string[] {
    return value.split(" ").filter((word) => word.length > 0);
  }

  private buildTargets(options: SearchOptions): string[] {
    const values = [
      options.query,
      options.media.englishTitle,
      options.media.romajiTitle,
      ...(options.media.synonyms || []),
    ];
    const output: string[] = [];
    for (const value of values) {
      const clean = (value || "").trim();
      if (!clean) continue;
      if (!output.some((item) => item.toLowerCase() === clean.toLowerCase())) {
        output.push(clean);
      }
    }
    return output;
  }

  private buildQueries(options: SearchOptions): string[] {
    const targets = this.buildTargets(options);
    const output: string[] = [];

    const add = (value: string) => {
      const clean = value.trim().replace(/\s+/g, " ");
      if (clean && !output.some((item) => item.toLowerCase() === clean.toLowerCase())) {
        output.push(clean);
      }
    };

    for (const target of targets) {
      add(target);
      const noSeason = target
        .replace(/\s+(?:season\s*\d+|\d+(?:st|nd|rd|th)\s+season)\s*$/i, "")
        .trim();
      if (noSeason) add(noSeason);
      const colon = target.indexOf(":");
      if (colon > 0) add(target.slice(0, colon));
    }

    return output.slice(0, 5);
  }

  private scoreCandidate(title: string, url: string, options: SearchOptions): { score: number; mappedTitle: string } {
    const slug = this.slugTitle(url);
    const candidateBase = this.baseTitle(slug || title);
    const candidateWords = this.words(candidateBase);
    const candidateSeason = this.seasonNumber(slug + " " + title);
    const targets = this.buildTargets(options);

    let bestScore = 0;
    let mappedTitle = title;

    for (const target of targets) {
      const targetBase = this.baseTitle(target);
      const targetWords = this.words(targetBase);
      if (!targetBase || !targetWords.length || !candidateWords.length) continue;

      let hits = 0;
      for (const word of targetWords) {
        if (candidateWords.indexOf(word) >= 0) hits++;
      }

      const recall = hits / targetWords.length;
      const precision = hits / candidateWords.length;
      let score = Math.round(recall * 72 + precision * 28);

      if (candidateBase === targetBase) score = 120;

      const targetSeason = this.seasonNumber(target);
      if (targetSeason > 0) {
        if (candidateSeason === targetSeason) score += 18;
        else if (candidateSeason > 0) score -= 35;
      } else if (candidateSeason > 0) {
        if (candidateSeason === 1) score += 8;
        else score -= Math.min(14, (candidateSeason - 1) * 2);
      }

      if (options.year && (title + " " + slug).indexOf(String(options.year)) >= 0) {
        score += 6;
      }

      if (score > bestScore) {
        bestScore = score;
        mappedTitle = target;
      }
    }

    return { score: bestScore, mappedTitle };
  }

  private extractSearchResults(html: string, options: SearchOptions): Candidate[] {
    const found: Record<string, Candidate> = {};
    const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = anchor.exec(html)) !== null) {
      const url = this.absoluteUrl(match[1], BASE_URL);
      const rawTitle = this.stripTags(match[2]);
      if (!url.startsWith(BASE_URL)) continue;
      if (!/\/hindi\//i.test(url)) continue;
      if (/\/(?:category|tag|author|page)\//i.test(url)) continue;

      const slugTitle = this.slugTitle(url);
      const scoring = this.scoreCandidate(rawTitle || slugTitle, url, options);
      if (scoring.score < 55) continue;

      const candidate: Candidate = {
        title: rawTitle || slugTitle,
        url,
        slugTitle,
        baseTitle: this.baseTitle(slugTitle || rawTitle),
        season: this.seasonNumber(slugTitle + " " + rawTitle),
        score: scoring.score,
        mappedTitle: scoring.mappedTitle,
      };

      if (!found[url] || candidate.score > found[url].score) {
        found[url] = candidate;
      }
    }

    return Object.keys(found).map((key) => found[key]);
  }

  private parseCollectionId(id: string): RareCollectionId | null {
    try {
      const parsed = JSON.parse(id);
      if (parsed && Array.isArray(parsed.collection) && parsed.collection.length > 0) {
        return parsed as RareCollectionId;
      }
    } catch (_error) {}
    return null;
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const queries = this.buildQueries(options);
    const all: Record<string, Candidate> = {};

    for (const query of queries) {
      try {
        // The navigation on RareAnimes contains useful season links even when
        // WordPress search results are ordered by recency, so inspect all
        // internal /hindi/ links and score by their URL slugs.
        const response = await this.request(BASE_URL + "/?s=" + encodeURIComponent(query));
        const html = await Promise.resolve(response.text());
        const rows = this.extractSearchResults(html, options);

        for (const row of rows) {
          if (!all[row.url] || row.score > all[row.url].score) {
            all[row.url] = row;
          }
        }

        if (rows.some((row) => row.score >= 120)) break;
      } catch (error) {
        console.error('RareAnime: search failed for "' + query + '"', error);
      }
    }

    const rows = Object.keys(all)
      .map((key) => all[key])
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.season && b.season) return a.season - b.season;
        return 0;
      });

    if (!rows.length) return [];

    const results: SearchResult[] = [];

    // AniList treats some older long-running shows as one entry while
    // RareAnimes splits them into Season 1, Season 2, etc. Group those pages
    // into one provider result so Naruto (220), Shippuden (500), etc. can be
    // assembled in episode order.
    if ((options.media.episodeCount || 0) >= 40) {
      const top = rows[0];
      const sameBase = rows
        .filter((row) => row.baseTitle === top.baseTitle && row.season > 0)
        .sort((a, b) => a.season - b.season);

      const uniqueBySeason: Record<number, Candidate> = {};
      for (const row of sameBase) {
        if (!uniqueBySeason[row.season]) uniqueBySeason[row.season] = row;
      }

      const seasons = Object.keys(uniqueBySeason)
        .map((key) => parseInt(key, 10))
        .sort((a, b) => a - b)
        .map((season) => uniqueBySeason[season]);

      if (seasons.length >= 2) {
        const collection: RareCollectionId = {
          collection: seasons.map((row) => row.url),
          target: top.mappedTitle,
          expected: options.media.episodeCount,
        };

        results.push({
          id: JSON.stringify(collection),
          title: top.mappedTitle,
          url: seasons[0].url,
          subOrDub: "both",
        });
      }
    }

    for (const row of rows.slice(0, 12)) {
      results.push({
        id: row.url,
        // When the slug base exactly matches one of AniList's titles, expose
        // that AniList title to Seanime. Seanime performs its own Levenshtein
        // matching on this field, so this avoids "Naruto" being auto-matched
        // to "Boruto: Naruto Next Generations".
        title: row.score >= 110 ? row.mappedTitle : row.title,
        url: row.url,
        subOrDub: /\bsub(?:bed)?\b/i.test(row.slugTitle) && !/\bdub(?:bed)?\b/i.test(row.slugTitle)
          ? "sub"
          : "dub",
      });
    }

    return results;
  }

  private normalizeServerName(label: string, url: string = ""): string {
    const value = (this.stripTags(label) + " " + url).replace(/\s+/g, "").toLowerCase();
    if (value.indexOf("watchmulti") >= 0) return "WatchMultiQuality";
    if (value.indexOf("streambeta") >= 0) return "StreamBeta";
    if (value.indexOf("hubcloud") >= 0) return "HubCloud";
    if (value.indexOf("watchnow") >= 0) return "WatchNow";
    if (value.indexOf("dlbeta") >= 0) return "DLBeta";
    if (value.indexOf("mega") >= 0) return "Mega";
    return this.stripTags(label) || "Source";
  }

  private isNoiseUrl(url: string): boolean {
    const lower = (url || "").toLowerCase();
    return (
      !/^https?:\/\//i.test(url) ||
      /(?:facebook\.com|twitter\.com|x\.com|reddit\.com|whatsapp\.com|t\.me|telegram\.)/i.test(lower) ||
      /(?:\/comment-page-|replytocom=|#respond|\/sharer\/|intent\/tweet|\/submit\?url=)/i.test(lower) ||
      /(?:wp-login|wp-admin|\/feed\/?$|\/author\/|\/tag\/|\/category\/)/i.test(lower)
    );
  }

  private isUsefulLink(label: string, url: string): boolean {
    if (this.isNoiseUrl(url)) return false;

    const text = (label + " " + url).toLowerCase();
    if (/\b(?:zip|gofile|mediafire)\b/i.test(text)) return false;

    // Do not treat arbitrary RareAnimes navigation/article links as stream
    // servers. Those were the reason a Naruto batch link could wander into a
    // completely unrelated Pokemon page.
    if (url.startsWith(BASE_URL)) {
      return /(?:\/watch|\/stream|\/player|\/redirect)/i.test(url);
    }

    return /watch|stream|hubcloud|dlbeta|mega|multi|player|episode|\bep\b|codedew|animetoonhindi/i.test(text);
  }

  private targetBaseFromPage(pageUrl: string): string {
    return this.baseTitle(this.slugTitle(pageUrl));
  }

  private isMatchingInternalRedirect(targetPageUrl: string, finalUrl: string): boolean {
    if (!finalUrl.startsWith(BASE_URL)) return true;

    const targetBase = this.targetBaseFromPage(targetPageUrl);
    const finalBase = this.baseTitle(this.slugTitle(finalUrl));
    if (!targetBase || !finalBase) return true;

    const targetWords = this.words(targetBase);
    const finalWords = this.words(finalBase);
    const hits = targetWords.filter((word) => finalWords.indexOf(word) >= 0).length;
    const recall = targetWords.length ? hits / targetWords.length : 0;
    const precision = finalWords.length ? hits / finalWords.length : 0;

    return targetBase === finalBase || (recall >= 0.8 && precision >= 0.6);
  }

  private extractLinks(block: string, baseUrl: string): RareLink[] {
    const links: RareLink[] = [];
    const seen: Record<string, boolean> = {};
    const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = anchor.exec(block)) !== null) {
      const url = this.absoluteUrl(match[1], baseUrl);
      const rawLabel = this.stripTags(match[2]);
      if (!url || seen[url] || !/^https?:\/\//i.test(url)) continue;
      if (!this.isUsefulLink(rawLabel, url)) continue;
      seen[url] = true;
      links.push({
        name: this.normalizeServerName(rawLabel, url),
        url,
      });
    }

    return links;
  }

  private postContent(html: string): string {
    const lower = html.toLowerCase();
    const watchMarker = lower.indexOf("watch-download");
    let start = 0;

    if (watchMarker >= 0) {
      const articleStart = lower.lastIndexOf("<article", watchMarker);
      start = articleStart >= 0 ? articleStart : Math.max(0, watchMarker - 1500);
    } else {
      const articleStart = lower.indexOf("<article");
      const entryStart = lower.indexOf("entry-content");
      if (articleStart >= 0) start = articleStart;
      else if (entryStart >= 0) start = Math.max(0, lower.lastIndexOf("<", entryStart));
    }

    let end = html.length;
    const markers = [
      "watch also",
      "winding up",
      "comment on rai",
      "related posts",
      "please share raretoons",
    ];

    for (const marker of markers) {
      const index = lower.indexOf(marker, Math.max(start, watchMarker >= 0 ? watchMarker : start));
      if (index >= 0 && index < end) end = index;
    }

    return html.slice(start, end);
  }

  private isInsideTag(html: string, index: number): boolean {
    return html.lastIndexOf("<", index) > html.lastIndexOf(">", index);
  }

  private cleanEpisodeTitle(value: string): string {
    return this.stripTags(value)
      .replace(/\b(?:Hindi|Tamil|Telugu|Malayalam|Bengali|FanDub|Crunchyroll|AnimeTimes)\b.*$/i, "")
      .replace(/^[-–—:\s]+|[-–—:\s]+$/g, "")
      .trim();
  }

  private episodePayload(
    pageUrl: string,
    globalNumber: number,
    localNumber: number,
    title: string,
    links: RareLink[],
    batch: boolean,
  ): EpisodeDetails {
    const payload: RareEpisodeId = {
      page: pageUrl,
      number: globalNumber,
      localNumber,
      ...(title ? { title } : {}),
      links,
      ...(batch ? { batch: true } : {}),
    };

    return {
      id: JSON.stringify(payload),
      number: globalNumber,
      url: pageUrl,
      ...(title ? { title } : {}),
    };
  }

  private extractEpisodes(html: string, pageUrl: string, offset: number = 0): EpisodeDetails[] {
    const starts: Array<{ index: number; number: number; title: string }> = [];
    const episode = /\bEpisode\s*0*(\d{1,4})\b\s*(?:[-–—:]\s*)?([^<\r\n]{0,180})/gi;
    let match: RegExpExecArray | null;

    while ((match = episode.exec(html)) !== null) {
      if (this.isInsideTag(html, match.index)) continue;
      const number = parseInt(match[1], 10);
      if (!number || number > 2000) continue;
      if (starts.some((item) => item.number === number && Math.abs(item.index - match!.index) < 300)) {
        continue;
      }

      starts.push({
        index: match.index,
        number,
        title: this.cleanEpisodeTitle(match[2] || ""),
      });
    }

    const episodes: EpisodeDetails[] = [];
    const seen: Record<number, boolean> = {};

    for (let i = 0; i < starts.length; i++) {
      const current = starts[i];
      if (seen[current.number]) continue;

      const nextIndex = i + 1 < starts.length
        ? starts[i + 1].index
        : Math.min(html.length, current.index + 9000);
      const block = html.slice(current.index, nextIndex);
      const links = this.extractLinks(block, pageUrl);
      if (!links.length) continue;

      const globalNumber = offset + current.number;
      episodes.push(this.episodePayload(
        pageUrl,
        globalNumber,
        current.number,
        current.title,
        links,
        false,
      ));
      seen[current.number] = true;
    }

    return episodes.sort((a, b) => a.number - b.number);
  }

  private extractEpisodeAnchors(html: string, pageUrl: string, offset: number = 0): EpisodeDetails[] {
    const grouped: Record<number, { title: string; links: RareLink[] }> = {};
    const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = anchor.exec(html)) !== null) {
      const href = this.absoluteUrl(match[1], pageUrl);
      const label = this.stripTags(match[2]);
      const combined = label + " " + href.replace(/[-_]+/g, " ");
      const numberMatch = combined.match(/\b(?:episode|ep)\s*0*(\d{1,4})\b/i);
      if (!numberMatch) continue;

      const number = parseInt(numberMatch[1], 10);
      if (!number || number > 2000 || !/^https?:\/\//i.test(href)) continue;

      if (!grouped[number]) {
        grouped[number] = { title: this.cleanEpisodeTitle(label), links: [] };
      }

      if (!grouped[number].links.some((link) => link.url === href)) {
        grouped[number].links.push({
          name: this.normalizeServerName(label, href),
          url: href,
        });
      }
    }

    return Object.keys(grouped)
      .map((key) => parseInt(key, 10))
      .sort((a, b) => a - b)
      .map((number) => this.episodePayload(
        pageUrl,
        offset + number,
        number,
        grouped[number].title,
        grouped[number].links,
        false,
      ));
  }

  private parseEpisodeCount(html: string): number {
    const text = this.stripTags(html);
    const match = text.match(/\bEpisodes?\s*:\s*(\d{1,4})\b/i);
    return match ? parseInt(match[1], 10) : 0;
  }

  private async episodesFromIndex(
    indexUrl: string,
    referer: string,
    offset: number,
    expectedCount: number = 0,
  ): Promise<EpisodeDetails[]> {
    try {
      const response = await this.request(indexUrl, referer);
      const finalUrl = response.url || indexUrl;
      const html = await Promise.resolve(response.text());

      if (!this.isMatchingInternalRedirect(referer, finalUrl)) {
        console.log(
          "RareAnime: rejected unrelated index redirect " + finalUrl +
          " for " + referer
        );
        return [];
      }

      let episodes = this.extractEpisodes(html, finalUrl, offset);
      if (!episodes.length) {
        episodes = this.extractEpisodeAnchors(html, finalUrl, offset);
      }

      // A season page that declares 26 episodes must not be replaced by a
      // single accidental match from an unrelated index page. If an external
      // index does not yield a credible full list, fall back to placeholders
      // 1..N using the original season-level links.
      if (expectedCount > 1 && episodes.length > 0 && episodes.length !== expectedCount) {
        console.log(
          "RareAnime: rejected incomplete index list count=" + episodes.length +
          " expected=" + expectedCount +
          " from " + finalUrl
        );
        return [];
      }

      if (episodes.length) {
        console.log("RareAnime: index produced " + episodes.length + " episodes from " + finalUrl);
      }
      return episodes;
    } catch (error) {
      console.error("RareAnime: failed to parse episode index " + indexUrl, error);
      return [];
    }
  }

  private async findPageEpisodes(pageUrl: string, offset: number): Promise<PageEpisodeResult> {
    const response = await this.request(pageUrl);
    const html = await Promise.resolve(response.text());
    const content = this.postContent(html);
    const pageCount = this.parseEpisodeCount(content) || this.parseEpisodeCount(html);

    let episodes = this.extractEpisodes(content, pageUrl, offset);
    if (!episodes.length) {
      episodes = this.extractEpisodeAnchors(content, pageUrl, offset);
    }

    const pageLinks = this.extractLinks(content, pageUrl)
      .filter((link) => SERVER_NAMES.indexOf(link.name) >= 0 && link.name !== "Auto");

    // Some posts (for example current Naruto S1) only expose one
    // WatchMultiQuality/Mega season button. Follow the external index first.
    if (!episodes.length && pageLinks.length) {
      const priority = ["WatchMultiQuality", "StreamBeta", "HubCloud", "WatchNow", "DLBeta", "Mega"];
      const ordered: RareLink[] = [];

      for (const name of priority) {
        for (const link of pageLinks) {
          if (link.name === name && !ordered.some((item) => item.url === link.url)) {
            ordered.push(link);
          }
        }
      }

      for (const link of ordered.slice(0, 3)) {
        episodes = await this.episodesFromIndex(link.url, pageUrl, offset, pageCount);
        if (episodes.length) break;
      }
    }

    // If the external page hides its episode links behind JS, still return the
    // correct episode numbers. findEpisodeServer will reopen the batch/index
    // page for the selected episode and look for that episode there.
    if (!episodes.length && pageCount > 0 && pageLinks.length) {
      for (let local = 1; local <= pageCount; local++) {
        episodes.push(this.episodePayload(
          pageUrl,
          offset + local,
          local,
          "",
          pageLinks,
          true,
        ));
      }
    }

    let localCount = pageCount;
    if (!localCount && episodes.length) {
      localCount = Math.max.apply(null, episodes.map((episode) => {
        try {
          const data = JSON.parse(episode.id) as RareEpisodeId;
          return data.localNumber || data.number;
        } catch (_error) {
          return episode.number - offset;
        }
      }));
    }

    console.log(
      "RareAnime: page " + pageUrl +
      " -> episodes=" + episodes.length +
      " localCount=" + localCount
    );

    return { episodes, localCount };
  }

  async findEpisodes(id: string): Promise<EpisodeDetails[]> {
    const collection = this.parseCollectionId(id);

    if (collection) {
      const all: EpisodeDetails[] = [];
      let offset = 0;

      for (const pageUrl of collection.collection) {
        const result = await this.findPageEpisodes(pageUrl, offset);
        for (const episode of result.episodes) {
          if (!collection.expected || episode.number <= collection.expected) {
            all.push(episode);
          }
        }

        offset += result.localCount;
        if (collection.expected && offset >= collection.expected) break;
      }

      if (!all.length) {
        throw new Error("RareAnime: no playable episodes were found in the season collection");
      }

      return all.sort((a, b) => a.number - b.number);
    }

    const pageUrl = id.startsWith("http") ? id : this.absoluteUrl(id, BASE_URL);
    const result = await this.findPageEpisodes(pageUrl, 0);

    if (!result.episodes.length) {
      throw new Error("RareAnime: no playable episode links were found on this page");
    }
    return result.episodes;
  }

  private decodeScriptUrl(value: string): string {
    return this.decodeHtml(value)
      .replace(/\\\//g, "/")
      .replace(/\\u0026/gi, "&")
      .replace(/\\x26/gi, "&")
      .replace(/\\u003d/gi, "=")
      .replace(/\\x3d/gi, "=")
      .trim();
  }

  private mediaType(url: string): VideoSourceType {
    const clean = url.toLowerCase().split("?")[0];
    if (clean.endsWith(".m3u8")) return "m3u8";
    if (clean.endsWith(".mp4") || clean.endsWith(".webm")) return "mp4";
    return "unknown";
  }

  private extractDirectMedia(html: string, baseUrl: string): string[] {
    const results: string[] = [];
    const seen: Record<string, boolean> = {};

    const add = (raw: string) => {
      const decoded = this.decodeScriptUrl(raw);
      const url = this.absoluteUrl(decoded, baseUrl);
      if (!/^https?:\/\//i.test(url) || seen[url]) return;
      if (!/\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(url)) return;
      seen[url] = true;
      results.push(url);
    };

    const patterns = [
      /(?:file|source|src)\s*[:=]\s*["']([^"']+\.(?:m3u8|mp4|mkv|webm)(?:\?[^"']*)?)["']/gi,
      /<source\b[^>]*src=["']([^"']+)["']/gi,
      /["'](https?:\\?\/\\?\/[^"']+\.(?:m3u8|mp4|mkv|webm)(?:\?[^"']*)?)["']/gi,
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(html)) !== null) add(match[1]);
    }

    return results;
  }

  private extractFramesAndCandidates(html: string, baseUrl: string): string[] {
    const urls: string[] = [];
    const seen: Record<string, boolean> = {};

    const add = (raw: string) => {
      const url = this.absoluteUrl(this.decodeScriptUrl(raw), baseUrl);
      if (!/^https?:\/\//i.test(url) || seen[url] || this.isNoiseUrl(url)) return;

      // Once resolution has left RareAnimes, never crawl back through random
      // RareAnimes posts/navigation. Only direct media URLs are allowed back
      // on the source domain.
      if (
        url.startsWith(BASE_URL) &&
        !/\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(url) &&
        !/(?:\/watch|\/stream|\/player|\/redirect)/i.test(url)
      ) {
        return;
      }

      seen[url] = true;
      urls.push(url);
    };

    let match: RegExpExecArray | null;

    const iframe = /<iframe\b[^>]*src=["']([^"']+)["']/gi;
    while ((match = iframe.exec(html)) !== null) add(match[1]);

    const source = /<(?:a|form)\b[^>]*(?:href|action)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:a|form)>/gi;
    while ((match = source.exec(html)) !== null) {
      const label = this.stripTags(match[2] || "");
      if (/watch|stream|download|server|direct|continue|quality|link|episode|\bep\b/i.test(label)) {
        add(match[1]);
      }
    }

    const scripted = /(?:url|link|redirect|location(?:\.href)?)\s*[:=]\s*["']([^"']+)["']/gi;
    while ((match = scripted.exec(html)) !== null) {
      if (/^https?:|^\/\//i.test(this.decodeScriptUrl(match[1]))) add(match[1]);
    }

    const meta = /<meta\b[^>]*http-equiv=["']?refresh["']?[^>]*content=["'][^"']*url=([^"'>\s]+)[^"']*["'][^>]*>/gi;
    while ((match = meta.exec(html)) !== null) add(match[1]);

    return urls.slice(0, 20);
  }

  private async resolveMedia(startUrl: string, referer: string): Promise<{ url: string; referer: string }> {
    const queue: Array<{ url: string; referer: string; depth: number }> = [
      { url: startUrl, referer, depth: 0 },
    ];
    const visited: Record<string, boolean> = {};

    while (queue.length) {
      const item = queue.shift() as { url: string; referer: string; depth: number };
      if (visited[item.url] || item.depth > 7) continue;
      visited[item.url] = true;

      if (/\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(item.url)) {
        return { url: item.url, referer: item.referer };
      }

      try {
        const response = await this.request(item.url, item.referer);
        const finalUrl = response.url || item.url;

        if (/\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(finalUrl)) {
          return { url: finalUrl, referer: item.url };
        }

        const html = await Promise.resolve(response.text());
        const direct = this.extractDirectMedia(html, finalUrl);
        if (direct.length) return { url: direct[0], referer: finalUrl };

        const candidates = this.extractFramesAndCandidates(html, finalUrl);
        for (const candidate of candidates) {
          if (!visited[candidate]) {
            queue.push({
              url: candidate,
              referer: finalUrl,
              depth: item.depth + 1,
            });
          }
        }
      } catch (error) {
        console.error("RareAnime: failed resolving " + item.url, error);
      }
    }

    throw new Error("RareAnime: the selected host did not expose a direct playable stream");
  }

  private parseEpisodeId(id: string): RareEpisodeId | null {
    try {
      const parsed = JSON.parse(id);
      if (
        parsed &&
        typeof parsed.page === "string" &&
        typeof parsed.number === "number" &&
        Array.isArray(parsed.links)
      ) {
        return parsed as RareEpisodeId;
      }
    } catch (_error) {}
    return null;
  }

  private orderLinks(links: RareLink[], server: string): RareLink[] {
    const requested = (server || "Auto").toLowerCase().replace(/\s+/g, "");

    if (requested !== "auto") {
      return links.filter(
        (link) => link.name.toLowerCase().replace(/\s+/g, "") === requested
      );
    }

    const ordered: RareLink[] = [];
    const priority = ["WatchMultiQuality", "StreamBeta", "HubCloud", "WatchNow", "DLBeta", "Mega"];

    for (const name of priority) {
      for (const link of links) {
        if (link.name === name && !ordered.some((item) => item.url === link.url)) {
          ordered.push(link);
        }
      }
    }

    for (const link of links) {
      if (!ordered.some((item) => item.url === link.url)) ordered.push(link);
    }

    return ordered;
  }

  private async linksForBatchEpisode(
    batchLink: RareLink,
    data: RareEpisodeId,
  ): Promise<RareLink[]> {
    try {
      const response = await this.request(batchLink.url, data.page);
      const finalUrl = response.url || batchLink.url;
      const html = await Promise.resolve(response.text());
      const localNumber = data.localNumber || data.number;

      if (!this.isMatchingInternalRedirect(data.page, finalUrl)) {
        console.log(
          "RareAnime: rejected unrelated batch redirect " + finalUrl +
          " for episode " + localNumber
        );
        return [];
      }

      let episodes = this.extractEpisodes(html, finalUrl, 0);
      if (!episodes.length) episodes = this.extractEpisodeAnchors(html, finalUrl, 0);

      const match = episodes.find((episode) => {
        const parsed = this.parseEpisodeId(episode.id);
        return parsed && (parsed.localNumber || parsed.number) === localNumber;
      });

      if (match) {
        const parsed = this.parseEpisodeId(match.id);
        if (parsed && parsed.links.length) return parsed.links;
      }

      // Some linker pages open the chosen episode directly and expose a
      // player/iframe without a second episode list.
      const direct = this.extractDirectMedia(html, finalUrl);
      if (direct.length) {
        return direct.map((url) => ({ name: batchLink.name, url }));
      }

      return [];
    } catch (error) {
      console.error("RareAnime: batch lookup failed for " + batchLink.url, error);
      return [];
    }
  }

  private async recoverEpisodeData(episode: EpisodeDetails): Promise<RareEpisodeId> {
    const parsed = this.parseEpisodeId(episode.id);
    if (parsed && parsed.links.length) return parsed;

    if (episode.url) {
      const result = await this.findPageEpisodes(episode.url, 0);
      const found = result.episodes.find((item) => item.number === episode.number);
      if (found) {
        const recovered = this.parseEpisodeId(found.id);
        if (recovered) return recovered;
      }
    }

    throw new Error("RareAnime: invalid episode data");
  }

  async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
    const data = await this.recoverEpisodeData(episode);
    let candidates = this.orderLinks(data.links, server);

    if (!candidates.length) {
      throw new Error("RareAnime: server " + server + " is not available for this episode");
    }

    if (data.batch) {
      const expanded: RareLink[] = [];
      for (const batchLink of candidates) {
        const links = await this.linksForBatchEpisode(batchLink, data);
        for (const link of links) {
          if (!expanded.some((item) => item.url === link.url)) expanded.push(link);
        }
      }
      candidates = expanded;

      if (!candidates.length) {
        throw new Error(
          "RareAnime: episode " + (data.localNumber || data.number) +
          " was not found inside the batch/index page"
        );
      }
    }

    let lastError: any = null;

    for (const chosen of candidates) {
      try {
        console.log(
          "RareAnime: resolving episode " + data.number +
          " server=" + chosen.name +
          " url=" + chosen.url
        );

        const resolved = await this.resolveMedia(chosen.url, data.page);
        return {
          server: chosen.name,
          headers: {
            Referer: resolved.referer,
            "User-Agent": USER_AGENT,
          },
          videoSources: [
            {
              url: resolved.url,
              type: this.mediaType(resolved.url),
              quality: "auto",
              label: chosen.name,
              subtitles: [],
            },
          ],
        };
      } catch (error) {
        lastError = error;
        console.error("RareAnime: source failed for " + chosen.url, error);
      }
    }

    throw lastError || new Error("RareAnime: no playable source was resolved");
  }
}
