const byId = id => document.getElementById(id);
const input = byId('query');
const clear = byId('clear');
const catalog = byId('catalog');
const status = byId('status');
const retry = byId('retry');
const more = byId('more');
const exploreGenre = byId('explore-genre');
const dialog = byId('detail');
const detailContent = byId('detail-content');
const formats = { movie: 'Film', tv: 'Serie TV' };
const modes = { flatrate: 'Abbonamento', subscription: 'Abbonamento', rent: 'Noleggio', buy: 'Acquisto', free: 'Gratis', ads: 'Con pubblicità', addon: 'Canale aggiuntivo' };
const platform = byId('platform');
const period = byId('period');
const itemType = byId('item-type');
const genre = byId('genre');
const exploreSort = byId('explore-sort');
const exploreEra = byId('explore-era');
const exploreOffers = byId('explore-offers');
const addedDate = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', timeZone: 'Europe/Rome' });
const ratingFormat = new Intl.NumberFormat('it-IT', { maximumFractionDigits: 1 });
let category = 'all';
let mode = 'new';
let timer;
let catalogRequest;
let detailRequest;
let nextPage = null;
let retryPage = null;
let detailTrigger;
const seen = new Map();
const releaseYear = Number(new Intl.DateTimeFormat('it-IT', { year: 'numeric', timeZone: 'Europe/Rome' }).format(new Date()));
const timelineProviders = { netflix: 'netflix', prime: 'amazon-prime-video', hbo: 'hbo-max', apple: 'apple-tv-plus', disney: 'disney-plus' };
const timelineUrl = 'https://www.justwatch.com/it/novit%C3%A0';

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) node.textContent = value;
  return node;
}

