# StreamSuite

Web app per ZimaOS che riunisce StreamRadar IT e Local Stream Manager. Una sola porta serve la home, il catalogo e la libreria. Docker Compose avvia i due motori e il servizio che li presenta sotto lo stesso indirizzo.

| Percorso | Funzione |
| --- | --- |
| `/` | Home e collegamento per la schermata iniziale |
| `/radar/` | Novità, ricerca, schede e disponibilità sulle piattaforme italiane |
| `/manager/` | Importazione di link autorizzati, coda e nomi compatibili con Jellyfin |

Quando StreamRadar trova una scheda della fonte, **Apri in Local Stream Manager** precompila link, titolo e destinazione. Puoi rivedere i campi e scegliere gli episodi prima di accodarli.

## Avvio su ZimaOS

Per una prova accanto alle app già installate, copia il progetto in una cartella dedicata, per esempio `/DATA/AppData/StreamSuite-Prova`. Da quella cartella esegui `sudo bash scripts/zima-prova.sh IP-LAN-DEL-NAS`. Lo script crea il progetto Docker `streamsuite-prova` sulla porta `8790`, usa una cartella download locale e salva una password dedicata in `.env.prova`. Recupera solo le chiavi API dall'installazione esistente di StreamRadar. Se serve indicare un percorso diverso per il suo file `.env`, passalo come secondo argomento.

### Aggiorna la prova da Windows

Attendi che i download in coda siano terminati. Apri PowerShell su Windows e, dalla cartella del repository, esegui:

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\aggiorna-prova.ps1
```

Lo script pubblica il commit corrente nell'installazione di prova esistente in `/DATA/AppData/StreamSuite-Prova` e verifica i tre servizi sulla porta `8790`. Conserva i download e `.env.prova`. Se necessario, usa `-Nas` e `-Utente` per cambiare il destinatario o `-Ref` per selezionare un altro commit locale.

Se da Windows puoi accedere a ZimaOS via browser, usa lo stesso comando con `-SoloPacchetto`. Carica il file indicato dallo script con ZimaOS Files. Poi, dal terminale del NAS, sostituisci il percorso dell'archivio nel comando:

```bash
sudo test -f /DATA/AppData/StreamSuite-Prova/.env.prova && sudo tar -xzf "/DATA/percorso/streamsuite-prova.tar.gz" -C /DATA/AppData/StreamSuite-Prova && sudo bash /DATA/AppData/StreamSuite-Prova/scripts/zima-prova.sh 192.168.1.27
```

Per fermare la prova da una shell con accesso alla cartella del progetto, esegui `sudo env DOCKER_CONFIG="$PWD/.docker-cli" docker compose --env-file .env.prova -p streamsuite-prova down`.

Servono Docker Compose V2 e una cartella scrivibile per la libreria. Dalla radice del progetto esegui:

```sh
mkdir -p downloads
cp -i .env.example .env
chmod 600 .env
```

Imposta `LSM_PASSWORD` in `.env`. L'utente di Local Stream Manager è `admin`. Imposta anche `TMDB_READ_TOKEN` per la ricerca di StreamRadar, `STREAMING_API_KEY` per le novità per piattaforma e `OMDB_API_KEY` per i voti aggiuntivi. Le chiavi vanno nel file locale `.env`.

Per aprire StreamSuite da Android o da un altro dispositivo della rete domestica, imposta `APP_BIND_IP` sull'indirizzo LAN di ZimaOS. Il valore iniziale `127.0.0.1` accetta connessioni dal solo server. Per accesso da fuori casa usa la VPN oppure un proxy HTTPS.

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
```

Apri il browser all'indirizzo del server sulla porta `8790`. Su Android puoi aggiungere la home alla schermata iniziale dal menu del browser.

Per usare la libreria esistente, attendi che finisca la coda del vecchio Local Stream Manager, ferma quel container e imposta `LSM_DATA_PATH` sul percorso assoluto della stessa cartella. La libreria risiede sul disco. La coda vive in memoria e si azzera al riavvio.

Per collegare l'archivio facoltativo imposta `LSM_ARCHIVE_PATH` sul percorso assoluto della cartella già montata e avvia con `docker compose -f compose.yaml -f compose.archive.yaml up -d --build`. La presenza del file `.lsm-toshiba` nella radice dell'archivio attiva lo smistamento. I dettagli sono nella [guida del Manager](manager/README.md).

## Collaborazione

Crea un branch da `main` e apri una pull request per ogni modifica. Indica come riprodurre il problema, quali percorsi hai verificato e se la configurazione richiede nuove variabili. Per una nuova variabile condividi il nome e un valore vuoto o di esempio in `.env.example`.

- [StreamRadar IT](radar/README.md) usa Node.js 22. `GET /radar/healthz` verifica che il processo risponda.
- [Local Stream Manager](manager/README.md) usa Python 3.12 con FFmpeg e ffprobe. `GET /manager/jobs` restituisce la coda dopo l'autenticazione.
- `gateway/` serve la home e inoltra le richieste ai due servizi Docker. Verifica un cambio al passaggio fra le sezioni aprendo una scheda e controllando i campi precompilati nel Manager.
