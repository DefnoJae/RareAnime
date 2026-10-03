// RareAnime online-stream provider for Seanime.
// Source site: https://www.rareanimes.mov/
//
// RareAnimes is a WordPress-style index which points episodes at third-party
// watch hosts. This provider searches RareAnimes, extracts episode links, then
// follows the selected watch host until it finds a playable media URL.

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
  title?: string;
  links: RareLink[];
}

const BASE_URL = "https://www.rareanimes.mov";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const SERVER_NAMES = [
  "Auto",
  "WatchMultiQuality",
  "HubCloud",
  "WatchNow",
  "StreamBeta",
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
      throw new Error(`RareAnime: HTTP ${response.status} for ${url}`);
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
    if (clean.startsWith("/")) return BASE_URL + clean;
    const origin = base.match(/^(https?:\/\/[^/]+)/i)?.[1] || BASE_URL;
    const directory = base.replace(/[?#].*$/, "").replace(/\/[^/]*$/, "/");
    if (clean.startsWith("./")) return directory + clean.slice(2);
    if (clean.startsWith("../")) return origin + "/" + clean.replace(/^(\.\.\/)+/, "");
    return directory + clean;
  }

  private normalizeTitle(value: string): string {
    return this.stripTags(value)
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[’']/g, "")
      .replace(/&/g, " and ")
      .replace(/\b(?:hindi|tamil|telugu|dubbed|download|watch|online|hd|web[- ]?dl)\b/g, " ")
      .replace(/[^a-z0-9]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private buildQueries(options: SearchOptions): string[] {
    const values = [
      options.query,
      options.media.englishTitle,
      options.media.romajiTitle,
      ...(options.media.synonyms || []),
    ];
    const output: string[] = [];
    const add = (v?: string) => {
      const q = (v || "").trim().replace(/\s+/g, " ");
      if (q && !output.some((x) => x.toLowerCase() === q.toLowerCase())) output.push(q);
    };
    for (const value of values) {
      add(value);
      if (!value) continue;
      add(value.replace(/\s+(?:season\s*\d+|\d+(?:st|nd|rd|th)\s+season)\s*$/i, ""));
      const colon = value.indexOf(":");
      if (colon > 0) add(value.slice(0, colon));
    }
    return output.slice(0, 5);
  }

  private score(title: string, options: SearchOptions): number {
    const candidate = this.normalizeTitle(title);
    if (!candidate) return 0;
    const targets = [
      options.query,
      options.media.englishTitle,
      options.media.romajiTitle,
      ...(options.media.synonyms || []),
    ].filter(Boolean).map((x) => this.normalizeTitle(x as string));

    let best = 0;
    for (const target of targets) {
      if (candidate === target) best = Math.max(best, 100);
      else if (candidate.includes(target) || target.includes(candidate)) best = Math.max(best, 82);
      else {
        const words = target.split(" ").filter((w) => w.length > 2);
        if (words.length) {
          const hits = words.filter((w) => candidate.includes(w)).length;
          best = Math.max(best, Math.round((hits / words.length) * 70));
        }
      }
    }

    if (options.year && title.includes(String(options.year))) best += 8;
    return best;
  }

  private extractSearchResults(html: string): Array<{ title: string; url: string }> {
    const found: Record<string, { title: string; url: string }> = {};
    const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = anchor.exec(html)) !== null) {
      const url = this.absoluteUrl(match[1]);
      const title = this.stripTags(match[2]);
      if (!title || !url.startsWith(BASE_URL)) continue;
      if (!/\/hindi\//i.test(url)) continue;
      if (/\/(?:category|tag|author|page)\//i.test(url)) continue;
      if (title.length < 3) continue;
      found[url] = { title, url };
    }
    return Object.keys(found).map((key) => found[key]);
  }

  async search(options: SearchOptions): Promise<SearchResult[]> {
    const queries = this.buildQueries(options);
    const all: Record<string, { title: string; url: string; score: number }> = {};

    for (const query of queries) {
      try {
        const response = await this.request(`${BASE_URL}/?s=${encodeURIComponent(query)}`);
        const html = await Promise.resolve(response.text());
        const rows = this.extractSearchResults(html);
        for (const row of rows) {
          const score = this.score(row.title, options);
          if (score >= 18 && (!all[row.url] || score > all[row.url].score)) {
            all[row.url] = { ...row, score };
          }
        }
        if (Object.keys(all).length > 0) break;
      } catch (error) {
        console.error(`RareAnime: search failed for "${query}"`, error);
      }
    }

    return Object.keys(all)
      .map((key) => all[key])
      .sort((a, b) => b.score - a.score)
      .slice(0, 15)
      .map((row) => ({
        id: row.url,
        title: row.title,
        url: row.url,
        subOrDub: "dub" as SubOrDub,
      }));
  }

  private normalizeServerName(label: string): string {
    const value = this.stripTags(label).replace(/\s+/g, "").toLowerCase();
    if (value.includes("watchmult")) return "WatchMultiQuality";
    if (value.includes("hubcloud")) return "HubCloud";
    if (value.includes("watchnow")) return "WatchNow";
    if (value.includes("streambeta")) return "StreamBeta";
    if (value.includes("dlbeta")) return "DLBeta";
    if (value.includes("mega")) return "Mega";
    return this.stripTags(label) || "Source";
  }

  private extractLinks(block: string): RareLink[] {
    const links: RareLink[] = [];
    const seen: Record<string, boolean> = {};
    const anchor = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = anchor.exec(block)) !== null) {
      const url = this.absoluteUrl(match[1]);
      const rawLabel = this.stripTags(match[2]);
      const name = this.normalizeServerName(rawLabel);
      if (!url || seen[url]) continue;
      if (url.startsWith(BASE_URL) && !/watch|stream|player|redirect/i.test(url)) continue;

      const useful =
        /watch|stream|hubcloud|dlbeta|mega|multi/i.test(rawLabel) ||
        !url.startsWith(BASE_URL);
      if (!useful) continue;

      seen[url] = true;
      links.push({ name, url });
    }
    return links;
  }

  private extractEpisodes(html: string, pageUrl: string): EpisodeDetails[] {
    const starts: Array<{ index: number; number: number; title: string }> = [];
    const episode = /Episode\s*0*(\d{1,4})\s*(?:[-–—:]\s*)?([^<\r\n]{0,180})/gi;
    let match: RegExpExecArray | null;

    while ((match = episode.exec(html)) !== null) {
      const number = parseInt(match[1], 10);
      if (!number || starts.some((x) => x.number === number && Math.abs(x.index - (match as RegExpExecArray).index) < 250)) continue;
      const title = this.stripTags(match[2] || "")
        .replace(/\b(?:Hindi|Tamil|Telugu|FanDub|NEw!?|Crunchyroll|AnimeTimes)\b.*$/i, "")
        .replace(/^[-–—:\s]+|[-–—:\s]+$/g, "")
        .trim();
      starts.push({ index: match.index, number, title });
    }

    const episodes: EpisodeDetails[] = [];
    const seen: Record<number, boolean> = {};

    for (let i = 0; i < starts.length; i++) {
      const current = starts[i];
      if (seen[current.number]) continue;
      const nextIndex = i + 1 < starts.length ? starts[i + 1].index : Math.min(html.length, current.index + 7000);
      const block = html.slice(current.index, nextIndex);
      const links = this.extractLinks(block);
      if (!links.length) continue;

      const payload: RareEpisodeId = {
        page: pageUrl,
        number: current.number,
        ...(current.title ? { title: current.title } : {}),
        links,
      };

      episodes.push({
        id: JSON.stringify(payload),
        number: current.number,
        url: pageUrl,
        ...(current.title ? { title: current.title } : {}),
      });
      seen[current.number] = true;
    }

    episodes.sort((a, b) => a.number - b.number);
    return episodes;
  }

  async findEpisodes(id: string): Promise<EpisodeDetails[]> {
    const pageUrl = id.startsWith("http") ? id : this.absoluteUrl(id);
    const response = await this.request(pageUrl);
    const html = await Promise.resolve(response.text());
    const episodes = this.extractEpisodes(html, pageUrl);

    if (!episodes.length) {
      throw new Error("RareAnime: no playable episode links were found on this page");
    }
    return episodes;
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
    if (clean.endsWith(".mp4") || clean.endsWith(".mkv") || clean.endsWith(".webm")) return "mp4";
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
      if (!/^https?:\/\//i.test(url) || seen[url]) return;
      seen[url] = true;
      urls.push(url);
    };

    let match: RegExpExecArray | null;
    const iframe = /<iframe\b[^>]*src=["']([^"']+)["']/gi;
    while ((match = iframe.exec(html)) !== null) add(match[1]);

    const source = /<(?:a|form)\b[^>]*(?:href|action)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:a|form)>/gi;
    while ((match = source.exec(html)) !== null) {
      const label = this.stripTags(match[2] || "");
      if (/watch|stream|download|server|direct|continue|quality|link/i.test(label)) add(match[1]);
    }

    const scripted = /(?:url|link|redirect|location(?:\.href)?)\s*[:=]\s*["']([^"']+)["']/gi;
    while ((match = scripted.exec(html)) !== null) {
      if (/^https?:|^\/\//i.test(this.decodeScriptUrl(match[1]))) add(match[1]);
    }

    return urls.slice(0, 12);
  }

  private async resolveMedia(startUrl: string, referer: string): Promise<{ url: string; referer: string }> {
    const queue: Array<{ url: string; referer: string; depth: number }> = [
      { url: startUrl, referer, depth: 0 },
    ];
    const visited: Record<string, boolean> = {};

    while (queue.length) {
      const item = queue.shift() as { url: string; referer: string; depth: number };
      if (visited[item.url] || item.depth > 6) continue;
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
            queue.push({ url: candidate, referer: finalUrl, depth: item.depth + 1 });
          }
        }
      } catch (error) {
        console.error(`RareAnime: failed resolving ${item.url}`, error);
      }
    }

    throw new Error("RareAnime: the selected host did not expose a direct playable stream");
  }

  private parseEpisodeId(id: string): RareEpisodeId {
    try {
      const parsed = JSON.parse(id);
      if (parsed?.page && parsed?.number && Array.isArray(parsed?.links)) return parsed as RareEpisodeId;
    } catch (_error) {}
    throw new Error("RareAnime: invalid episode data");
  }

  private selectLink(data: RareEpisodeId, server: string): RareLink {
    const requested = (server || "Auto").toLowerCase().replace(/\s+/g, "");
    if (requested !== "auto") {
      const exact = data.links.find(
        (link) => link.name.toLowerCase().replace(/\s+/g, "") === requested
      );
      if (exact) return exact;
    }

    const priority = ["WatchMultiQuality", "StreamBeta", "HubCloud", "WatchNow", "DLBeta", "Mega"];
    for (const name of priority) {
      const found = data.links.find((link) => link.name === name);
      if (found) return found;
    }
    return data.links[0];
  }

  async findEpisodeServer(episode: EpisodeDetails, server: string): Promise<EpisodeServer> {
    const data = this.parseEpisodeId(episode.id);
    const chosen = this.selectLink(data, server);
    if (!chosen) throw new Error("RareAnime: no watch link exists for this episode");

    const resolved = await this.resolveMedia(chosen.url, data.page);
    const type = this.mediaType(resolved.url);

    return {
      server: chosen.name,
      headers: {
        Referer: resolved.referer,
        "User-Agent": USER_AGENT,
      },
      videoSources: [
        {
          url: resolved.url,
          type,
          quality: "auto",
          label: chosen.name,
          subtitles: [],
        },
      ],
    };
  }
}
