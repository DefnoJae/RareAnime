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
  absoluteSeasonOffset?: number;
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
declare const Buffer: any;

interface RareLink {
  name: string;
  url: string;
  language?: string;
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

interface RareSelectionId {
  page: string;
  expected?: number;
  sourceOffset?: number;
  mediaId?: number;
  requestedPart?: number;
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

const AUDIO_LANGUAGES = ["Hindi", "Tamil", "Telugu", "English", "Japanese", "Malayalam", "Bengali"];

// Seanime calls findEpisodeServer once for every entry here, sequentially.
// RareAnimes often exposes 5+ mirrors for the same file, so advertising every
// host made each episode wait for several duplicate resolver chains. "Auto"
// already performs fallback internally and is much faster for first/next load.
const SERVER_NAMES = ["Auto"];

class Provider {
  private prequelEpisodeCache: Record<number, number> = {};

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

  private partNumber(value: string): number {
    const normalized = this.normalizeTitle(value);
    const match = normalized.match(/\b(?:part|cour)\s*0*(\d{1,3})\b/i);
    return match ? parseInt(match[1], 10) : 0;
  }

  private baseTitle(value: string): string {
    return this.normalizeTitle(value)
      .replace(/\b(?:season|part|cour)\s*0*\d{1,3}\b/g, " ")
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
    const output: string[] = [];
    // RareAnimes titles are overwhelmingly English. Seanime normally calls a
    // provider with romaji first and then English, so preferring AniList's
    // English title lets the first provider call hit the site title directly.
    const target = (options.media.englishTitle || options.query || "").trim();
    const callerQuery = (options.query || "").trim();

    const add = (value: string) => {
      const clean = value.trim().replace(/\s+/g, " ");
      if (clean && !output.some((item) => item.toLowerCase() === clean.toLowerCase())) {
        output.push(clean);
      }
    };

    if (!target) return output;

    const noPart = target
      .replace(/\s+(?:part|cour)\s*\d+\s*$/i, "")
      .trim();

    // Combined-season pages are much more common than dedicated cour pages.
    // Query the base title first for Part/Cour entries.
    if (noPart && noPart !== target) add(noPart);
    else add(target);

    // Exact English title is the first fallback for dedicated cour posts.
    if (noPart !== target) add(target);

    // Romaji/caller query is only a final fallback when it is genuinely
    // different. A strong English match exits the search loop before this.
    if (callerQuery && callerQuery.toLowerCase() !== target.toLowerCase()) add(callerQuery);

    return output.slice(0, 3);
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

  private parseSelectionId(id: string): RareSelectionId | null {
    try {
      const parsed = JSON.parse(id);
      if (parsed && typeof parsed.page === "string" && !Array.isArray(parsed.links)) {
        return parsed as RareSelectionId;
      }
    } catch (_error) {}
    return null;
  }

  private async prequelEpisodeCount(mediaId: number): Promise<number> {
    if (!mediaId) return 0;
    if (Object.prototype.hasOwnProperty.call(this.prequelEpisodeCache, mediaId)) {
      return this.prequelEpisodeCache[mediaId];
    }

    try {
      // Seanime's provider.d.ts declares absoluteSeasonOffset, but current
      // runtimes do not reliably send it. For split-cour AniList entries,
      // make one tiny metadata request so a combined RareAnimes season page
      // can be sliced at the real prequel episode count (e.g. 11 + 12).
      const response = await fetch("https://graphql.anilist.co", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          query: "query ($id: Int) { Media(id: $id, type: ANIME) { relations { edges { relationType node { id episodes format } } } } }",
          variables: { id: mediaId },
        }),
        redirect: "follow",
        timeout: 15,
      });

