import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { communityOrigin, searchLoonex, titleProviders } from './community.mjs';

const TMDB = 'https://api.themoviedb.org/3';
const OMDB = 'https://www.omdbapi.com/';
const TYPES = ['movie', 'tv'];
const CHANGE_TYPES = ['show', 'season', 'episode'];
const TRUE_CRIME_TOPICS = ['murder', 'murder investigation', 'serial killer', 'kidnapping', 'missing person', 'wrongful conviction', 'bank robbery', 'heist', 'fraud'];
const EXPLORE_FEEDS = TYPES.flatMap(type => [type, `${type}_crime_docs`, `${type}_case_docs`]);
const CATALOG_SORTS = ['popular', 'rated', 'newest'];
const CATALOG_ERAS = ['all', '2020s', '2010s', '2000s', '1990s', '1980s', 'classics'];
const GENRES = {
  crime: [80], 'true-crime': [], 'science-fiction': [878, 10765, 'scifi', 'sciencefiction'],
  adventure: [12, 10759], action: [28, 10759], thriller: [53, 'thriller'], mystery: [9648],
  horror: [27, 'horror'], fantasy: [14, 10765], comedy: [35], drama: [18], documentary: [99], family: [10751]
};
const PROVIDER_NAMES = {
  netflix: ['Netflix'], prime: ['Amazon Prime Video', 'Prime Video'], disney: ['Disney Plus'],
  hbo: ['HBO Max', 'Max'], apple: ['Apple TV Plus', 'Apple TV'], paramount: ['Paramount Plus'],
  crunchyroll: ['Crunchyroll'], mubi: ['MUBI'], now: ['Now TV', 'Now'], curiosity: ['Curiosity Stream'],
  plutotv: ['Pluto TV'], zee5: ['Zee5']
};
const CATEGORIES = ['all', ...TYPES, 'animation', 'documentary'];
const MODES = ['flatrate', 'rent', 'buy', 'free', 'ads'];
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const token = process.env.TMDB_READ_TOKEN?.trim();
const omdbKey = process.env.OMDB_API_KEY?.trim();
const streamingKey = process.env.STREAMING_API_KEY?.trim();
const streamingRoot = 'https://api.movieofthenight.com/v4';
const topServices = new Set(['netflix', 'prime', 'disney', 'apple', 'hbo', 'crunchyroll', 'paramount', 'crave', 'hulu', 'starz']);
const imageRoot = 'https://image.tmdb.org/t/p';
const site = new Map(await Promise.all([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/favicon.ico', 'favicon.ico', 'image/vnd.microsoft.icon'],
  ['/apple-touch-icon.png', 'apple-touch-icon.png', 'image/png'],
  ['/icon-192.png', 'icon-192.png', 'image/png'],
  ['/icon-512.png', 'icon-512.png', 'image/png'],
  ['/manifest.webmanifest', 'manifest.webmanifest', 'application/manifest+json; charset=utf-8']
].map(async ([route, file, type]) => [route, { type, body: await readFile(new URL(`./public/${file}`, import.meta.url)) }])));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const cache = new Map();
const pending = new Map();
async function cached(key, ttl, load, retain = () => true) {
  const entry = cache.get(key);
  if (entry?.expires > Date.now()) return entry.value;
  if (pending.has(key)) return pending.get(key);
  if (pending.size >= 160) throw new HttpError(503, 'Troppe richieste in corso. Riprova tra poco.');
  const task = Promise.resolve().then(load).then(value => {
    if (retain(value)) {
      cache.delete(key);
      cache.set(key, { value, expires: Date.now() + ttl });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
    }
    return value;
  }).finally(() => pending.delete(key));
  pending.set(key, task);
  return task;
}

