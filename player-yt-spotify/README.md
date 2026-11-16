# Duetto

Web app per iPhone che funziona come Spotify, ma con **playlist ibride**: brani Spotify e brani da YouTube (solo audio) nella stessa playlist, riprodotti in sequenza passando da soli al player giusto.

Si installa da Safari con **"Aggiungi alla schermata Home"** e si apre a tutto schermo come un'app normale.

## Perché una web app (PWA) e non un'app nativa

| | App nativa (Swift) | **PWA (scelta)** |
|---|---|---|
| Serve un Mac | Sì (Xcode) | **No** |
| Durata dell'installazione | 7 giorni con Apple ID gratuito, oppure 99 $/anno | **Nessuna scadenza**: si installa una volta e basta |
| Aggiornamenti | Ricompilare e reinstallare | **Automatici** a ogni push su `main` |
| Spotify a schermo bloccato | L'SDK si disconnette in background | **I brani Spotify consecutivi continuano** (vengono passati a Spotify tutti insieme) |
| YouTube | Player incorporato, sempre visibile | Uguale |

Il prototipo nativo precedente resta nella cronologia git (commit `5d71637`).

## Come funziona

- **Spotify**: login OAuth con PKCE (nessun segreto nell'app), ricerca e import delle playlist con la Web API. La riproduzione avviene **nell'app Spotify** del telefono, comandata via Spotify Connect (serve **Premium**).
  I brani Spotify consecutivi vengono inviati come un unico blocco: Spotify li suona da solo, anche a schermo bloccato.
- **YouTube**: ricerca e import con la Data API v3. I brani YouTube suonano **solo scaricati sul telefono**: niente pubblicità, niente blocchi, anche a schermo spento e offline. Lo scaricamento lo fa il comando rapido "Scarica per Duetto" (app Comandi + a-Shell, guida in Impostazioni → YouTube → Scaricare i brani); poi si importano da Aggiungi → File, e prendono il posto del brano YouTube con lo stesso titolo. I brani non ancora scaricati vengono saltati con l'avviso "Scarica".
- **Passaggio tra i due**: quando finisce un blocco Spotify (rilevato con polling dello stato del player) parte il video successivo, e viceversa.
- **Dati**: playlist e chiavi restano sul telefono (playlist in IndexedDB, impostazioni in localStorage). Backup/ripristino con esporta/importa JSON.

### Funzionalità
- **Sincronizzazione Spotify**: le tue playlist Spotify (tue o collaborative) compaiono da sole in Libreria e si aggiornano all'apertura dell'app o tirando giù la Libreria. I brani aggiunti qui (anche da YouTube) restano anche dopo i sync; un brano tolto qui non torna.
- **Aggiungi** (dalla playlist, tasto ⊕): scheda Spotify o YouTube, cerca oppure incolla un link (brano, playlist, album Spotify; video o playlist YouTube). I brani diventano selezionabili, scegli quelli che vuoi e premi **Importa**.
- Playlist: crea, rinomina, **fissa in alto**, riordina trascinando (Modifica), togli brani con annulla. **Rimuovi da Duetto** toglie la playlist solo dall'app: su Spotify resta com'è e non torna con il sync.
- Player come Spotify: scorri il mini player o la copertina per cambiare brano, trascina il pallino per spostarti nel brano, mini player, player a schermo intero (si chiude trascinando in giù), casuale, ripeti, coda, scelta del dispositivo Spotify.
- Cerca: Spotify o YouTube, tocca per ascoltare, ⊕ per aggiungere a una playlist.
- Interfaccia nativa iOS: font di sistema con Dynamic Type, tema chiaro e scuro automatici, barre in vetro, gesti di sistema (scorri dal bordo per tornare, scorri un brano per toglierlo o metterlo dopo), VoiceOver.

## Struttura

```
web/                  # l'app (statica, nessuna build)
  index.html
  css/app.css
  js/app.js           # viste, navigazione, ricerca e import
  js/nowplaying.js    # mini player, player a schermo intero, coda
  js/sync.js          # sincronizzazione playlist Spotify
  js/player.js        # coordinatore della coda ibrida
  js/spotify.js       # login PKCE, Web API, Spotify Connect
  js/youtube.js       # Data API + player IFrame (riserva)
  js/ytaudio.js       # audio YouTube senza pubblicità (server Piped)
  js/store.js         # playlist (localStorage)
  js/util.js          # funzioni pure (link, durate, blocchi Spotify, unione sync)
  sw.js, manifest.webmanifest, icons/
tests/                # test con node --test
netlify.toml          # configurazione hosting
```

## Messa online (una volta sola, ~5 minuti)

Il repository è privato, quindi GitHub Pages gratuito non è disponibile. Netlify è gratis e si aggiorna da solo a ogni push:

1. Vai su <https://app.netlify.com> → accedi con GitHub.
2. **Add new site → Import an existing project → GitHub** → scegli `player-yt-spotify`.
3. Lascia i valori proposti (li legge da `netlify.toml`: publish `web`, nessuna build) → **Deploy**.
4. Otterrai un indirizzo tipo `https://nome-a-caso.netlify.app` (si può rinominare in *Site configuration → Change site name*).

In alternativa funziona identico su Cloudflare Pages (output directory: `web`, nessun comando di build).

## Configurazione

### Spotify
1. <https://developer.spotify.com/dashboard> → **Create app**.
2. **Redirect URI**: l'indirizzo del sito con la barra finale, es. `https://nome-a-caso.netlify.app/`.
   (È mostrato anche nell'app, in *Impostazioni*, con il pulsante Copia.)
3. API: seleziona **Web API**.
4. In *User Management* aggiungi l'email del tuo account Spotify.
5. Copia il **Client ID**.

> Regole Spotify per le app in Development Mode (da febbraio 2026): serve Premium, massimo 5 utenti, la ricerca restituisce 10 risultati per pagina e si possono importare solo playlist tue o collaborative. Per uso personale va bene.

### YouTube
1. <https://console.cloud.google.com> → nuovo progetto.
2. *API e servizi → Libreria* → abilita **YouTube Data API v3**.
3. *Credenziali → Crea credenziali → Chiave API*.
4. **Consigliato**: limita la chiave a *Referrer HTTP* con il tuo dominio (es. `https://nome-a-caso.netlify.app/*`) e all'API YouTube Data.

### Sull'iPhone
1. Apri l'indirizzo del sito in **Safari** → **Condividi** → **Aggiungi alla schermata Home**.
2. Apri l'app dall'icona → **Impostazioni**: incolla Client ID e chiave YouTube → **Accedi** a Spotify.
3. Apri una volta l'app Spotify (così il telefono compare come dispositivo), poi crea una playlist e premi **Riproduci**.

Le impostazioni dell'app installata sono separate da quelle di Safari: configura dall'icona sulla Home.

## Sviluppo locale

```bash
npm start      # http://127.0.0.1:8000  (aggiungi http://127.0.0.1:8000/ come redirect URI Spotify)
npm test       # test automatici
```

## Limiti noti
- **Nessuna scadenza**: l'app installata dalla Home non scade e i suoi dati non vengono cancellati da iOS (l'app chiede anche la memoria persistente). L'accesso a Spotify si rinnova da solo.
- **Server audio**: i server Piped pubblici a volte smettono di funzionare; l'app prova da sola quelli noti, poi ripiega sul player ufficiale.
- **Avvio dell'audio YouTube su iOS**: Safari può bloccare la partenza senza un tocco. In quel caso il pulsante play pulsa: toccalo. Di solito succede solo la prima volta in una sessione.
- **YouTube a schermo bloccato**: iOS ferma l'audio di YouTube quando l'app va in background (i brani Spotify invece continuano).
- **Da Spotify a YouTube serve l'app aperta**: un blocco di brani Spotify suona anche a schermo bloccato, ma il passaggio al video successivo avviene quando riapri l'app.
- **Spotify deve poter suonare sul telefono**: Spotify non permette a nessun'altra app di trasmettere la sua musica su iPhone (il suo lettore per il web non funziona su iOS), quindi l'audio lo suona sempre l'app Spotify. Non serve tenerla aperta davanti: basta che non sia chiusa del tutto. Se iOS l'ha chiusa, Duetto mostra **Apri Spotify**: un tocco, torni in Duetto e la riproduzione riparte da sola.
- **Impostazione da attivare in Spotify**: nell'app Spotify → Impostazioni → Dispositivi (o "Riproduzione") attiva **Spotify Connect in background**, se c'è. Senza, iOS non lascia ricevere i comandi a Spotify quando non è in primo piano.
- **Errori temporanei di Spotify** (502, 503, troppe richieste): vengono ritentati in automatico.
- **A schermo bloccato**: i brani YouTube suonano e passano da soli al successivo (anche a Spotify), con i comandi sulla schermata di blocco. Su iOS 26 ci sono segnalazioni di bug di Apple sull'audio delle web app (es. audio muto dopo una riapertura, finché non si riavvia il telefono).
- **Da Spotify a YouTube serve Duetto aperto**: per passare da un brano Spotify a uno YouTube l'app deve essere in primo piano, perché iOS sospende le web app in background. Se iOS chiude Duetto, alla riapertura la coda riprende da dove era.
- **Quota YouTube**: ogni ricerca costa 100 unità su 10.000 giornaliere (~100 ricerche al giorno).
- **Video non incorporabili** (errore 101/150): vengono saltati automaticamente.