      if (!response.ok) throw new Error("HTTP " + response.status);
      const payload = await Promise.resolve(response.json<any>());
      const edges = payload?.data?.Media?.relations?.edges || [];
      const counts = edges
        .filter((edge: any) => edge?.relationType === "PREQUEL" && (edge?.node?.episodes || 0) > 0)
        .map((edge: any) => Number(edge.node.episodes))
        .filter((count: number) => count > 0);
      const count = counts.length ? Math.max.apply(null, counts) : 0;
      this.prequelEpisodeCache[mediaId] = count;
      return count;
    } catch (error) {
      console.error("RareAnime: could not resolve split-cour prequel offset", error);
      this.prequelEpisodeCache[mediaId] = 0;
      return 0;
    }
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

    // RareAnimes frequently splits one show into separate season pages.
    // When AniList/search is asking for the base show (no explicit season),
    // expose one stitched result and do not also expose Season 1 with the same
    // title; Seanime can otherwise auto-match the raw S1 row and hide later
    // seasons even though the collection result is present.
    const targets = this.buildTargets(options);
    const requestedSeason = targets
      .map((target) => this.seasonNumber(target))
      .filter((season) => season > 0)[0] || 0;
    const requestedPart = targets
      .map((target) => this.partNumber(target))
      .filter((part) => part > 0)[0] || 0;
    const sourceOffset = options.media.absoluteSeasonOffset || 0;

    let stitchedBase = "";

    if (!requestedSeason && requestedPart <= 1) {
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
        stitchedBase = top.baseTitle;

        results.push({
          id: JSON.stringify(collection),
          title: top.mappedTitle,
          url: seasons[0].url,
          subOrDub: "both",
        });
      }
    }