function external(label, href, className) {
  const link = element('a', className, label);
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function picture(url, className, lazy = true, fallback = null) {
  const frame = element('div', `${className} artwork`);
  if (fallback?.text) frame.append(element('span', 'poster-fallback', fallback.text));
  if (url || fallback?.url) {
    const img = element('img');
    img.alt = '';
    img.loading = lazy ? 'lazy' : 'eager';
    img.decoding = 'async';
    let alternate = url ? fallback?.url : null;
    img.addEventListener('error', () => {
      if (!alternate) return img.remove();
      img.src = alternate;
      alternate = null;
    });
    img.src = url || fallback.url;
    frame.append(img);
  }
  return frame;
}

async function request(path, signal) {
  const response = await fetch('.' + path, { signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Richiesta non riuscita.');
  return data;
}

async function loadLoonex(query, signal) {
  const section = byId('loonex-results');
  const list = byId('loonex-items');
  const message = byId('loonex-status');
  try {
    const { items } = await request('/api/loonex?' + new URLSearchParams({ q: query }), signal);
    if (signal.aborted) return;
    message.textContent = '';
    list.replaceChildren();
    for (const item of items) {
      const row = element('li');
      row.append(element('span', null, item.title), external('Apri su LooneX', item.url, 'action'));
      if (item.downloadable) row.append(managerLink(item.url, { title: item.title, animation: true }, 'Scegli episodi'));
      list.append(row);
    }
    section.hidden = !items.length;
  } catch {
    if (signal.aborted) return;
    list.replaceChildren();
    message.textContent = 'Ricerca LooneX non disponibile al momento.';
    section.hidden = false;
  }
}

function card({ item, offers, charts }) {
  const row = element('li');
  const button = element('button', 'card');
  button.type = 'button';
  const figure = picture(item.poster, 'poster', true, { text: item.title, url: item.posterFallback });
  const documentary = item.genres?.some(value => Number(value) === 99 || value === 'documentary');
  const label = documentary ? item.type === 'tv' ? 'Docuserie' : 'Documentario' : item.animation ? 'Animazione' : formats[item.type];
  figure.append(element('span', 'type-label', label));
  if (item.rank) figure.append(element('span', 'catalog-rank', `#${item.rank}`));
  button.append(figure, element('span', 'card-title', item.title),
    element('span', 'card-info', [item.year, formats[item.type]].filter(Boolean).join(' · ')));
  if (item.ratingCount > 0) button.append(element('span', 'card-info', `TMDB ${ratingFormat.format(item.rating)}/10`));
  if (item.added) {
    const timing = [item.season != null ? `Stagione ${item.season}` : '', item.episode != null ? `Ep. ${item.episode}` : ''];
    button.append(element('span', 'card-added', [addedDate.format(item.added * 1000), ...timing].filter(Boolean).join(' · ')));
    const availability = Array.from(offers, ([name, kinds]) => [name, [...kinds].join(' / ')].filter(Boolean).join(' · '));
    for (const line of availability.slice(0, 2)) button.append(element('span', 'card-info', line));
    if (availability.length > 2) button.append(element('span', 'card-info', `+${availability.length - 2} altre offerte`));
  }
  if (charts.size) button.append(element('span', 'card-added', Array.from(charts, ([name, rank]) => `${name} #${rank}`).join(' · ')));
  button.addEventListener('click', () => openDetail(item, button));
  row.append(button);
  return row;
}

function recentRelease(item) {
  const latestYear = item.type === 'tv' && (item.season != null || item.episode != null) ? item.lastAirYear || item.year : item.year;
  return Number(latestYear) >= releaseYear - 1;
}

function mergeCatalog(items, recent, sortByDate, exploreOrder) {
  const updated = new Set();
  for (const item of items) {
    if (recent && !recentRelease(item)) continue;
    const key = `${item.type}:${item.id || item.streamId}`;
    let entry = seen.get(key);
    let changed = !entry;
    if (!entry) {
      entry = { item, offers: new Map(), charts: new Map() };
      seen.set(key, entry);
    }
    if (item.added > entry.item.added || (item.added && item.added === entry.item.added && item.episode != null && entry.item.episode == null) ||
        item.rank < entry.item.rank) {
      entry.item = item;
      changed = true;
    }
    if (item.added && item.service) {
      const name = [item.service, item.addon].filter(Boolean).join(' · ');
      if (!entry.offers.has(name)) {
        entry.offers.set(name, new Set());
        changed = true;
      }
      const kind = modes[item.offer];
      if (kind && !entry.offers.get(name).has(kind)) {
        entry.offers.get(name).add(kind);
        changed = true;
      }
    }
    if (item.rank && item.service && item.rank < (entry.charts.get(item.service) || Infinity)) {
      entry.charts.set(item.service, item.rank);
      changed = true;
    }
    if (changed) updated.add(entry);
  }
  for (const entry of updated) {
    const row = card(entry);
    entry.row?.replaceWith(row);
    if (!entry.row) catalog.append(row);
    entry.row = row;
  }
  if ((sortByDate || exploreOrder) && updated.size) {
    const compare = {
      popular: (left, right) => (right.popularity || 0) - (left.popularity || 0),
      rated: (left, right) => (right.rating || 0) - (left.rating || 0) || (right.ratingCount || 0) - (left.ratingCount || 0),
      newest: (left, right) => right.releaseDate.localeCompare(left.releaseDate)
    };
    const order = exploreOrder ? compare[exploreOrder] : (left, right) => right.added - left.added;
    const rows = [...seen.values()].sort((left, right) => order(left.item, right.item));
    rows.forEach(({ row }, index) => {
      if (catalog.children[index] !== row) catalog.insertBefore(row, catalog.children[index] || null);
    });
  }
}

async function loadChanges(params, feeds, signal, recent) {
  const outcomes = await Promise.allSettled(feeds.map(async feed => {
    const requestParams = new URLSearchParams(params);
    requestParams.set('item', feed.type);
    requestParams.set('single_page', '1');
    if (feed.cursor) {
      requestParams.set('cursor', feed.cursor);
      requestParams.set('from', feed.from);
    }
    const data = await request(`/api/discover?${requestParams}`, signal);
    if (!signal.aborted) {
      mergeCatalog(data.items, recent, true);
      if (seen.size) status.textContent = `${seen.size} ${seen.size === 1 ? 'titolo mostrato' : 'titoli mostrati'}.`;
    }
    return data;
  }));
  const successes = outcomes.filter(result => result.status === 'fulfilled');
  if (!successes.length) throw outcomes[0].reason;
  const nextFeeds = outcomes.flatMap((outcome, index) => {
    if (outcome.status === 'rejected') return [feeds[index]];
    const { nextCursor, from } = outcome.value;
    return nextCursor ? [{ type: feeds[index].type, cursor: nextCursor, from }] : [];
  });
  return { items: [], feeds: nextFeeds, disabled: successes.every(result => result.value.disabled),
    partial: outcomes.length !== successes.length || successes.some(result => result.value.partial) };
}

async function loadCatalog(continuation = null) {
  catalogRequest?.abort();
  const controller = new AbortController();
  catalogRequest = controller;
  const query = input.value.trim();
  const searching = query.length > 0;
  if (!continuation) {
    catalog.replaceChildren();
    seen.clear();
    byId('loonex-results').hidden = true;
    byId('loonex-items').replaceChildren();
  }
  const platformName = platform.value ? platform.selectedOptions[0].textContent : '';
  const sectionTitle = { new: 'Novità in Italia', catalog: 'Aggiunti al catalogo', top: 'Tendenze', explore: 'Esplora cataloghi' }[mode];
  const exploring = !searching && mode === 'explore';
  const changes = mode === 'new' || mode === 'catalog';
  byId('section-title').textContent = searching ? 'Risultati della ricerca' : [sectionTitle, platformName].filter(Boolean).join(' · ');
  byId('description').textContent = exploring
    ? `Film e serie disponibili in Italia secondo TMDB e JustWatch.${exploreSort.value === 'rated' ? ' Il voto è la media TMDB, con almeno 25 valutazioni.' : ''}`
    : mode === 'new' ? `Titoli usciti dal ${releaseYear - 1} e aggiornamenti delle serie più recenti. Aggiunte negli ultimi ${period.value} giorni.`
    : mode === 'catalog' ? `Tutte le aggiunte degli ultimi ${period.value} giorni, indipendentemente dall’anno di uscita.`
      : platform.value ? 'Classifica della piattaforma per l’Italia, quando disponibile.'
      : 'Le classifiche disponibili per l’Italia, con la posizione di ogni titolo sulla sua piattaforma.';
  byId('description').hidden = searching;
  byId('discovery').hidden = searching;
  byId('source-links').hidden = searching;
  byId('period-filter').hidden = !changes;
  byId('item-filter').hidden = !changes || category === 'movie';
  exploreGenre.hidden = searching || !changes || genre.value === 'all';
  if (!exploreGenre.hidden) exploreGenre.textContent = `Esplora ${genre.selectedOptions[0].textContent} · Tutti gli anni`;
  for (const filter of document.querySelectorAll('[data-explore-filter]')) filter.hidden = !exploring;
  const providerSlug = timelineProviders[platform.value];
  byId('timeline-link').href = providerSlug ? `https://www.justwatch.com/it/provider/${providerSlug}/novit%C3%A0` : timelineUrl;
  byId('timeline-link').textContent = providerSlug ? `Novità ${platformName} su JustWatch ↗` : 'Novità di oggi su JustWatch ↗';
  retry.hidden = true;
  more.hidden = true;
  if (query.length === 1) {
    status.textContent = 'Digita almeno due caratteri.';
    return;
  }
  if (searching && ['all', 'animation', 'tv'].includes(category)) loadLoonex(query, controller.signal);
  status.textContent = 'Caricamento…';
  const params = new URLSearchParams({ category, genre: genre.value });
  let feeds;
  if (searching) {
    params.set('q', query);
    params.set('page', continuation?.page || 1);
  } else if (exploring) {
    params.set('platform', platform.value);
    params.set('sort', exploreSort.value);
    params.set('era', exploreEra.value);
    params.set('offers', exploreOffers.value);
    for (const [type, page] of Object.entries(continuation?.explorePages || {})) params.set(`${type}_page`, page);
  } else {
    params.set('mode', changes ? 'new' : 'top');
    params.set('platform', platform.value);
    if (changes) {
      params.set('days', period.value);
      const types = category === 'movie' ? ['show'] : itemType.value === 'all' ? ['show', 'season', 'episode'] : [itemType.value];
      feeds = continuation?.feeds || types.map(type => ({ type }));
    }
  }
  try {
    const data = feeds ? await loadChanges(params, feeds, controller.signal, mode === 'new')
      : await request(`/api/${searching ? 'search' : exploring ? 'explore' : 'discover'}?${params}`, controller.signal);
    if (controller.signal.aborted) return;
    if (data.source === 'tmdb') byId('description').textContent = 'Tendenze settimanali globali TMDB tra i titoli disponibili in Italia.';
    mergeCatalog(data.items, !searching && mode === 'new', !searching && changes, exploring ? exploreSort.value : null);
    nextPage = data.nextPages ? { explorePages: data.nextPages } : data.nextPage ? { page: data.nextPage }
      : data.feeds?.length ? { feeds: data.feeds } : null;
    if (!searching && mode === 'new' && platform.value && itemType.value === 'all' && !seen.size &&
        !nextPage && !data.partial && !data.disabled) {
      const fallbackParams = new URLSearchParams({ mode: 'available', category, genre: genre.value, platform: platform.value, days: period.value });
      const fallback = await request(`/api/discover?${fallbackParams}`, controller.signal).catch(() => null);
      if (controller.signal.aborted) return;
      if (fallback?.items.length) {
        mergeCatalog(fallback.items, false, false);
        byId('section-title').textContent = `Uscite recenti disponibili · ${platformName}`;
        byId('description').textContent = `Film usciti e serie con episodi nel periodo selezionato, disponibili in Italia secondo TMDB. La data di aggiunta non è disponibile per questi titoli.`;
        status.textContent = fallback.partial ? `${seen.size} titoli mostrati. Alcuni risultati non sono disponibili.`
          : `${seen.size} ${seen.size === 1 ? 'titolo mostrato' : 'titoli mostrati'}.`;
        return;
      }
    }
    more.hidden = !nextPage;
    more.textContent = exploring || (!searching && changes) ? 'Carica altri titoli' : 'Altri risultati';
    if (data.disabled) {
      status.textContent = 'Per vedere i dati live qui, configura STREAMING_API_KEY. I link JustWatch qui sopra funzionano subito.';
    } else if (data.unsupported) {
      status.textContent = exploring ? 'TMDB non ha un catalogo italiano indicizzato per questa piattaforma e questo formato.'
        : 'La fonte non pubblica una classifica per questa piattaforma. Puoi consultare la classifica italiana su JustWatch.';
    } else if (data.partial) {
      status.textContent = 'Alcuni dati non sono disponibili al momento.';
      retryPage = null;
      retry.hidden = Boolean(nextPage);
    } else if (!seen.size) {
      status.textContent = nextPage ? 'Nessun titolo con questi filtri tra i risultati caricati. Puoi caricare altri titoli.'
        : !searching && mode === 'new' ? 'Nessuna novità recente rilevata per questi filtri. Prova Ultimi 30 giorni oppure Esplora cataloghi.'
          : 'Nessun titolo trovato per questa selezione.';
    } else {
      status.textContent = searching || changes || exploring ? `${seen.size} ${seen.size === 1 ? 'titolo mostrato' : 'titoli mostrati'}.` : '';
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    status.textContent = error.message || 'Non è stato possibile caricare il catalogo.';
    retryPage = continuation;
    retry.hidden = false;
  }
}

function renderRatings(scores) {
  const section = element('section', 'detail-section');
  section.append(element('h3', null, 'Voti e critica'));
  const row = element('div', 'score-grid');
  const votes = [
    ['IMDb', 'imdb', scores.imdb, 'Voto del pubblico'],
    ['Rotten Tomatoes', 'tomatoes', scores.rottenTomatoes, 'Tomatometer'],
    ['Metacritic', 'metacritic', scores.metacritic, 'Metascore']
  ];
  for (const [label, color, value, caption] of votes) {
    const badge = element('div', `score ${color}`);
    badge.append(element('span', 'score-label', label), element('strong', null, value || '—'),
      element('small', null, value ? caption : 'Dato assente'));
    row.append(badge);
  }
  section.append(row);
  const messages = {
    disabled: 'Per attivare i voti, configura OMDB_API_KEY sul server.',
    unmatched: 'OMDb non ha una corrispondenza IMDb per questo titolo.',
    unavailable: 'OMDb è temporaneamente non disponibile. Controlla la chiave o il limite giornaliero se il problema persiste.'
  };
  if (messages[scores.status]) section.append(element('p', 'detail-note', messages[scores.status]));
  return section;
}

function renderWatch(watch) {
  const section = element('section', 'detail-section');
  section.append(element('h3', null, 'Dove guardarlo in Italia'));
  const groups = Object.entries(watch?.groups || {}).filter(([, providers]) => providers.length);
  if (!groups.length) {
    section.append(element('p', 'detail-note', watch ? 'Nessuna offerta italiana trovata dalla fonte.' : 'La disponibilità non è verificabile al momento.'));
    return section;
  }
  for (const [mode, providers] of groups) {
    const group = element('div', 'provider-group');
    group.append(element('h4', null, modes[mode]));
    const list = element('ul', 'providers');
    for (const provider of providers) {
      const entry = element('li', 'provider');
      if (provider.logo) entry.append(picture(provider.logo, 'provider-logo'));
      entry.append(provider.link ? external(provider.name, provider.link) : element('span', null, provider.name));
      list.append(entry);
    }
    group.append(list);
    section.append(group);
  }
  const note = element('p', 'detail-note');
  note.append('Disponibilità da ', watch.source === 'streaming' ? external('Movie of the Night', 'https://www.movieofthenight.com/')
    : external('JustWatch', 'https://www.justwatch.com/it'), '.');
  if (watch.link) note.append(' ', external('Vedi le offerte su TMDB ↗', watch.link));
  section.append(note);
  return section;
}

function renderReviews(title) {
  const section = element('section', 'detail-section');
  const links = element('div', 'reviews');
  const sources = [
    ['MYmovies', 'mymovies.it', title.title, 'recensione'],
    ['Movieplayer', 'movieplayer.it', title.title, 'recensione'],
    ['Rotten Tomatoes', 'rottentomatoes.com', title.originalTitle || title.title, 'reviews'],
    ['IndieWire', 'indiewire.com', title.originalTitle || title.title, 'review']
  ];
  for (const [label, domain, name, term] of sources) {
    const params = new URLSearchParams({ q: [`site:${domain}`, name, title.year, term].filter(Boolean).join(' ') });
    links.append(external(`${label} ↗`, `https://www.google.com/search?${params}`, 'action'));
  }
  section.append(element('h3', null, 'Cerca recensioni'), links);
  return section;
}

function managerLink(url, title, label = 'Apri in Local Stream Manager') {
  const category = title.animation ? 'cartoon' : title.type === 'movie' ? 'movie' : 'series';
  const params = new URLSearchParams({ url, title: title.title, category });
  const link = element('a', 'action', label);
  link.href = '/manager/#' + params;
  return link;
}

function renderCommunity(source, signal, provider, name, label, title) {
  const section = element('section', 'detail-section community');
  const status = element('p', 'detail-note');
  status.setAttribute('role', 'status');
  const actions = element('div', 'reviews');
  const retry = element('button', 'action', 'Riprova');
  retry.type = 'button';
  section.append(element('h3', null, name), status, actions);

  async function check() {
    actions.replaceChildren();
    status.textContent = 'Verifica del titolo in corso…';
    const result = await request(`/api/community/${source}?provider=${provider}`, signal)
      .catch(() => ({ status: 'unavailable' }));
    if (signal.aborted) return;
    if (result.status === 'found') {
      status.textContent = {
        title: 'Titolo corrispondente. Dati parziali dalla fonte.',
        reference: 'Link noto. Apri la scheda per controllarla.'
      }[result.verification] || 'Scheda verificata.';
      actions.append(external(label, result.url, 'action'));
      actions.append(managerLink(result.url, title));
    } else if (result.status === 'related') {
      status.textContent = 'Titoli collegati disponibili nella fonte.';
    } else if (result.status === 'not_found') {
      status.textContent = 'Nessuna scheda corrispondente trovata.';
    } else if (result.status === 'ambiguous') {
      status.textContent = 'La ricerca non identifica una scheda univoca.';
    } else {
      status.textContent = result.reason === 'domain_discovery'
        ? 'Impossibile individuare il dominio attuale di StreamingCommunity.'
        : 'Verifica non disponibile al momento.';
      actions.append(retry);
    }
    if (result.items?.length) {
      if (result.status === 'found') actions.append(element('span', 'detail-note', 'Titoli collegati'));
      for (const item of result.items) {
        actions.append(external(item.title + (item.year ? ' (' + item.year + ')' : ''), item.url, 'action'));
      }
    }
  }

  retry.addEventListener('click', check);
  check();
  return section;
}

function renderDetail(title, communitySource, signal) {
  const content = element('div', 'detail-body');
  const info = element('div', 'detail-info');
  const heading = element('h2', null, title.title);
  heading.id = 'detail-title';
  const length = title.runtime ? `${title.runtime} min` : title.seasons != null
    ? `${title.seasons} ${title.seasons === 1 ? 'stagione' : 'stagioni'}` : '';
  const metadata = [title.year, formats[title.type], length, ...title.genres].filter(Boolean);
  info.append(heading, element('p', 'detail-meta', metadata.join(' · ')));
  if (title.originalTitle && title.originalTitle !== title.title) {
    info.append(element('p', 'detail-note', title.originalTitle));
  }
  const hero = element('div', 'detail-heading');
  hero.append(picture(title.poster, 'detail-poster', false, { text: title.title, url: title.posterFallback }), info);
  const plot = element('section', 'detail-section');
  plot.append(element('h3', null, 'Trama'), element('p', 'plot', title.overview || 'Trama non disponibile nella fonte.'));
  content.append(hero, renderCommunity(communitySource, signal, 'community', 'StreamingCommunity', 'Apri su StreamingCommunity', title));
  if (title.animation) {
    content.append(renderCommunity(communitySource, signal, 'animeunity', 'AnimeUnity', 'Apri su AnimeUnity', title),
      renderCommunity(communitySource, signal, 'toonitalia', 'Toonitalia', 'Apri su Toonitalia', title));
  }
  content.append(plot, renderRatings(title.scores),
    renderWatch(title.watch), renderReviews(title));
  detailContent.replaceChildren(picture(title.backdrop, 'backdrop', false), content);
}

async function openDetail(item, trigger) {
  detailRequest?.abort();
  const controller = new AbortController();
  detailRequest = controller;
  detailTrigger = trigger;
  const heading = element('h2', null, item.title);
  heading.id = 'detail-title';
  const message = element('p', 'status', 'Caricamento scheda…');
  message.setAttribute('role', 'status');
  const body = element('div', 'detail-loading');
  body.append(heading, message);
  detailContent.replaceChildren(body);
  if (!dialog.open) dialog.showModal();
  try {
    let communitySource = `${item.type}/${item.id}`;
    const fromStreaming = () => {
      const id = encodeURIComponent(item.streamId);
      communitySource = `stream/${id}`;
      return request(`/api/stream-title/${id}`, controller.signal);
    };
    const title = item.id ? await request(`/api/title/${item.type}/${item.id}`, controller.signal).catch(error => {
      if (!item.streamId || controller.signal.aborted) throw error;
      return fromStreaming();
    }) : await fromStreaming();
    if (!controller.signal.aborted) renderDetail(title, communitySource, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) return;
    message.textContent = error.message;
    const again = element('button', 'action', 'Riprova');
    again.type = 'button';
    again.addEventListener('click', () => openDetail(item, trigger));
    body.append(again);
  }
}

input.addEventListener('input', () => {
  catalogRequest?.abort();
  window.clearTimeout(timer);
  clear.hidden = !input.value;
  more.hidden = true;
  retry.hidden = true;
  timer = window.setTimeout(loadCatalog, 260);
});
clear.addEventListener('click', () => {
  window.clearTimeout(timer);
  input.value = '';
  clear.hidden = true;
  input.focus();
  loadCatalog();
});
for (const button of byId('categories').querySelectorAll('button')) {
  button.addEventListener('click', () => {
    if (category === button.dataset.category) return;
    window.clearTimeout(timer);
    byId('categories').querySelector('[aria-pressed="true"]').setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-pressed', 'true');
    category = button.dataset.category;
    loadCatalog();
  });
}
const modeButtons = [...byId('modes').querySelectorAll('button')];
function selectMode(next) {
  modeButtons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === next)));
  mode = next;
}
for (const button of modeButtons) {
  button.addEventListener('click', () => {
    if (mode === button.dataset.mode) return;
    selectMode(button.dataset.mode);
    loadCatalog();
  });
}
exploreGenre.addEventListener('click', () => {
  exploreEra.value = 'all';
  selectMode('explore');
  modeButtons.find(button => button.dataset.mode === 'explore').focus({ preventScroll: true });
  loadCatalog();
});
for (const filter of [platform, period, itemType, genre, exploreSort, exploreEra, exploreOffers]) filter.addEventListener('change', () => {
  window.clearTimeout(timer);
  loadCatalog();
});
request('/api/platforms').then(({ items }) => {
  const existing = new Set(Array.from(platform.options, option => option.value));
  for (const item of items) {
    if (existing.has(item.id)) continue;
    const option = element('option', null, item.name);
    option.value = item.id;
    platform.append(option);
  }
}).catch(() => { /* I filtri principali restano disponibili. */ });
more.addEventListener('click', () => { if (nextPage) loadCatalog(nextPage); });
retry.addEventListener('click', () => loadCatalog(retryPage));
byId('close').addEventListener('click', () => dialog.close());
dialog.addEventListener('close', () => {
  detailRequest?.abort();
  detailTrigger?.focus();
});
dialog.addEventListener('click', event => {
  if (event.target === dialog) dialog.close();
});
const initial = new URLSearchParams(window.location.search);
if (initial.get('view') === 'explore') {
  selectMode('explore');
  for (const filter of [platform, genre]) {
    const value = initial.get(filter.id);
    if ([...filter.options].some(option => option.value === value)) filter.value = value;
  }
  const formats = [...byId('categories').querySelectorAll('button')];
  const initialFormat = formats.find(button => button.dataset.category === initial.get('category'));
  if (initialFormat) {
    category = initialFormat.dataset.category;
    formats.forEach(button => button.setAttribute('aria-pressed', String(button === initialFormat)));
  }
}
loadCatalog();
