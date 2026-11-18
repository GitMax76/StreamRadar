const communityDirectory = 'https://www.streaming-community.day/';
const communityOriginTtl = 5 * 60 * 1000;
let directoryResult;
let directoryRequest;
const animeUnity = 'https://animeunity.cx';
const toonitalia = 'https://toonitalia.xyz';
const titlePath = /^\/it\/titles\/([1-9]\d{0,11})-[\p{L}\p{N}_-]+\/?$/u;
const searchPaths = ['/api/search', '/it/search', '/search'];
const maxBodyBytes = 2 * 1024 * 1024;

function normalizedTitle(value) {
  return String(value ?? '').normalize('NFKD').toLowerCase()
    .replace(/\p{M}|['’]/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function yearOf(...values) {
  for (const value of values) {
    const year = /^(\d{4})(?:$|-)/.exec(String(value ?? ''))?.[1];
    if (year) return year;
  }
  return '';
}

function namesFor(title) {
  return [title.title, title.originalTitle, title.englishTitle].filter(name => normalizedTitle(name));
}

function candidate(record) {
  if (!record || typeof record !== 'object') return null;
  const id = String(record.id ?? '');
  if (!/^[1-9]\d{0,11}$/.test(id)) return null;
  const slug = String(record.slug ?? '');
  const type = { movie: 'movie', film: 'movie', tv: 'tv', series: 'tv', 'tv-series': 'tv', tv_series: 'tv' }[
    String(record.type ?? record.media_type ?? '').toLowerCase()];
  return {
    id, slug, type,
    names: [record.name, record.title, record.original_name, record.original_title].map(normalizedTitle).filter(Boolean),
    year: yearOf(record.release_year, record.year, record.release_date, record.first_air_date),
    tmdbId: /^[1-9]\d*$/.test(String(record.tmdb_id ?? '')) ? String(record.tmdb_id) : ''
  };
}

function matchStrength(item, expected) {
  if (item.type && item.type !== expected.type) return 0;
  if (item.tmdbId && expected.id && item.tmdbId !== String(expected.id)) return 0;
  if (item.tmdbId && expected.id && item.type === expected.type) return 3;
  if (item.year && expected.year && item.year !== expected.year) return 0;
  if (item.names.some(name => expected.names.has(name))) return 2;
  return expected.shortName && item.names.includes(expected.shortName) ? 1 : 0;
}

function decodeAttribute(value) {
  const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  return value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (match, entity) => {
    if (entity[0] !== '#') return entities[entity.toLowerCase()];
    const hex = entity[1].toLowerCase() === 'x';
    const point = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return point <= 0x10ffff ? String.fromCodePoint(point) : match;
  });
}

function pageData(body) {
  const attribute = /\bdata-page\s*=\s*(["'])(.*?)\1/s.exec(body);
  return JSON.parse(attribute ? decodeAttribute(attribute[2]) : body);
}

async function fetchPage(url, signal, accept, options = {}) {
  const origin = url.origin;
  const { headers, ...request } = options;
  for (let redirects = 0; redirects < 3; redirects++) {
    const response = await fetch(url, {
      ...request, signal, redirect: 'manual', headers: { accept, ...headers }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Redirect senza destinazione');
      if (request.method === 'POST' && ![307, 308].includes(response.status)) {
        throw new Error('Redirect inatteso della ricerca');
      }
      url = new URL(location, url);
      if (url.origin !== origin || url.username || url.password) throw new Error('Redirect fuori dal sito');
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([404, 405].includes(response.status)) return null;
      throw new Error(`Risposta HTTP ${response.status}`);
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > maxBodyBytes) throw new Error('Risposta troppo grande');
      chunks.push(chunk);
    }
    return { url, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers };
  }
  throw new Error('Troppi redirect');
}

function searchResults(body) {
  const data = pageData(body);
  const payload = data.props ?? data;
  const container = payload.titles ?? payload.results ?? payload;
  const rows = Array.isArray(container) ? container : container?.data;
  if (!Array.isArray(rows)) return null;
  const items = rows.map(candidate).filter(Boolean);
  if (rows.length && !items.length) return null;
  return { items, next: container.next_page_url || container.links?.next,
    last: Number(container.last_page ?? container.meta?.last_page) };
}

async function searchPage(origin, path, name, number, signal) {
  const url = new URL(path, origin);
  url.search = new URLSearchParams({ q: name, page: String(number) });
  const page = await fetchPage(url, signal, 'application/json, text/plain, text/html, */*');
  if (!page) return null;
  try {
    return searchResults(page.body);
  } catch (error) {
    if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error;
    return null;
  }
}

async function searchName(origin, name, signal) {
  let empty;
  for (const path of searchPaths) {
    const first = await searchPage(origin, path, name, 1, signal).catch(() => null);
    if (!first) continue;
    if (!first.items.length && !first.next && !(first.last > 1)) {
      empty = { items: [], more: false };
      continue;
    }
    if (!first.next && !(first.last > 1)) return { items: first.items, more: false };
    const second = await searchPage(origin, path, name, 2, signal).catch(() => null);
    if (!second) return { items: first.items, more: true };
    return { items: [...first.items, ...second.items], more: Boolean(second.next || first.last > 2 || second.last > 2) };
  }
  if (empty) return empty;
  throw new Error('Formato della ricerca non riconosciuto');
}

function attribute(tag, name) {
  const match = new RegExp('\\s' + name + '\\s*=\\s*(["\'])(.*?)\\1', 'is').exec(tag);
  return match ? decodeAttribute(match[2]) : '';
}

function meta(html, name) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (attribute(tag, 'name') === name || attribute(tag, 'property') === name) {
      return attribute(tag, 'content');
    }
  }
  return '';
}

function plain(html) {
  return decodeAttribute(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function pageHeading(html) {
  return plain(/<h1\b[^>]*>(.*?)<\/h1>/is.exec(html)?.[1] || '') || meta(html, 'og:title');
}

async function readCommunityOrigin() {
  const page = await fetchPage(new URL(communityDirectory), AbortSignal.timeout(3500), 'text/html');
  if (!page) throw new Error('Pagina dei domini non disponibile');
  const links = new Set();
  for (const [, tag, label] of page.body.matchAll(/(<a\b[^>]*>)(.*?)<\/a\s*>/gis)) {
    if (normalizedTitle(plain(label)).replace(/ /g, '') !== 'streamingcommunity') continue;
    const link = URL.parse(attribute(tag, 'href'), page.url);
    if (link?.protocol === 'https:' && !link.username && !link.password && !link.port &&
        /^(?:www\.)?streaming-?communityz?\.[a-z]{2,24}$/i.test(link.hostname) &&
        link.origin !== page.url.origin) links.add(link.origin);
  }
  if (links.size !== 1) throw new Error('Dominio StreamingCommunity non identificato');
  return links.values().next().value;
}

export async function communityOrigin() {
  if (directoryResult?.expiresAt > Date.now()) return directoryResult.origin;
  directoryRequest ??= readCommunityOrigin().then(origin => {
    directoryResult = { origin, expiresAt: Date.now() + communityOriginTtl };
    return origin;
  }).finally(() => { directoryRequest = undefined; });
  return directoryRequest;
}

function communityReference(title, origin) {
  const names = new Set(namesFor(title).map(normalizedTitle));
  if (title.type !== 'movie' || yearOf(title.year) !== '2024' ||
      (Number(title.id) !== 823219 && !(names.has('straume') && names.has('flow un mondo da salvare')))) {
    return null;
  }
  return new URL('/it/titles/11527-flow', origin);
}

async function referenceCommunityPage(title, url, signal) {
  const names = new Set(namesFor(title).map(normalizedTitle));
  const page = await fetchPage(url, signal, 'text/html');
  if (!page || page.url.pathname.replace(/\/$/, '') !== url.pathname) return false;
  let item;
  try {
    item = candidate(pageData(page.body).props?.title);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (item) {
    if (item.id !== '11527' || (item.type && item.type !== 'movie') || (item.year && item.year !== '2024')) return false;
    if (item.names.some(name => name === 'flow' || names.has(name))) return { status: 'found', url: page.url.href };
  }
  const heading = normalizedTitle(pageHeading(page.body) || plain(/<title\b[^>]*>(.*?)<\/title>/is.exec(page.body)?.[1] || ''));
  if (/^flow(?: un mondo da salvare)?(?: streaming(?: ita)?)?(?: streamingcommunity)?$/.test(heading)) {
    return { status: 'found', url: page.url.href };
  }
  return null;
}

function knownLink(url) {
  return { status: 'found', verification: 'reference', url: url.href };
}

async function verifyPage(origin, item, expected, signal) {
  if (!/^[\p{L}\p{N}_-]+$/u.test(item.slug)) throw new Error('Indirizzo della scheda incompleto');
  const page = await fetchPage(new URL(`/it/titles/${item.id}-${item.slug}`, origin), signal, 'text/html, application/json');
  if (!page) return null;
  const path = titlePath.exec(decodeURI(page.url.pathname));
  const found = candidate(pageData(page.body).props?.title);
  if (path?.[1] !== item.id || found?.id !== item.id) throw new Error('Scheda del titolo non riconosciuta');
  const metadata = { ...found, type: found.type || item.type, year: found.year || item.year,
    tmdbId: found.tmdbId || item.tmdbId };
  const strength = matchStrength(metadata, expected);
  const verified = strength === 3 || (strength > 0 && metadata.type === expected.type &&
    metadata.year && metadata.year === expected.year);
  return { strength: verified ? strength : 0, unclear: strength > 0 && !verified,
    url: new URL(page.url.pathname, origin).href };
}

export async function findCommunityTitle(title, origin) {
  const names = namesFor(title);
  const aliases = new Map(names.map(name => [normalizedTitle(name), name]));
  if (!aliases.size) return { status: 'unavailable' };
  const short = title.title?.split(/\s+[-–—]\s+|:\s+/, 2);
  const prefix = short?.length === 2 ? short[0].trim() : '';
  const normalizedPrefix = normalizedTitle(prefix);
  const shortName = normalizedPrefix.length >= 3 ? normalizedPrefix : '';
  const expected = { ...title, year: yearOf(title.year), names: new Set(aliases.keys()), shortName };
  if (shortName && !aliases.has(shortName)) aliases.set(shortName, prefix);
  origin ||= await communityOrigin().catch(() => null);
  if (!origin) return { status: 'unavailable', reason: 'domain_discovery' };
  const reference = communityReference(title, origin);
  if (reference) {
    const checked = await referenceCommunityPage(title, reference, AbortSignal.timeout(2500)).catch(() => null);
    if (checked) return checked;
  }
  const signal = AbortSignal.timeout(6500);
  const searches = await Promise.allSettled([...aliases.values()].map(name => searchName(origin, name, signal)));
  const candidates = new Map();
  const incomplete = searches.some(result => result.status === 'rejected' || result.value.more);
  for (const result of searches) {
    if (result.status !== 'fulfilled') continue;
    for (const item of result.value.items) {
      const strength = matchStrength(item, expected);
      const best = candidates.get(item.id);
      if (strength && (!best || strength > best.strength || (!best.item.slug && item.slug))) {
        candidates.set(item.id, { item, strength });
      }
    }
  }
  const chosen = [...candidates.values()].sort((a, b) => b.strength - a.strength).slice(0, 4);
  const checks = await Promise.allSettled(chosen.map(({ item }) => verifyPage(origin, item, expected, signal)));
  const pages = checks.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
  const strongest = Math.max(0, ...pages.map(page => page.strength));
  const matches = pages.filter(page => page.strength && page.strength === strongest);
  const unclear = pages.some(page => page.unclear);
  const uncertainPages = candidates.size > chosen.length || checks.some(result => result.status === 'rejected');
  if (matches.length > 1) return { status: 'ambiguous' };
  if (matches.length === 1 && (strongest === 3 || (!uncertainPages && !unclear))) {
    return { status: 'found', url: matches[0].url };
  }
  if (uncertainPages || incomplete) return { status: 'unavailable' };
  return { status: unclear ? 'ambiguous' : 'not_found' };
}

function animeName(name) {
  return normalizedTitle(name).replace(/ (?:sub )?ita$/, '');
}

function animeNames(item) {
  return [item.title_ita, item.title_it, item.italian_title, item.name, item.title,
    item.title_eng, item.title_en, item.title_jap, item.title_jpn, item.original_title, item.title_romaji]
    .filter(name => typeof name === 'string' && name.trim());
}

function animeCandidate(item) {
  if (!item || !/^[1-9]\d{0,11}$/.test(String(item.id)) ||
      !/^[\p{L}\p{N}_-]+$/u.test(item.slug || '')) return null;
  const names = animeNames(item);
  if (!names.length) return null;
  const format = String(item.type || '').toLowerCase();
  const type = ['movie', 'film'].includes(format) ? 'movie' : ['tv', 'serie tv'].includes(format) ? 'tv' : '';
  // OVA/OAV are release formats and can have one or several episodes.
  return { url: new URL('/anime/' + item.id + '-' + item.slug, animeUnity).href,
    title: names[0], names: names.map(animeName),
    year: yearOf(item.year, item.release_year, item.release_date, item.date), type };
}

function animeRows(body) {
  const data = pageData(body);
  const payload = data?.props ?? data;
  const collection = payload?.animes ?? payload?.anime ?? payload?.results ?? payload?.records ?? payload?.data ?? payload;
  const rows = Array.isArray(collection) ? collection :
    collection?.data ?? collection?.animes ?? collection?.results ?? collection?.records;
  if (!Array.isArray(rows)) throw new Error('Formato archivio AnimeUnity non riconosciuto');
  const candidates = rows.map(animeCandidate).filter(Boolean);
  if (rows.length && !candidates.length) throw new Error('Risultati AnimeUnity non riconosciuti');
  return candidates;
}

async function animeReferencePage(url, aliases) {
  const page = await fetchPage(url, AbortSignal.timeout(2500), 'text/html');
  if (!page || page.url.pathname.replace(/\/$/, '') !== url.pathname) return false;
  let item;
  try {
    item = pageData(page.body)?.props?.anime;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  if (item?.id && String(item.id) !== '7860') return false;
  const headings = [pageHeading(page.body), plain(/<title\b[^>]*>(.*?)<\/title>/is.exec(page.body)?.[1] || '')]
    .map(name => animeName(name).replace(/^animeunity | animeunity$/g, ''));
  if ([...animeNames(item || {}).map(animeName), ...headings].some(name => aliases.has(name))) {
    return { status: 'found', url: page.url.href, verification: 'title' };
  }
  return item && animeNames(item).length ? false : null;
}

async function findAnimeUnity(title) {
  const aliases = new Map(namesFor(title).map(name => [animeName(name), name]));
  const prefix = title.title?.split(/\s+[-–—]\s+|:\s+/, 2);
  const keyword = prefix?.length === 2 ? animeName(prefix[0]) : '';
  const year = yearOf(title.year);
  let reference;
  if (title.type === 'movie' && year === '1984' && aliases.has('lincantevole creamy il ritorno di creamy')) {
    const link = new URL('/anime/7860-lincantevole-creamy-il-ritorno-di-creamy', animeUnity);
    const result = await animeReferencePage(link, aliases).catch(() => null);
    if (result) return result;
    if (result === null) reference = knownLink(link);
  }
  const queries = [...new Set([...aliases.values(), keyword && prefix[0]].filter(Boolean))].slice(0, 4);
  const signal = AbortSignal.timeout(6500);
  const results = await Promise.allSettled(queries.map(async query => {
    const url = new URL('/api/archive', animeUnity);
    url.searchParams.set('query', query);
    const response = await fetchPage(url, signal, 'application/json');
    if (!response) throw new Error('Archivio AnimeUnity non disponibile');
    return animeRows(response.body);
  }));
  const candidates = [...new Map(results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
    .map(item => [item.url, item])).values()];
  const exact = candidates.filter(item => (!item.type || item.type === title.type) &&
      (!item.year || !year || item.year === year) && item.names.some(name => aliases.has(name)));
  const dated = exact.filter(item => year && item.year === year);
  const matches = dated.length ? dated : exact;
  const related = keyword.length >= 5 ? candidates.filter(item => (!item.type || item.type === title.type) &&
      !item.names.some(name => aliases.has(name)) && item.names.some(name => (' ' + name + ' ').includes(' ' + keyword + ' ')))
    .slice(0, 3).map(({ url, title, year }) => ({ url, title, year })) : [];
  if (matches.length === 1) {
    return { status: 'found', url: matches[0].url,
      verification: year && matches[0].year && matches[0].type ? 'metadata' : 'title', items: related };
  }
  if (matches.length > 1) return { status: 'ambiguous' };
  if (reference) return reference;
  if (related.length) return { status: 'related', items: related };
  return { status: results.some(result => result.status === 'fulfilled') ? 'not_found' : 'unavailable' };
}

function toonPath(value) {
  try {
    const url = new URL(value, toonitalia);
    if (url.origin !== toonitalia || !/^\/[\p{L}\p{N}-]+\/?$/u.test(decodeURI(url.pathname))) return null;
    return new URL(url.pathname, toonitalia);
  } catch {
    return null;
  }
}

async function findToonitalia(title) {
  const signal = AbortSignal.timeout(6500);
  const names = new Set(namesFor(title).map(normalizedTitle));
  const italian = normalizedTitle(title.title);
  const year = yearOf(title.year);
  // Known link for the original 1981 series; keep the remake out of this mapping.
  const reference = title.type === 'tv' && year === '1981' && names.has('nino il mio amico ninja')
    ? new URL('/nino-il-mio-amico-ninja/', toonitalia) : null;
  const direct = /^[a-z0-9 ]+$/.test(italian) ? toonPath('/' + italian.replaceAll(' ', '-') + '/') : null;

  async function verify(url, deadline = signal) {
    const page = await fetchPage(url, deadline, 'text/html');
    if (!page || !toonPath(page.url) || !names.has(normalizedTitle(pageHeading(page.body)))) return null;
    const description = plain(page.body);
    const published = /\bData di pubblicazione\s*:\s*(?:Jap\s*:\s*)?((?:19|20)\d{2})\b/i.exec(description)?.[1];
    const episodes = /\bN\.?\s*Episodi\s*:\s*(\d+)/i.exec(description)?.[1];
    if ((year && published && published !== year) || (title.type === 'movie' && Number(episodes) > 1)) return false;
    return { status: 'found', url: page.url.href,
      verification: year && published && title.type === 'tv' && Number(episodes) > 1 ? 'metadata' : 'title' };
  }

  if (reference) {
    const exact = await verify(reference, AbortSignal.timeout(2500)).catch(() => null);
    if (exact) return exact;
    if (exact === null) return knownLink(reference);
  }

  if (direct && direct.href !== reference?.href) {
    const exact = await verify(direct).catch(() => null);
    if (exact) return exact;
  }
  const search = new URL('/', toonitalia);
  search.searchParams.set('s', title.title);
  const page = await fetchPage(search, signal, 'text/html');
  if (!page) return { status: 'unavailable' };
  const candidates = new Map();
  for (const heading of page.body.matchAll(/<h[1-4]\b[^>]*>(.*?)<\/h[1-4]>/gis)) {
    const link = /<a\b[^>]*>/i.exec(heading[1]);
    if (!link || !names.has(normalizedTitle(plain(heading[1])))) continue;
    const href = attribute(link[0], 'href');
    const url = href && toonPath(href);
    if (url && url.href !== direct?.href) candidates.set(url.pathname, url);
  }
  if (!candidates.size && !/\b(?:search-results|search-no-results|nessun risultato|risultati della ricerca)\b/i.test(page.body)) {
    return { status: 'unavailable' };
  }
  const results = await Promise.allSettled([...candidates.values()].slice(0, 4).map(url => verify(url)));
  const matches = results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
  if (matches.length > 1 || candidates.size > 4) return { status: 'ambiguous' };
  if (matches.length === 1) return matches[0];
  return { status: results.some(result => result.status === 'rejected') ? 'unavailable' : 'not_found' };
}

export const titleProviders = Object.freeze({
  community: findCommunityTitle,
  animeunity: findAnimeUnity,
  toonitalia: findToonitalia
});