    for (const row of rows.slice(0, 12)) {
      if (stitchedBase && row.baseTitle === stitchedBase && row.season > 0) continue;
      if (requestedSeason && row.season > 0 && row.season !== requestedSeason) continue;
      const selection: RareSelectionId = {
        page: row.url,
        expected: options.media.episodeCount,
        sourceOffset,
        mediaId: options.media.id,
        requestedPart,
      };
      results.push({
        id: JSON.stringify(selection),
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
    if (value.indexOf("watchmulti") >= 0 || value.indexOf("watchmultquality") >= 0) return "WatchMultiQuality";
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

  private languageNear(block: string, index: number): string {
    const before = this.stripTags(block.slice(Math.max(0, index - 260), index));
    let best = "";
    let bestIndex = -1;
    for (const language of AUDIO_LANGUAGES) {
      const re = new RegExp("\\b" + language + "\\b", "ig");
      let match: RegExpExecArray | null;
      while ((match = re.exec(before)) !== null) {
        if (match.index >= bestIndex) {
          best = language;
          bestIndex = match.index;
        }
      }
    }
    return best;
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
        ...(this.languageNear(block, match.index) ? { language: this.languageNear(block, match.index) } : {}),
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

  private archiveLinks(html: string, baseUrl: string): RareLink[] {
    const links: RareLink[] = [];
    const seen: Record<string, boolean> = {};
    const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = anchor.exec(html)) !== null) {
      const url = this.absoluteUrl(match[1], baseUrl);
      if (
        !/^https?:\/\//i.test(url) ||
        seen[url] ||
        !/codedew\.com\/(?:zipper|zipcloud|streambeta|watchbeta)\//i.test(url)
      ) {
        continue;
      }

      const label = this.stripTags(match[2]) || "Watch";
      seen[url] = true;
      links.push({
        name: this.normalizeServerName(label, url),
        url,
      });
    }

    return links;
  }

  private archiveEpisodes(
    html: string,
    pageUrl: string,
    offset: number,
    expectedCount: number = 0,
  ): EpisodeDetails[] {
    const links = this.archiveLinks(html, pageUrl);
    if (!links.length) return [];

    // The store.animetoonhindi archive pages used by RareAnimes normally
    // contain one codedew link per episode in episode order. Prefer explicit
    // episode numbers from labels; otherwise use the stable document order.
    const numbered: Record<number, RareLink[]> = {};
    const unnumbered: RareLink[] = [];

    for (const link of links) {
      const numberMatch = (link.name + " " + link.url.replace(/[-_]+/g, " "))
        .match(/\b(?:episode|ep|e)\s*0*(\d{1,4})\b/i);

      if (numberMatch) {
        const number = parseInt(numberMatch[1], 10);
        if (!numbered[number]) numbered[number] = [];
        numbered[number].push(link);
      } else {
        unnumbered.push(link);
      }
    }

    const explicit = Object.keys(numbered)
      .map((key) => parseInt(key, 10))
      .filter((number) => number > 0)
      .sort((a, b) => a - b);

    if (explicit.length) {
      const episodes = explicit.map((local) =>
        this.episodePayload(pageUrl, offset + local, local, "", numbered[local], false)
      );
      if (!expectedCount || episodes.length === expectedCount) return episodes;
    }

    if (expectedCount > 0 && unnumbered.length >= expectedCount) {
      return unnumbered.slice(0, expectedCount).map((link, index) => {
        const local = index + 1;
        return this.episodePayload(pageUrl, offset + local, local, "", [link], false);
      });
    }

    // If the archive contains more than one codedew link but the site did not
    // expose a reliable count, ordinal mapping is still safer than treating
    // navigation text as episodes.
    if (!expectedCount && unnumbered.length > 1) {
      return unnumbered.map((link, index) => {
        const local = index + 1;
        return this.episodePayload(pageUrl, offset + local, local, "", [link], false);
      });
    }

    return [];
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
      if (!episodes.length) {
        episodes = this.archiveEpisodes(html, finalUrl, offset, expectedCount);
      }

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

    const selection = this.parseSelectionId(id);
    if (selection) {
      const needsOffset =
        (selection.requestedPart || 0) > 1 &&
        !(selection.sourceOffset || 0) &&
        !!selection.mediaId;

      // For split cours, fetch the RareAnimes page and the tiny AniList
      // relation lookup at the same time instead of adding their latencies.
      const [result, resolvedOffset] = await Promise.all([
        this.findPageEpisodes(selection.page, 0),
        needsOffset
          ? this.prequelEpisodeCount(selection.mediaId as number)
          : Promise.resolve(selection.sourceOffset || 0),
      ]);

      if (!result.episodes.length) {
        throw new Error("RareAnime: no playable episode links were found on this page");
      }

      const expected = selection.expected || 0;
      const sourceOffset = resolvedOffset || selection.sourceOffset || 0;

      if (sourceOffset && needsOffset) {
        console.log(
          "RareAnime: split-cour media " + selection.mediaId +
          " will start after source episode " + sourceOffset
        );
      }

      let episodes = result.episodes.slice();

      // Only apply a cour offset when the RareAnimes page is actually a
      // combined season. If the site has a dedicated Part/Cour page whose
      // episode count already fits AniList, leave its local 1..N numbering.
      if (sourceOffset > 0 && (!expected || result.localCount > expected)) {
        episodes = episodes.filter((episode) => {
          const parsed = this.parseEpisodeId(episode.id);
          const local = parsed?.localNumber || parsed?.number || episode.number;
          return local > sourceOffset && (!expected || local <= sourceOffset + expected);
        });
      } else if (expected > 0 && episodes.length > expected) {
        episodes = episodes.slice(0, expected);
      }

      if (!episodes.length) {
        throw new Error("RareAnime: the matched page did not contain this cour's episode range");
      }

      return episodes.map((episode, index) => ({
        ...episode,
        number: index + 1,
      }));
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

  private queryParam(url: string, key: string): string {
    const query = url.split("?")[1]?.split("#")[0] || "";
    for (const part of query.split("&")) {
      const index = part.indexOf("=");
      const rawKey = index >= 0 ? part.slice(0, index) : part;
      const rawValue = index >= 0 ? part.slice(index + 1) : "";
      if (decodeURIComponent(rawKey) === key) {
        try {
          return decodeURIComponent(rawValue.replace(/\+/g, " "));
        } catch (_error) {
          return rawValue;
        }
      }
    }
    return "";
  }

  private async manualRequest(url: string, referer?: string): Promise<FetchResponse> {
    return fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": USER_AGENT,
        ...(referer ? { Referer: referer } : {}),
      },
      redirect: "manual",
      timeout: 30,
    });
  }

  private juicyBlob(html: string): string | null {
    const call = html.match(/_juicycodes\(([\s\S]*?)\);?/i);
    if (!call) return null;

    const parts: string[] = [];
    const stringPart = /"([^"]*)"/g;
    let match: RegExpExecArray | null;
    while ((match = stringPart.exec(call[1])) !== null) parts.push(match[1]);
    return parts.length ? parts.join("") : null;
  }

  private decodeJuicy(blob: string): string {
    if (blob.length <= 3) throw new Error("RareAnime: JuicyCodes blob is too short");

    const tail = blob.slice(-3);
    let saltText = "";
    for (let i = 0; i < tail.length; i++) {
      saltText += String(tail.charCodeAt(i) - 100);
    }
    const salt = parseInt(saltText, 10);

    let body = blob.slice(0, -3).replace(/_/g, "+").replace(/-/g, "/");
    while (body.length % 4 !== 0) body += "=";

    // Seanime's goja Buffer implementation does not support the Node
    // "latin1" encoding name. Work with the decoded bytes directly instead;
    // JuicyCodes only uses the ten ASCII symbols below.
    const decodedBytes = Uint8Array.from(Buffer.from(body, "base64"));
    const symbols = ["\x60", "%", "-", "+", "*", "$", "!", "_", "^", "="];
    let digits = "";

    for (let i = 0; i < decodedBytes.length; i++) {
      const ch = String.fromCharCode(decodedBytes[i]);
      const index = symbols.indexOf(ch);
      if (index < 0) {
        throw new Error("RareAnime: unexpected JuicyCodes symbol");
      }
      digits += String(index);
    }

    if (digits.length % 4 !== 0) {
      throw new Error("RareAnime: JuicyCodes stream is misaligned");
    }

    let output = "";
    for (let i = 0; i < digits.length; i += 4) {
      output += String.fromCharCode((parseInt(digits.slice(i, i + 4), 10) % 1000) - salt);
    }
    return output;
  }

  private async resolveArgon(code: string): Promise<{ url: string; referer: string }> {
    const embedUrl = "https://argon.razorshell.space/embed/" + encodeURIComponent(code);
    const response = await fetch(embedUrl, {
      headers: {
        Accept: "text/html,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        Referer: "https://codedew.com/",
        "User-Agent": USER_AGENT,
      },
      redirect: "follow",
      timeout: 30,
    });

    if (!response.ok) {
      throw new Error("RareAnime: Argon returned HTTP " + response.status);
    }

    const html = await Promise.resolve(response.text());
    const blob = this.juicyBlob(html);
    if (!blob) {
      const direct = this.extractDirectMedia(html, embedUrl);
      if (direct.length) return { url: direct[0], referer: "https://argon.razorshell.space/" };
      throw new Error("RareAnime: Argon embed has no JuicyCodes payload");
    }

    const decoded = this.decodeJuicy(blob);
    const hlsMatch = decoded.match(/["']file["']\s*:\s*["']([^"']+\.m3u8(?:\?[^"']*)?)["']/i);
    if (!hlsMatch) throw new Error("RareAnime: Argon config has no HLS source");

    return {
      url: hlsMatch[1].replace(/\\\//g, "/"),
      referer: "https://argon.razorshell.space/",
    };
  }

  private async resolveStreamBeta(id: string): Promise<{ url: string; referer: string }> {
    const pageUrl = "https://codedew.com/streambeta/?url=" + encodeURIComponent(id);
    const response = await this.request(pageUrl, "https://codedew.com/");
    const html = await Promise.resolve(response.text());
    const match = html.match(/playerSources\s*=\s*(\[[\s\S]*?\])\s*;/i);
    if (!match) throw new Error("RareAnime: StreamBeta has no playerSources");

    let sources: any[] = [];
    try {
      sources = JSON.parse(match[1]);
    } catch (_error) {
      throw new Error("RareAnime: StreamBeta sources could not be decoded");
    }

    for (const source of sources) {
      const stream = typeof source?.streamUrl === "string" ? source.streamUrl : "";
      if (/^https?:\/\//i.test(stream)) {
        return { url: stream, referer: pageUrl };
      }

      const download = typeof source?.url === "string" ? source.url : "";
      const pd = download.match(/pixeldrain\.(?:net|dev)\/u\/([A-Za-z0-9]+)/i);
      if (pd) {
        return {
          url: "https://pixeldrain.net/api/file/" + pd[1],
          referer: "https://pixeldrain.net/",
        };
      }
      if (/^https?:\/\//i.test(download) && !/mega\.(?:nz|io)/i.test(download)) {
        return { url: download, referer: pageUrl };
      }
    }

    throw new Error("RareAnime: StreamBeta has no direct source");
  }

  private async resolveCodedew(startUrl: string, referer: string): Promise<{ url: string; referer: string }> {
    let current = this.decodeHtml(startUrl).replace(/&amp;/g, "&");
    let currentReferer = referer || "https://codedew.com/";

    for (let hop = 0; hop < 10; hop++) {
      const directType = this.mediaType(current);
      if (directType !== "unknown") return { url: current, referer: currentReferer };

      if (/codedew\.com\/multiquality\//i.test(current)) {
        const code = this.queryParam(current, "url");
        if (!code) throw new Error("RareAnime: MultiQuality URL has no id");
        return this.resolveArgon(code);
      }

      if (/codedew\.com\/streambeta\//i.test(current)) {
        const id = this.queryParam(current, "url");
        if (!id) throw new Error("RareAnime: StreamBeta URL has no id");
        return this.resolveStreamBeta(id);
      }

      if (/codedew\.com\/watchbeta\//i.test(current)) {
        const id = this.queryParam(current, "url");
        if (!id) throw new Error("RareAnime: WatchBeta URL has no id");
        return {
          url: "https://pixeldrain.net/api/file/" + encodeURIComponent(id),
          referer: "https://pixeldrain.net/",
        };
      }

      const argon = current.match(/argon\.razorshell\.space\/embed\/([A-Za-z0-9]+)/i);
      if (argon) return this.resolveArgon(argon[1]);

      const response = await this.manualRequest(current, currentReferer);
      const status = response.status;

      if (status >= 300 && status < 400) {
        const location = response.headers?.["location"] || response.headers?.["Location"] || "";
        if (!location) throw new Error("RareAnime: codedew redirect has no Location");
        const next = this.absoluteUrl(this.decodeHtml(location), current);
        currentReferer = current;
        current = next;
        continue;
      }

      if (status < 200 || status >= 300) {
        throw new Error("RareAnime: codedew returned HTTP " + status);
      }

      const html = await Promise.resolve(response.text());
      const direct = this.extractDirectMedia(html, current);
      if (direct.length) return { url: direct[0], referer: current };

      const embed = html.match(/<iframe\b[^>]*src=["'](https?:\/\/[^"']*argon[^"']*\/embed\/([A-Za-z0-9]+)[^"']*)["']/i);
      if (embed) return this.resolveArgon(embed[2]);

      const dataHref = html.match(/\bdata-href=["']([^"']+)["']/i);
      if (dataHref) {
        const next = this.absoluteUrl(this.decodeHtml(dataHref[1]), current);
        currentReferer = current;
        current = next;
        continue;
      }

      const candidates = this.extractFramesAndCandidates(html, current)
        .filter((url) =>
          /codedew\.com\/(?:multiquality|streambeta|watchbeta|zipper|zipcloud)\//i.test(url) ||
          /argon\.razorshell\.space\/embed\//i.test(url) ||
          /\.(?:m3u8|mp4|webm)(?:[?#]|$)/i.test(url)
        );

      if (candidates.length) {
        currentReferer = current;
        current = candidates[0];
        continue;
      }

      throw new Error("RareAnime: codedew page exposed no playable target");
    }

    throw new Error("RareAnime: codedew redirect chain is too deep");
  }

  private async resolveMedia(startUrl: string, referer: string): Promise<{ url: string; referer: string }> {
    if (/codedew\.com\/(?:zipper|multiquality|streambeta|watchbeta|zipcloud)\//i.test(startUrl)) {
      return this.resolveCodedew(startUrl, referer);
    }

    const queue: Array<{ url: string; referer: string; depth: number }> = [
      { url: startUrl, referer, depth: 0 },
    ];
    const visited: Record<string, boolean> = {};

    while (queue.length) {
      const item = queue.shift() as { url: string; referer: string; depth: number };
      if (visited[item.url] || item.depth > 7) continue;
      visited[item.url] = true;

      if (this.isNoiseUrl(item.url)) continue;

      if (/codedew\.com\/(?:zipper|multiquality|streambeta|watchbeta|zipcloud)\//i.test(item.url)) {
        try {
          return await this.resolveCodedew(item.url, item.referer);
        } catch (error) {
          console.error("RareAnime: codedew resolution failed for " + item.url, error);
          continue;
        }
      }

      if (/\.(?:m3u8|mp4|mkv|webm)(?:[?#]|$)/i.test(item.url)) {
        return { url: item.url, referer: item.referer };
      }

      try {
        const response = await this.request(item.url, item.referer);
        const finalUrl = response.url || item.url;

        if (/codedew\.com\/(?:zipper|multiquality|streambeta|watchbeta|zipcloud)\//i.test(finalUrl)) {
          return await this.resolveCodedew(finalUrl, item.url);
        }

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
    const requestedRaw = server || "Auto";
    const requested = requestedRaw.toLowerCase().replace(/\s+/g, "");
    const requestedLanguage = AUDIO_LANGUAGES.find(
      (language) => language.toLowerCase() === requested
    );

    const canonicalLinks = links.map((link) => ({
      ...link,
      name: this.normalizeServerName(link.name, link.url),
    }));

    let pool = canonicalLinks;
    if (requestedLanguage) {
      const exact = canonicalLinks.filter(
        (link) => (link.language || "").toLowerCase() === requestedLanguage.toLowerCase()
      );
      if (!exact.length) return [];
      pool = exact;
    } else if (requested !== "auto") {
      return canonicalLinks.filter(
        (link) => link.name.toLowerCase().replace(/\s+/g, "") === requested
      );
    }

    const ordered: RareLink[] = [];
    const priority = ["WatchMultiQuality", "StreamBeta", "HubCloud", "WatchNow", "DLBeta", "Mega"];

    for (const name of priority) {
      for (const link of pool) {
        if (link.name === name && !ordered.some((item) => item.url === link.url)) {
          ordered.push(link);
        }
      }
    }

    for (const link of pool) {
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

      // store.animetoonhindi archive pages are the important special case:
      // their rows are often just ordered codedew zipper links without
      // "Episode 01" text. Map the requested episode by document order.
      const archived = this.archiveLinks(html, finalUrl);
      if (archived.length >= localNumber) {
        const chosen = archived[localNumber - 1];
        console.log(
          "RareAnime: archive mapped episode " + localNumber +
          " -> " + chosen.url
        );
        return [{
          name: batchLink.name || chosen.name,
          url: chosen.url,
        }];
      }

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
        const playbackHeaders: Record<string, string> = {
          Referer: resolved.referer,
          "User-Agent": USER_AGENT,
        };

        // Argon HLS is sensitive to the same browser-ish headers used by its
        // embed page. Preserve them for Seanime/MPV when requesting the
        // master playlist and its segments.
        if (resolved.referer.indexOf("argon.razorshell.space") >= 0) {
          playbackHeaders["Origin"] = "https://argon.razorshell.space";
          playbackHeaders["Accept"] = "*/*";
          playbackHeaders["Accept-Language"] = "en-US,en;q=0.9";
        }

        console.log(
          "RareAnime: resolved episode " + data.number +
          " -> " + this.mediaType(resolved.url) +
          " " + resolved.url
        );

        return {
          server: AUDIO_LANGUAGES.indexOf(server) >= 0 ? server : chosen.name,
          headers: playbackHeaders,
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
