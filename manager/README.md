# Local Stream Manager per ZimaOS

Prima versione web per Docker su ZimaOS x86-64. Gestisce URL MP4 diretti autorizzati e la scansione delle serie e degli episodi supportati dal resolver StreamingCommunity/Vixcloud. La coda elabora fino a tre video contemporaneamente e riprova una volta in caso di inattività di FFmpeg. I file MP4 vengono verificati con ffprobe prima di apparire nella libreria.

Avvia il servizio seguendo il [README di StreamSuite](../README.md). La coda è in memoria e si azzera al riavvio.

## Coda e libreria

Pausa ferma il trasferimento e libera il posto in coda. Riprendi scarica di nuovo dall’inizio. Annulla rimuove il file parziale. Riprova rimette in coda un trasferimento fallito o annullato.

Scegli la **Libreria di destinazione** prima di incollare un link o un elenco. **Film** usa `Movies/Titolo (Anno)/Titolo (Anno).mp4`, con l'anno quando è disponibile. **Serie TV** usa `Serie TV/Nome serie/Season 01/Nome serie - S01E01.mp4`. **Cartoni** applica lo schema del film o dell'episodio sotto `Cartoni`. In modalità **Automatica**, un episodio numerato va in `Serie TV` e un titolo singolo riconoscibile in `Movies`. Un video generico rimane in `Video`. Puoi correggere il titolo e aggiungere l'anno tra parentesi.

Prima di trasferire un video, il downloader cerca corrispondenze nella libreria e nell'archivio, se montato. Riusa le cartelle di serie e stagione riconosciute, comprese quelle chiamate `Stagione 01`. In un lotto gli episodi mancanti proseguono. Per i doppioni, **Già esistente** mostra i percorsi trovati e offre **Salta** oppure **Scarica altra versione**, aggiungendo `- Versione 2` o il primo numero libero al nome. Quando leggibili, vengono mostrate risoluzione, codec e HDR della fonte e di un massimo di tre file presenti. L'indicazione maggiore o minore confronta le fasce di risoluzione. Per un link diretto privo di numero episodio, usa **Destinazione Jellyfin**.

AnimeUnity, AnimeSaturn e Toonitalia possono accodare gli episodi elencati nelle pagine pubbliche. Per Toonitalia il programma raccoglie i player supportati per episodio, riconosce la sigla iniziale come episodio 00 e prova i link alternativi in ordine. Prima del download controlla che l'indirizzo esponga un flusso video leggibile dal NAS.

## Importazione da Brave

Apri **Importa link da Brave, SerieLink o ToonLink** e carica `ToonLink_Jellyfin.crawljob`, oppure incolla i link uno per riga. Il file conserva titolo, stagione, numeri originali e sigla. Con un file ToonLink la destinazione automatica è **Cartoni**. L'app usa i percorsi configurati sul NAS. Accetta MP4, HLS non cifrati, embed Vixcloud compatibili e le pagine dei player VOE, LuluStream e Uqload riconosciute.

Da telefono puoi condividere o incollare direttamente la pagina Toonitalia. Premi **Leggi episodi Toonitalia**, scegli gli episodi o la sigla e premi **Accoda la selezione**. L'app prova la pagina pubblica e, in caso di errore, gli endpoint REST WordPress pubblici dello stesso sito. La coda verifica i flussi e prova i player alternativi disponibili. Se la fonte rifiuta tutte le richieste del NAS, l'app mostra gli errori restituiti.

Per StreamingCommunity puoi incollare anche una pagina film. Scegli **Film** o **Cartoni** secondo la destinazione che usi.

SerieLink esporta MP4 diretti o file .crawljob con nomi Jellyfin. Importali dalla stessa sezione. I link con scadenza già superata vengono rifiutati. Per StreamingCommunity il NAS preferisce un MP4 dichiarato dal player quando è disponibile, altrimenti usa HLS.

## Invio da telefono e archivio

Da telefono puoi aprire `/manager/` all'indirizzo di StreamSuite e incollare un link copiato dal menu Condividi. Su iPhone puoi usare un comando rapido con ingresso URL che apre `/manager/#url=` seguito dal link codificato. Il modulo si precompila e puoi verificare i campi prima di accodare.

Per collegare un archivio separato, usa `compose.archive.yaml` come indicato nel [README di StreamSuite](../README.md). Il servizio smista i file nelle cartelle omonime dell'archivio e mappa `Video` su `Movies`. Rimuove il file sorgente dopo aver verificato la copia con SHA-256 e averla pubblicata. L'archivio deve supportare gli hard link. La presenza di `.lsm-toshiba` nella radice abilita lo smistamento.

### Destinazione Jellyfin per una serie esistente

Prima di accodare, apri **Destinazione Jellyfin**. Usa il nome esatto della cartella della serie e la stagione della tua libreria. Per un singolo episodio puoi anche indicare un numero sostitutivo e il titolo dell'episodio. Per un gruppo di episodi usa nome serie e stagione: l'app mantiene i numeri della fonte.

Esempio: La leggendaria storia degli 883, stagione 2, episodio 7, titolo Nord Sud Ovest Est. Il risultato è `Serie TV/La leggendaria storia degli 883/Season 02/La leggendaria storia degli 883 - S02E07 - Nord Sud Ovest Est.mp4` (o MKV se necessario). Con l'archivio facoltativo attivo, questo percorso viene conservato nell'archivio. Con il solo Compose principale, il file rimane nella libreria di destinazione.
