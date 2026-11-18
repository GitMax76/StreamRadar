# StreamRadar IT

Catalogo personale per trovare film, serie TV e animazione on-demand in Italia. Mostra trame italiane, voti, disponibilità e link per cercare recensioni. L'app funziona in browser; il server contatta TMDB e OMDb, mentre il browser carica locandine e loghi da TMDB. La cache è in memoria e si svuota al riavvio.

## Chiavi API

**Esplora cataloghi** usa TMDB per scoprire film e serie disponibili in Italia di qualsiasi epoca. Puoi filtrare per piattaforma, formato, genere, decennio e tipo di disponibilità, poi ordinare per popolarità, voto TMDB o data di uscita. L'ordinamento per voto richiede almeno 25 valutazioni. **Novità** e **Aggiunti al catalogo** continuano a mostrare il feed degli ultimi 7 o 30 giorni.

### Streaming Availability

1. Apri [Movie of the Night Developers](https://developers.movieofthenight.com/) e crea una chiave per la Streaming Availability API.
2. Imposta `STREAMING_API_KEY` nel file `.env` alla radice del progetto. Usa una chiave del portale Movie of the Night, che il server invia nell'header `X-API-Key`.
3. **Novità** mostra le aggiunte dell'anno in corso o del precedente e gli aggiornamenti delle serie con episodi recenti. **Aggiunti al catalogo** comprende le aggiunte di ogni anno di produzione. Puoi scegliere piattaforma, periodo di 7 o 30 giorni e tipo di aggiunta. La griglia unisce le offerte dello stesso titolo. Se una piattaforma selezionata non ha novità rilevate, la vista Novità può mostrare le uscite recenti disponibili secondo TMDB con un'intestazione dedicata e senza date di aggiunta.
4. **Tendenze** mostra le classifiche disponibili per l'Italia, con la posizione su ogni piattaforma. Con tutte le piattaforme selezionate, i titoli sono ordinati per posizione nella rispettiva classifica. Se manca `STREAMING_API_KEY`, la vista generale mostra le tendenze settimanali TMDB tra i titoli disponibili in Italia. Per una classifica aggregata basata sull'attività degli utenti italiani, apri il collegamento a JustWatch nella home.

La copertura dipende dai servizi inclusi nelle fonti. I link JustWatch a novità e classifica italiana sono disponibili anche senza chiavi. TMDB è richiesto per la ricerca generale e le tendenze settimanali TMDB. OMDb aggiunge i voti quando disponibili.

### TMDB

1. Crea un account su [TMDB](https://www.themoviedb.org/) e conferma l'indirizzo email.
2. Accedi e apri [Impostazioni → API](https://www.themoviedb.org/settings/api).
3. Richiedi l'accesso **Developer**, accetta le condizioni e inserisci i dati richiesti. Puoi indicare che l'app è un catalogo personale non commerciale.
4. Copia **API Read Access Token** in `TMDB_READ_TOKEN`. Il server aggiunge `Bearer` alla richiesta, quindi incolla solamente il valore del token.

[Documentazione TMDB sull'autenticazione](https://developer.themoviedb.org/docs/authentication-application)

### OMDb

1. Apri [OMDb API Key](https://www.omdbapi.com/apikey.aspx).
2. Seleziona **FREE!**, inserisci l'email e invia la richiesta.
3. Apri l'email di OMDb e usa il link di attivazione. Copia la chiave in `OMDB_API_KEY`.
4. Il piano gratuito prevede 1.000 richieste al giorno. L'app interroga OMDb all'apertura della scheda e riusa i voti per 24 ore. Il catalogo è utilizzabile anche con la sola chiave TMDB.

## Avvio

StreamRadar si apre in /radar/ dopo l'installazione di [StreamSuite](../README.md).

## Come leggere i dati

- Quando apri la scheda di un titolo, StreamRadar cerca su StreamingCommunity usando il titolo italiano e quello originale. Mostra il collegamento solo dopo aver controllato la scheda della fonte e verificato l'identità tramite ID TMDB oppure titolo, anno e formato. Se la fonte non risponde, puoi riprovare dalla scheda.

- La home mostra una selezione dai titoli in tendenza su TMDB negli ultimi sette giorni, dopo aver verificato le offerte JustWatch per l'Italia. La classifica di partenza è globale. Il filtro Animazione comprende film e serie animate, inclusi gli anime.
- Le trame arrivano dalle traduzioni italiane di TMDB. I voti arrivano da OMDb via ID IMDb e dipendono dalla copertura delle singole fonti. IMDb rappresenta il voto degli utenti. Se una fonte manca, la scheda lo segnala.
- Ogni offerta indica il tipo di accesso. Quando disponibile, il link TMDB conduce alla pagina con le offerte. I pulsanti della critica aprono ricerche mirate ai quattro siti indicati. Una ricerca si apre solo al clic.
- `/radar/healthz` controlla l'avvio del processo. Per verificare anche le chiavi, cerca un titolo e aprine la scheda. L'installazione predefinita è pensata per la rete domestica e il server applicativo accetta richieste senza login.