async function upstream(url, name, headers = {}, timeout = 4500) {
  let response;
  let body;
  const signal = AbortSignal.timeout(timeout);
  try {
    response = await fetch(url, {
      headers: { accept: 'application/json', ...headers },
      redirect: 'error',
      signal
    });
    if (response.ok) body = await response.json();
  } catch (error) {
    if (signal.aborted || error.name === 'TimeoutError') {
      throw new HttpError(504, `${name} non ha completato la risposta entro ${timeout / 1000} secondi.`);
    }
    if (error instanceof SyntaxError) throw new HttpError(502, `Risposta ${name} non valida.`);
    const code = error.cause?.code;
    const reason = code === 'ENOTFOUND' || code === 'EAI_AGAIN' ? 'errore DNS' : 'connessione interrotta';
    throw new HttpError(502, `${name}: ${reason}.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(503, `Verifica le credenziali ${name} sul server.`);
  }
  if (response.status === 429) throw new HttpError(503, `Limite ${name} raggiunto. Riprova più tardi.`);
  if (response.status === 404 && name !== 'OMDb') throw new HttpError(404, 'Risorsa non trovata nella fonte.');
  if (!response.ok) throw new HttpError(502, `${name} ha restituito un errore (HTTP ${response.status}).`);
  return body;
}

function tmdb(path, params = {}) {
  if (!token) throw new HttpError(503, 'Configura TMDB_READ_TOKEN nel file .env del server.');
  const url = new URL(TMDB + path);
  url.search = new URLSearchParams({ language: 'it-IT', ...params });
  return upstream(url, 'TMDB', { authorization: `Bearer ${token}` });
}

function image(path, size) {
  return typeof path === 'string' && /^\/[\w-]+\.(?:jpg|jpeg|png|webp)$/i.test(path)
    ? `${imageRoot}/${size}${path}` : null;
}

function summary(data, type = data.media_type) {
  const genres = data.genre_ids || data.genres?.map(genre => genre.id) || [];
  return {
    id: data.id,
    type,
    title: data.title || data.name || data.original_title || data.original_name || 'Senza titolo',
    year: (data.release_date || data.first_air_date || '').slice(0, 4),
    animation: genres.includes(16),
    genres,
    poster: image(data.poster_path, 'w342')
  };
}

function genreKey(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function hasGenre(item, id, name) {
  return item.genres.some(value => Number(value) === id || genreKey(value) === name);
}

function keywordIds(names) {
  return Promise.all(names.map(name => cached(`tmdb:keyword:${name}`, 24 * HOUR, async () => {
    const data = await tmdb('/search/keyword', { query: name });
    return (data.results || []).filter(item => genreKey(item.name) === genreKey(name)).map(item => item.id);
  }))).then(ids => [...new Set(ids.flat())].join('|'));
}

async function filterGenre(result, genre) {
  if (genre === 'all' || !result.items.length) return result;
  const keys = new Set([genre, ...GENRES[genre]].map(genreKey));
  if (genre !== 'true-crime') {
    return { ...result, items: result.items.filter(item => item.genres.some(value => keys.has(genreKey(value)))) };
  }
  const matches = await Promise.allSettled(result.items.map(async item => {
    if (item.genres.some(value => keys.has(genreKey(value)))) return true;
    const documentary = hasGenre(item, 99, 'documentary');
    if (documentary && hasGenre(item, 80, 'crime')) return true;
    if (!item.id || !token) return false;
    const data = await cached(`tmdb:keywords:${item.type}:${item.id}`, 24 * HOUR,
      () => tmdb(`/${item.type}/${item.id}/keywords`));
    const identifiers = documentary ? new Set([...keys, ...TRUE_CRIME_TOPICS.map(genreKey)]) : keys;
    return (data.keywords || data.results || []).some(keyword => identifiers.has(genreKey(keyword.name)));
  }));
  return { ...result, items: result.items.filter((_, index) => matches[index].value === true),
    partial: result.partial || matches.some(match => match.status === 'rejected') };
}

function validCategory(item, category) {
  return category === 'all' || category === item.type || (category === 'animation' && item.animation) ||
    (category === 'documentary' && hasGenre(item, 99, 'documentary'));
}

function streaming(path, params = {}, timeout) {
  const url = new URL(streamingRoot + path);
  // The market is selected by country; this API does not localize metadata to Italian.
  url.search = new URLSearchParams(params);
  return upstream(url, 'Streaming Availability', { 'X-API-Key': streamingKey }, timeout);
}

function streamingServices() {
  return cached('streaming:services', 24 * HOUR, async () => {
    const data = await streaming('/countries/it');
    return data.services.map(({ id, name }) => ({ id, name }));
  });
}

function streamingSummary(show) {
  const match = /^(movie|tv)\/([1-9]\d{0,9})$/.exec(show.tmdbId || '');
  const type = match?.[1] || (show.showType === 'movie' ? 'movie' : 'tv');
  const genres = (show.genres || []).map(genre => genre.id);
  return {
    id: match ? Number(match[2]) : null,
    streamId: show.id,
    type,
    title: show.title || show.originalTitle || 'Senza titolo',
    year: show.releaseYear || show.firstAirYear || null,
    lastAirYear: show.lastAirYear || null,
    animation: genres.some(genre => genre === 'animation' || Number(genre) === 16),
    genres,
    poster: secureUrl(show.imageSet?.verticalPoster?.w360),
    posterFallback: match && token ? `./api/poster/${type}/${match[2]}` : null
  };
}

function secureUrl(value) {
  return typeof value === 'string' && /^https:\/\//i.test(value) ? value : null;
}

async function newCatalog(category, platform, itemType, cursor, from, timeout) {
  const params = { country: 'it', change_type: 'new', item_type: itemType, order_direction: 'desc', from };
  if (platform) params.catalogs = platform;
  if (itemType === 'show' && TYPES.includes(category)) params.show_type = category === 'movie' ? 'movie' : 'series';
  if (cursor) params.cursor = cursor;
  const data = await cached(`streaming:new:${new URLSearchParams(params)}`, HOUR, () => streaming('/changes', params, timeout));
  const items = [];
  for (const change of data.changes) {
    const show = Object.hasOwn(data.shows, change.showId) ? data.shows[change.showId] : null;
    if (!show || !Number.isSafeInteger(change.timestamp)) continue;
    const item = streamingSummary(show);
    if (!validCategory(item, category)) continue;
    items.push({ ...item, added: change.timestamp, service: change.service?.name, serviceId: change.service?.id,
      offer: change.streamingOptionType, addon: change.addon?.name, season: change.season, episode: change.episode });
  }
  const more = data.hasMore && typeof data.nextCursor === 'string' && data.nextCursor !== cursor;
  return { items, nextCursor: more ? data.nextCursor : null, from };
}

async function catalogBatch(category, platform, itemType, cursor, from) {
  const first = await newCatalog(category, platform, itemType, cursor, from, 20000);
  if (!first.nextCursor) return first;
  try {
    const second = await newCatalog(category, platform, itemType, first.nextCursor, from, 4500);
    return { ...second, items: [...first.items, ...second.items],
      nextCursor: second.nextCursor === cursor ? null : second.nextCursor };
  } catch {
    return { ...first, partial: true };
  }
}

async function combinedChanges(category, platform, cursor, from) {
  const types = CHANGE_TYPES;
  let positions;
  try {
    positions = cursor ? JSON.parse(cursor) : types.map(() => '');
    if (!Array.isArray(positions) || positions.length !== types.length ||
        positions.some(value => value !== null && (typeof value !== 'string' || value.length > 180))) throw new Error();
  } catch {
    throw new HttpError(400, 'Pagina delle novità non valida.');
  }
  const active = types.map((type, index) => ({ type, index })).filter(({ index }) => positions[index] !== null);
  const outcomes = await Promise.allSettled(active.map(({ type, index }) =>
    newCatalog(category, platform, type, positions[index], from, 20000)));
  const items = [];
  let failures = 0;
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === 'rejected') {
      failures++;
      continue;
    }
    positions[active[index].index] = outcome.value.nextCursor;
    items.push(...outcome.value.items);
  }
  if (outcomes.length && failures === outcomes.length) throw outcomes[0].reason;
  return { items, from, partial: failures > 0,
    nextCursor: positions.some(value => value !== null) ? JSON.stringify(positions) : null };
}

function normalizeProvider(name) {
  return name.toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]/g, '');
}

async function catalogProviderIds(type, names) {
  const labels = new Set(names.map(normalizeProvider));
  const data = await cached(`tmdb-providers:${type}`, 24 * HOUR,
    () => tmdb(`/watch/providers/${type}`, { watch_region: 'IT' }));
  return (data.results || []).filter(item => labels.has(normalizeProvider(item.provider_name)))
    .map(item => item.provider_id).join('|');
}

async function availableReleases(category, platform, from, now, genre) {
  const names = PROVIDER_NAMES[platform];
  if (!token || !Array.isArray(names)) return { items: [] };
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' });
  const fromDate = date.format(from * 1000);
  const toDate = date.format(now * 1000);
  const types = TYPES.includes(category) ? [category] : TYPES;
  const outcomes = await Promise.allSettled(types.map(async type => {
    const providerIds = await catalogProviderIds(type, names);
    if (!providerIds) return [];
    const dateField = type === 'movie' ? 'primary_release_date' : 'air_date';
    const params = { watch_region: 'IT', with_watch_providers: providerIds,
      with_watch_monetization_types: 'flatrate|free|ads', include_adult: 'false',
      [`${dateField}.gte`]: fromDate, [`${dateField}.lte`]: toDate };
    if (category === 'animation') params.with_genres = '16';
    else if (category === 'documentary') params.with_genres = '99';
    else if (genre !== 'all') {
      const ids = GENRES[genre].filter(Number.isInteger);
      if (ids.length) params.with_genres = ids.join('|');
    }
    const releases = await cached(`tmdb-available:${type}:${new URLSearchParams(params)}`, HOUR,
      () => tmdb(`/discover/${type}`, params));
    return (releases.results || []).filter(item => !item.adult).map(item => summary(item, type)).filter(item => validCategory(item, category));
  }));
  if (outcomes.every(outcome => outcome.status === 'rejected')) throw outcomes[0].reason;
  return { items: outcomes.flatMap(outcome => outcome.status === 'fulfilled' ? outcome.value : []),
    partial: outcomes.some(outcome => outcome.status === 'rejected') };
}

async function exploreCatalog({ category, genre, platform, sort, era, offers, pages }) {
  if (!token) throw new HttpError(503, 'Per esplorare il catalogo configura TMDB_READ_TOKEN.');
  const types = TYPES.includes(category) ? [category] : TYPES;
  const trueCrime = genre === 'true-crime';
  const feeds = types.flatMap(type => trueCrime && category !== 'animation'
    ? [{ type, key: type }, { type, key: `${type}_crime_docs`, documentary: 'crime' }, { type, key: `${type}_case_docs`, documentary: 'case' }]
    : [{ type, key: type }]).filter(feed => pages[feed.key] > 0);
  if (!feeds.length) return { items: [], nextPages: null };
  let names = PROVIDER_NAMES[platform];
  if (platform && !Array.isArray(names) && streamingKey) {
    const service = (await streamingServices()).find(item => item.id === platform);
    if (service) names = [service.name];
  }
  if (platform && !Array.isArray(names)) return { items: [], unsupported: true };
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(Date.now());
  const outcomes = await Promise.allSettled(feeds.map(async ({ type, key, documentary }) => {
    const dates = type === 'movie' ? 'primary_release_date' : 'first_air_date';
    const params = { watch_region: 'IT', include_adult: 'false', page: pages[key],
      with_watch_monetization_types: offers === 'all' ? MODES.join('|') : 'flatrate|free|ads',
      sort_by: { popular: 'popularity.desc', rated: 'vote_average.desc', newest: `${dates}.desc` }[sort],
      [`${dates}.lte`]: today };
    if (sort === 'rated') params['vote_count.gte'] = '25';
    if (era === 'classics') params[`${dates}.lte`] = '1979-12-31';
    else if (era !== 'all') {
      const start = Number(era.slice(0, 4));
      params[`${dates}.gte`] = `${start}-01-01`;
      params[`${dates}.lte`] = [`${start + 9}-12-31`, today].sort()[0];
    }
    const ids = (GENRES[genre] || []).filter(Number.isInteger);
    if (category === 'animation') params.with_genres = '16';
    else if (category === 'documentary') params.with_genres = '99';
    else if (ids.length) params.with_genres = ids.join('|');
    if (documentary === 'crime') params.with_genres = '99,80';
    else if (trueCrime) {
      if (documentary === 'case') params.with_genres = '99';
      params.with_keywords = await keywordIds(documentary === 'case' ? TRUE_CRIME_TOPICS : ['true crime']);
      if (!params.with_keywords) return { items: [], next: 0 };
    }
    if (platform) {
      params.with_watch_providers = await catalogProviderIds(type, names);
      if (!params.with_watch_providers) return { items: [], next: 0, unsupported: true };
    }
    const data = await cached(`tmdb:explore:${type}:${new URLSearchParams(params)}`, HOUR,
      () => tmdb(`/discover/${type}`, params));
    let items = (data.results || []).filter(item => !item.adult).map(item => ({ ...summary(item, type),
      rating: item.vote_average, ratingCount: item.vote_count, popularity: item.popularity,
      releaseDate: item.release_date || item.first_air_date || '' }));
    items = items.filter(item => validCategory(item, category));
    if (documentary) items = items.filter(item => hasGenre(item, 99, 'documentary') &&
      (documentary !== 'crime' || hasGenre(item, 80, 'crime')));
    if (['animation', 'documentary'].includes(category) && genre !== 'true-crime') items = (await filterGenre({ items }, genre)).items;
    return { items, next: pages[key] < Math.min(data.total_pages || 0, 500) ? pages[key] + 1 : 0 };
  }));
  if (outcomes.every(outcome => outcome.status === 'rejected')) throw outcomes[0].reason;
  const nextPages = Object.fromEntries(EXPLORE_FEEDS.map(key => [key, 0]));
  const items = new Map();
  for (const [index, outcome] of outcomes.entries()) {
    const { key } = feeds[index];
    if (outcome.status === 'fulfilled') {
      for (const item of outcome.value.items) items.set(`${item.type}:${item.id}`, item);
      nextPages[key] = outcome.value.next;
    } else nextPages[key] = pages[key];
  }
  return { items: [...items.values()], nextPages: Object.values(nextPages).some(Boolean) ? nextPages : null,
    unsupported: outcomes.every(outcome => outcome.value?.unsupported),
    partial: outcomes.some(outcome => outcome.status === 'rejected') };
}

async function topCatalog(category, platform) {
  if (!topServices.has(platform)) return { items: [], unsupported: true };
  const params = { country: 'it', service: platform };
  if (TYPES.includes(category)) params.show_type = category === 'movie' ? 'movie' : 'series';
  const data = await cached(`streaming:top:${new URLSearchParams(params)}`, HOUR, () => streaming('/shows/top', params));
  const shows = Array.isArray(data) ? data : data.shows;
  if (!Array.isArray(shows)) throw new HttpError(502, 'Classifica ricevuta in un formato non valido.');
  return { items: shows.map((show, index) => ({ ...streamingSummary(show), rank: index + 1 }))
    .filter(item => validCategory(item, category)) };
}

async function allTopCatalogs(category) {
  const services = (await streamingServices()).filter(service => topServices.has(service.id));
  const results = await Promise.allSettled(services.map(async service => {
    const { items } = await topCatalog(category, service.id);
    return items.map(item => ({ ...item, service: service.name, serviceId: service.id }));
  }));
  const charts = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  if (!charts.length && results.length) throw results[0].reason;
  const items = charts.flat().sort((left, right) => left.rank - right.rank);
  return { items, partial: results.some(result => result.status === 'rejected') };
}

async function search(query, category, page, genre) {
  const type = TYPES.includes(category) ? category : 'multi';
  const items = [];
  let partial = false;
  let nextPage = page;
  for (let attempt = 0; attempt < 4 && nextPage && items.length === 0; attempt++) {
    const current = nextPage;
    const normalized = query.toLocaleLowerCase('it-IT');
    const data = await cached(`search:${type}:${current}:${normalized}`, 15 * MINUTE,
      () => tmdb(`/search/${type}`, { query, page: current, include_adult: 'false' }));
    const candidates = [];
    for (const result of data.results || []) {
      const mediaType = type === 'multi' ? result.media_type : type;
      if (!TYPES.includes(mediaType) || result.adult) continue;
      const item = summary(result, mediaType);
      if (validCategory(item, category)) candidates.push(item);
    }
    const filtered = await filterGenre({ items: candidates }, genre);
    items.push(...filtered.items);
    partial ||= Boolean(filtered.partial);
    nextPage = current < Math.min(data.total_pages || 0, 500) ? current + 1 : null;
  }
  return { items, nextPage, partial };
}

function watchProviders(type, id) {
  return cached(`watch:${type}:${id}`, 6 * HOUR, async () => {
    const data = await tmdb(`/${type}/${id}/watch/providers`);
    const italy = data.results?.IT || {};
    const groups = Object.fromEntries(MODES.map(mode => [mode,
      (italy[mode] || []).map(provider => ({
        id: provider.provider_id,
        name: provider.provider_name,
        logo: image(provider.logo_path, 'w92')
      }))
    ]));
    const link = /^https:\/\/www\.themoviedb\.org\//.test(italy.link || '') ? italy.link : null;
    return { groups, link };
  });
}

function titleMetadata(type, id) {
  return cached(`detail:${type}:${id}`, 12 * HOUR,
    () => tmdb(`/${type}/${id}`, { append_to_response: 'translations,external_ids' }));
}

async function trending(category) {
  return cached(`weekly:${category}`, HOUR, async () => {
    const kind = TYPES.includes(category) ? category : 'all';
    const response = await tmdb(`/trending/${kind}/week`);
    const candidates = (response.results || [])
      .filter(item => !item.adult && (kind !== 'all' || TYPES.includes(item.media_type)))
      .map(item => summary(item, kind === 'all' ? item.media_type : kind))
      .filter(item => validCategory(item, category));

    const items = [];
    let partial = false;
    for (let offset = 0; offset < candidates.length && items.length < 16; offset += 6) {
      const batch = candidates.slice(offset, offset + 6);
      const results = await Promise.allSettled(batch.map(item => watchProviders(item.type, item.id)));
      results.forEach((result, index) => {
        if (result.status === 'rejected') partial = true;
        else if (Object.values(result.value.groups).some(group => group.length > 0)) items.push(batch[index]);
      });
    }
    return { items: items.slice(0, 16), partial };
  }, result => !result.partial);
}

function ratingValue(value) {
  return typeof value === 'string' && value.trim() && value.trim() !== 'N/A' ? value.trim() : null;
}

async function ratings(imdbId) {
  if (!/^tt\d{7,12}$/.test(imdbId || '')) return { status: 'unmatched' };
  if (!omdbKey) return { status: 'disabled' };
  try {
    return await cached(`ratings:${imdbId}`, 24 * HOUR, async () => {
      const url = new URL(OMDB);
      url.search = new URLSearchParams({ apikey: omdbKey, i: imdbId, r: 'json' });
      const data = await upstream(url, 'OMDb');
      if (data.Response === 'False') {
        if (/not found|incorrect imdb id/i.test(data.Error || '')) return { status: 'unmatched' };
        throw new HttpError(502, 'OMDb non ha fornito i voti.');
      }
      const bySource = Object.fromEntries((data.Ratings || []).map(({ Source, Value }) => [Source, ratingValue(Value)]));
      const imdb = ratingValue(data.imdbRating);
      const meta = ratingValue(data.Metascore);
      return {
        status: 'ok',
        imdb: bySource['Internet Movie Database'] || (imdb ? `${imdb}/10` : null),
        rottenTomatoes: bySource['Rotten Tomatoes'] || null,
        metacritic: bySource.Metacritic || (meta ? `${meta}/100` : null)
      };
    });
  } catch {
    return { status: 'unavailable' };
  }
}

async function detail(type, id) {
  const [data, watch] = await Promise.all([
    titleMetadata(type, id),
    watchProviders(type, id).catch(() => null)
  ]);
  if (data.adult) throw new HttpError(404, 'Titolo non trovato.');
  const translation = data.translations?.translations?.find(entry => entry.iso_639_1 === 'it' && entry.iso_3166_1 === 'IT');
  const overview = translation?.data?.overview?.trim() || (data.original_language === 'it' ? data.overview?.trim() : null);
  const scores = await ratings(data.imdb_id || data.external_ids?.imdb_id);
  return {
    ...summary(data, type),
    originalTitle: data.original_title || data.original_name || '',
    poster: image(data.poster_path, 'w500'),
    backdrop: image(data.backdrop_path, 'w1280'),
    genres: (data.genres || []).map(genre => genre.name),
    overview: overview || null,
    runtime: type === 'movie' ? data.runtime || null : null,
    seasons: type === 'tv' ? data.number_of_seasons ?? null : null,
    watch,
    scores
  };
}

function streamingMetadata(id) {
  return cached(`streaming:detail:${id}`, 6 * HOUR,
    () => streaming(`/shows/${encodeURIComponent(id)}`, { country: 'it' }));
}

async function streamingDetail(id) {
  const show = await streamingMetadata(id);
  const item = streamingSummary(show);
  const groups = Object.fromEntries([...MODES, 'addon'].map(mode => [mode, []]));
  for (const option of show.streamingOptions?.it || []) {
    const mode = option.type === 'subscription' ? 'flatrate' : option.type;
    if (!Object.hasOwn(groups, mode) || !option.service?.name) continue;
    const name = option.addon?.name ? `${option.service.name} · ${option.addon.name}` : option.service.name;
    if (!groups[mode].some(provider => provider.name === name)) {
      groups[mode].push({ name, link: secureUrl(option.link) });
    }
  }
  return { ...item, originalTitle: show.originalTitle, overview: show.overview, runtime: show.runtime,
    seasons: show.seasonCount, genres: (show.genres || []).map(genre => genre.name),
    backdrop: secureUrl(show.imageSet?.horizontalBackdrop?.w720), watch: { groups, source: 'streaming' },
    scores: await ratings(show.imdbId) };
}

async function communityTitle(source, id, provider) {
  const origin = provider === 'community' ? await communityOrigin().catch(() => null) : undefined;
  if (origin === null) return { status: 'unavailable', reason: 'domain_discovery' };
  return cached(`community:${provider}:${source}:${id}:${origin || ''}`, 10 * MINUTE, async () => {
    const lookup = titleProviders[provider];
    let title;
    if (source === 'stream') {
      const show = await streamingMetadata(id);
      title = { ...streamingSummary(show), originalTitle: show.originalTitle };
    } else {
      const data = await titleMetadata(source, id);
      if (data.adult) throw new HttpError(404, 'Titolo non trovato.');
      const english = (data.translations?.translations || [])
        .filter(translation => translation.iso_639_1 === 'en')
        .sort((first, second) => Number(second.iso_3166_1 === 'US') - Number(first.iso_3166_1 === 'US'))
        .map(translation => translation.data?.title || translation.data?.name)
        .find(name => name?.trim());
      title = { ...summary(data, source), originalTitle: data.original_title || data.original_name,
        englishTitle: english };
    }
    if (provider !== 'community' && !title.animation) return { status: 'not_applicable' };
    return lookup(title, origin).catch(() => ({ status: 'unavailable' }));
  }, result => result.status !== 'unavailable' && result.verification !== 'reference');
}

const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https://image.tmdb.org https://www.themoviedb.org https://*.movieofthenight.com; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

function json(response, status, body, headers = {}) {
  response.writeHead(status, { ...SECURITY, ...headers, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

const server = createServer(async (request, response) => {
  try {
    if (request.method !== 'GET') return json(response, 405, { error: 'Metodo non consentito.' }, { Allow: 'GET' });
    const url = new URL(request.url, 'http://localhost');
    const path = url.pathname;
    if (site.has(path)) {
      const asset = site.get(path);
      response.writeHead(200, { ...SECURITY, 'Content-Type': asset.type, 'Cache-Control': 'no-cache' });
      return response.end(asset.body);
    }
    if (path === '/healthz') return json(response, 200, { ok: true });
    if (path === '/api/loonex') {
      const query = (url.searchParams.get('q') || '').trim();
      if (query.length < 2 || query.length > 120) throw new HttpError(400, 'Inserisci da 2 a 120 caratteri.');
      try {
        const items = await cached('loonex:' + query.toLowerCase(), 15 * MINUTE, () => searchLoonex(query));
        return json(response, 200, { items });
      } catch {
        throw new HttpError(502, 'Ricerca LooneX non disponibile al momento.');
      }
    }
    const posterMatch = /^\/api\/poster\/(movie|tv)\/([1-9]\d{0,9})$/.exec(path);
    if (posterMatch && Number(posterMatch[2]) <= 2_147_483_647) {
      const data = await titleMetadata(posterMatch[1], posterMatch[2]);
      const location = !data.adult && image(data.poster_path, 'w342');
      if (!location) throw new HttpError(404, 'Locandina non disponibile.');
      response.writeHead(302, { ...SECURITY, Location: location, 'Cache-Control': 'public, max-age=43200' });
      return response.end();
    }
    if (path === '/api/platforms') {
      return json(response, 200, { items: streamingKey ? await streamingServices() : [] });
    }
    if (path === '/api/explore') {
      const category = url.searchParams.get('category') || 'all';
      const genre = url.searchParams.get('genre') || 'all';
      const platform = url.searchParams.get('platform') || '';
      const sort = url.searchParams.get('sort') || 'popular';
      const era = url.searchParams.get('era') || 'all';
      const offers = url.searchParams.get('offers') || 'included';
      const pages = Object.fromEntries(EXPLORE_FEEDS.map(key => [key, Number(url.searchParams.get(`${key}_page`) ?? 1)]));
      if (!CATEGORIES.includes(category) || (genre !== 'all' && !Object.hasOwn(GENRES, genre)) || !/^[a-z0-9-]{0,50}$/.test(platform) ||
          !CATALOG_SORTS.includes(sort) || !CATALOG_ERAS.includes(era) || !['included', 'all'].includes(offers) ||
          Object.values(pages).some(page => !Number.isInteger(page) || page < 0 || page > 500)) {
        throw new HttpError(400, 'Filtri di Esplora cataloghi non validi.');
      }
      return json(response, 200, await exploreCatalog({ category, genre, platform, sort, era, offers, pages }));
    }
    if (path === '/api/discover') {
      const category = url.searchParams.get('category') || 'all';
      const genre = url.searchParams.get('genre') || 'all';
      const mode = url.searchParams.get('mode') || 'new';
      const platform = url.searchParams.get('platform') || '';
      const itemType = url.searchParams.get('item') || 'show';
      const cursor = url.searchParams.get('cursor') || '';
      const days = Number(url.searchParams.get('days') || '7');
      const now = Math.floor(Date.now() / 1000);
      const from = Number(url.searchParams.get('from') || Math.floor(now / 3600) * 3600 - days * 86400);
      if (!CATEGORIES.includes(category) || (genre !== 'all' && !Object.hasOwn(GENRES, genre)) ||
          !['new', 'top', 'available'].includes(mode) || !/^[a-z0-9-]{0,50}$/.test(platform) ||
          !['all', ...CHANGE_TYPES].includes(itemType) || cursor.length > (itemType === 'all' ? 1150 : 180) || ![7, 30].includes(days) ||
          !Number.isSafeInteger(from) || from < now - 31 * 86400 || from > now) {
        throw new HttpError(400, 'Filtri del catalogo non validi.');
      }
      if (mode === 'available') return json(response, 200, await filterGenre(await availableReleases(category, platform, from, now, genre), genre));
      if (mode === 'top' && !platform) {
        const result = streamingKey ? await allTopCatalogs(category) : { ...await trending(category), source: 'tmdb' };
        return json(response, 200, await filterGenre(result, genre));
      }
      if (!streamingKey) return json(response, 200, { items: [], disabled: true });
      let result;
      if (mode === 'top') result = await topCatalog(category, platform);
      else if (itemType === 'all' && category !== 'movie') result = await combinedChanges(category, platform, cursor, from);
      else if (url.searchParams.get('single_page') === '1') result = await newCatalog(category, platform, itemType === 'all' ? 'show' : itemType, cursor, from, 20000);
      else result = await catalogBatch(category, platform, itemType === 'all' ? 'show' : itemType, cursor, from);
      return json(response, 200, await filterGenre(result, genre));
    }
    if (path === '/api/popular' || path === '/api/search') {
      const category = url.searchParams.get('category') || 'all';
      const genre = url.searchParams.get('genre') || 'all';
      if (!CATEGORIES.includes(category) || (genre !== 'all' && !Object.hasOwn(GENRES, genre))) throw new HttpError(400, 'Categoria o genere non valido.');
      if (path === '/api/popular') return json(response, 200, await filterGenre(await trending(category), genre));
      const query = (url.searchParams.get('q') || '').trim();
      const page = Number(url.searchParams.get('page') ?? '1');
      if (query.length < 2 || query.length > 120 || !Number.isInteger(page) || page < 1 || page > 500) {
        throw new HttpError(400, 'Inserisci da 2 a 120 caratteri e una pagina valida.');
      }
      return json(response, 200, await search(query, category, page, genre));
    }
    const match = /^\/api\/title\/(movie|tv)\/([1-9]\d{0,9})$/.exec(path);
    if (match && Number(match[2]) <= 2_147_483_647) return json(response, 200, await detail(match[1], match[2]));
    const communityMatch = /^\/api\/community\/(movie|tv)\/([1-9]\d{0,9})$/.exec(path);
    const communityStream = /^\/api\/community\/stream\/([\w-]{1,100})$/.exec(path);
    if ((communityMatch && Number(communityMatch[2]) <= 2_147_483_647) || (communityStream && streamingKey)) {
      const provider = url.searchParams.get('provider') || 'community';
      if (!Object.hasOwn(titleProviders, provider)) throw new HttpError(400, 'Fonte non riconosciuta.');
      const [source, id] = communityMatch ? communityMatch.slice(1) : ['stream', communityStream[1]];
      return json(response, 200, await communityTitle(source, id, provider));
    }
    const streamMatch = /^\/api\/stream-title\/([\w-]{1,100})$/.exec(path);
    if (streamMatch && streamingKey) return json(response, 200, await streamingDetail(streamMatch[1]));
    return json(response, 404, { error: 'Risorsa non trovata.' });
  } catch (error) {
    if (error instanceof HttpError) return json(response, error.status, { error: error.message });
    console.error('Errore interno durante la gestione di una richiesta.');
    return json(response, 500, { error: 'Errore interno del server.' });
  }
});

const port = Number(process.env.PORT || 8080);
server.listen(port, '0.0.0.0', () => console.log(`StreamRadar IT in ascolto sulla porta ${port}`));
