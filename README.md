# Lucifer Dashboard

Dashboard desktop multipiattaforma realizzata con Rust e Tauri 2. La schermata iniziale mostra una griglia di accessi rapidi personalizzabili per applicazioni, siti web e documenti. I dati restano nella cartella dati dell'applicazione; i link si aprono nel browser predefinito e i file con l'app associata al sistema.

## Avvio in sviluppo

Requisiti: Rust stable con Cargo, Node.js 20+, npm e i prerequisiti Tauri per il proprio sistema operativo. Su macOS servono Xcode Command Line Tools; su Windows Microsoft C++ Build Tools e WebView2; su Linux WebKitGTK 4.1 e le dipendenze di sviluppo Tauri.

```sh
npm install
npm run tauri dev
```

Per generare il pacchetto installabile:

```sh
npm run tauri build
```

Per creare i pacchetti delle tre piattaforme, la build va eseguita su ciascun sistema (oppure tramite una pipeline CI con runner Windows, macOS e Linux).
