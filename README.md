# AI Office

Pixel-art kancelář, ve které se zaměstnanci objeví jen tehdy, když na počítači běží AI agent.
Každá session Claude Code = jeden zaměstnanec, každý subagent = stážista se zelenou kšiltovkou.

## Spuštění

```bash
npm install
npm run install-hooks   # zaregistruje hook v ~/.claude/settings.json (se zálohou)
npm start               # okno + ikona v menu baru
```

- `npm run install-app` – sestaví `AI Office.app` (ad-hoc podpis) a nainstaluje do `~/Applications`
- `npm run dist` – jen sestaví aplikaci do `dist/`
- `npm run demo` – přehraje ukázkový scénář do běžící aplikace (bez reálného agenta)
- `npm run backfill` – náhled, co se načte z historie konverzací (jen čte, nic nezapisuje)
- `npm run uninstall-hooks` – odebere hooky (ostatní hooky zůstanou)
- Ikona v menu baru: klik = mini kancelář, pravý klik = menu (vždy navrchu, spouštět po přihlášení, demo, konec)
- Zavřením okna aplikace nekončí, běží dál v menu baru.

## Úkoly přímo z kanceláře

Kancelář umí sessions i řídit, takže Claude desktop ani terminál nepotřebuješ:

- **💬 Konverzace**: panel vedle kanceláře se seznamem **všech Claude konverzací** v počítači (`~/.claude/projects` –
  z kanceláře, z Claude desktopu i z terminálu), seskupený podle projektu (skupiny jdou sbalit). Ikona u řádku: ⚙ pracuje ·
  ● session běží · ○ z kanceláře · 🖥 Claude desktop · ⌨ terminál · 🤖 SDK. Tlačítko v liště panel ukáže nebo schová,
  ⌘K skočí do **hledání** (názvy, projekty i text zpráv), **📥 Archiv** ukáže archivované. Názvy vznikají automaticky
  jako v desktopu, **✎** konverzaci přejmenuje (prázdné = zpět na automatický název), **📥** ji archivuje.
- **＋ Nový úkol** (⌘N): vybereš projekt (týmy, které kancelář zná, nebo „Jiná složka…“), model a effort a napíšeš,
  co se má udělat. Úkol převezme volný člen týmu, přijde do kanceláře a v panelu se otevře jeho konverzace.
- **Klik na konverzaci** v seznamu (nebo na zaměstnance session, kterou spustila kancelář) ji otevře. Odpověď se streamuje,
  přemýšlení a nástroje jsou sbalené řádky (klik ukáže vstup a výstup), další zprávu můžeš napsat i během práce a přijde na řadu.
  Dole přepneš **model a effort** (platí od další odpovědi), v hlavičce je vidět, s čím session běží (u konverzace, která
  neběží, model její poslední odpovědi); klik na název ji přejmenuje.
  Rozepsaná zpráva zůstane jako koncept i po zavření panelu nebo restartu. **■ Zastavit** přeruší rozdělanou práci,
  **🏠 Domů** ukončí session, **‹** nebo Esc vrátí na seznam.
- U tvé zprávy (po najetí myší nebo Tabem): **↶ Vrátit sem** vrátí konverzaci před tu zprávu – pozdější zprávy zmizí (přepis zůstane
  v `~/.claude`) a text se vloží do pole pro novou zprávu; **⑂ Větvit odsud** udělá kopii až po odpověď na ni, originál zůstane.
- **Odpověď do konverzace z Claude desktopu nebo terminálu** vytvoří její kopii v kanceláři (jako `--fork-session`)
  se stejným názvem i vlastníkem; model a effort vybrané předem platí už pro ni. Původní zůstane, kde byla.
- Po restartu aplikace se konverzace načtou z historie Claude Code. Na první zprávu zaměstnanec znovu přijde do práce.

## Ředitel a úkoly z Todoistu

V prosklené kanceláři vedoucího se prochází **ředitel** – to jsi ty. Hlídá tvoje úkoly z [Todoistu](https://todoist.com):

- **Klik na ředitele** (nebo položka *Úkoly ředitele (Todoist)…* v menu ikony) otevře vedle kanceláře panel s úkoly.
  Napoprvé chce **osobní API token**: v Todoistu *Nastavení → Integrace → Vývojář*, odkaz je přímo v panelu.
  Token ověří, uloží zašifrovaný klíčenkou macOS (Electron `safeStorage`) do `~/Library/Application Support/ai-office/todoist.json`
  a posílá ho jen na `api.todoist.com`. Ozubené kolečko v panelu token změní nebo zapomene.
- **Filtry podle termínu**: *Dnes* (včetně úkolů po termínu), *7 dní*, *Vše*, *Bez termínu*, nebo libovolné datum
  v políčku *do* (úkoly s termínem nejpozději ten den). Seznam je seskupený: po termínu, dnes, zítra, tento týden, později, bez termínu.
- **Nový úkol** dole v panelu: text, termín (předvyplní se podle filtru), projekt a priorita, Enter přidá.
  V textu fungují **zkratky jako v Todoistu** a hned pod políčkem je vidět, co znamenají (políčka
  termín/projekt/priorita se podle nich přepnou): `!!1` … `!!4` nebo `p1` … `p4` priorita (1 = nejvyšší),
  `#skola` projekt (bez ohledu na diakritiku a velikost písmen, stačí jednoznačný začátek názvu, jde i název
  s mezerami), `@štítek` štítek, termín slovy – `dnes`, `zítra`, `pozítří`, `v pátek`, `příští úterý`,
  `příští týden`, `za 3 dny`, `za týden`, `za měsíc`, `12. 11.`, `12. 11. 2027`, `2026-12-24` (česky i anglicky),
  čas `14:00` nebo `v 14:00` (bez data na den z políčka termín, jinak dnes) a `// popis` – všechno za `//` je popis
  úkolu. Zkratky se z textu úkolu odstraní; neznámý `#projekt` v textu zůstane a panel na něj upozorní. Opakované
  termíny (`každý den`) zkratky zatím neumí.
  **Termín** existujícího úkolu změníš klikem na jeho datum (📅), tamtéž jde i zrušit. Kolečko vlevo = hotovo,
  klik na text otevře úkol v Todoistu. Zobrazí se i priorita (⚑ p1–p3), čas, opakování (↻) a případný Todoist *deadline* (⏰).
- Seznam se obnovuje každou minutu. Ředitel nemá stůl ani počítač – na jeho místě stojí **nástěnka na kolečkách**
  se sloupci *Hoří*, *Dnes* a *Pak* a za každý úkol na ní visí jeden lísteček: červený po termínu, žlutý na dnes,
  zelený do týdne. Žádná čísla, kolik je práce, je vidět na první pohled. Nový úkol na nástěnku naskočí, hotový se
  napřed přeškrtne a pak zmizí, prázdná nástěnka se usmívá. Klik na nástěnku otevře panel stejně jako klik na ředitele.
- Ředitel se prochází po kanceláři a rozhlíží se, telefonuje, hrabe se v kartotéce, a když přibudou termíny,
  jde s fixou k nástěnce. Podle termínů se tváří a občas něco prohodí.
- Používá se Todoist API v1 (starší REST v2 a Sync v9 už Todoist vypnul). Termín = *due date* úkolu.

Pod kapotou je to totéž co v Claude desktopu: pro každou session běží oficiální `claude -p --input-format stream-json
--output-format stream-json` s přihlášením Claude Code CLI (tedy na předplatné). Kancelář posílá zprávy přes stdin
a čte proud JSON zpráv. Prostředí se bere z login shellu, aby `claude`, `git` a spol. našly cestu i při spuštění z Finderu.
Režim povolení se řídí tvým nastavením Claude Code. Dialog pro povolování zatím není, takže nástroj, který by se ptal,
se zamítne a v konverzaci se objeví upozornění. Nejlépe to funguje s režimem `auto`.

## Jak to funguje

```
Claude Code hook ──► hooks/office-hook.sh ──curl──► 127.0.0.1:4747/event ──IPC──► canvas
```

| Hook | Ve hře |
|---|---|
| `SessionStart` | zaměstnanec přijde do kanceláře |
| `UserPromptSubmit` | dostane úkol (žlutá bublina s promptem) |
| `PreToolUse` | pracuje: terminál, čtení, psaní kódu, web, MCP = telefon, TodoWrite = plánování |
| `PreToolUse` Agent/Task / `SubagentStop` | přijde / odejde stážista |
| `Notification` (povolení) | zvedne ruku, monitor bliká, zazní zvuk, v menu baru se objeví ❗ |
| `Stop` | „Hotovo ✓“ + zvuk, jde si pro kafe, na tabuli přibude čárka |
| `SessionEnd` | odchází domů |

**Volno:** když session čeká na tvůj vstup, zaměstnanec se fláká (čistě lokálně, žádné tokeny):
kafe u linky, televize na gauči, klábosení s dalším volným kolegou, surfování (videa, kočky), chvíle u stolu
a po 5 minutách nečinnosti i šlofík. Jakmile přijde práce, všeho nechá a vrátí se ke stolu.

**Limity předplatného:** `install-hooks` nastaví i `statusLine` (`hooks/office-statusline.sh`), pokud žádnou
vlastní nemáš. Claude Code jí předává `rate_limits` (5h okno a týden), skript je pošle do AI Office a v terminálu
vypíše `📁 složka · model · ⛽ 5h 77 % · týden 59 %`. V kanceláři je panel „5h / 7d“ pod hodinami a detail
s časem resetu ve spodní liště. Data přichází jen u předplatného Pro/Max a až po první odpovědi v session.

**Interakce a život v kanceláři**

- **Klik na zaměstnance** → u session spuštěné kanceláří otevře konverzaci, jinak přepne do jeho terminálu (Terminal.app a iTerm2 i na konkrétní záložku, ostatní aplikace
  jako Warp, PhpStorm a VS Code se jen aktivují). Hook kvůli tomu posílá TTY procesu Claude.
- **Notifikace macOS** (když okno kanceláře není v popředí): žádost o povolení, hotový úkol delší než 20 s, chyba API,
  povýšení. Klik na notifikaci přepne do terminálu. Vypínají se v menu ikony.
- **Zaměstnanci a kariéra**: každý projekt má stálý tým. Session převezme první volný člen týmu a každá další
  souběžná session přivede dalšího – pořád tytéž lidi se stálým jménem a vzhledem. Každá konverzace má stálého
  vlastníka: když se k ní vrátíš (i po restartu nebo „🏠 Domů“), dostane ji zase on; dělá-li zrovna jinde, zaskočí
  za něj volný kolega (v kanceláři i v panelu konverzace je vidět „zastupuje …“). Větev, rewind i kopie cizí konverzace vlastníka dědí. Každý má vlastní kariéru
  (XP: +1 za nástroj, +10 za úkol; Junior → Medior → Senior → Lead → Ředitel) – s úrovní přibývají brýle, kravata,
  sluchátka a oblek. Projekt = git repozitář: jeho podsložky i worktrees (`.claude/worktrees/…`, `.worktrees/…`)
  patří k němu, chaty bez projektu mají jeden společný.
- **Historie** (jako ccusage): při prvním startu se jednorázově načtou minulé konverzace z `~/.claude/projects`
  a doplní hlavnímu zaměstnanci každého projektu kariéru (XP), úkoly, odpracovaný čas a výplatu (cena tokenů podle ceníku API) za všechno, co se
  stalo před začátkem živého sledování. Úkol = dokončená odpověď (Stop), nástroje včetně subagentů, obnovené sessions
  se nepočítají dvakrát, běhy v `/tmp` se přeskočí. Vše lokálně; před zápisem vznikne `office-data.json.bak-before-history`.
  Náhled: `npm run backfill`. Vypnout: `AI_OFFICE_NO_HISTORY=1`.
- **Statistiky** (klik na tabuli nebo portrét, nebo menu ikony): úkoly, odpracovaný čas, výplata a nástroje po zaměstnancích
  za dnešek, 7 dní a **Celkem** (všichni za celou dobu, i ti, kdo zrovna v kanceláři nesedí). Na zdi visí portrét
  **zaměstnance týdne**, ve statistikách je i **projekt týdne** (práce celého týmu). Data jsou v `~/Library/Application Support/ai-office/office-data.json`
  (denní statistiky 60 dní, celkové součty napořád).
- **Plan mód** → porada u tabule s diagramem.
- **Chyba nástroje** → zaměstnanec se chytá za hlavu a z monitoru se kouří. **Došly tokeny** (`StopFailure`
  rate_limit nebo 0 % v limitech) → stávka s transparenty až do resetu.
- **Kontext** ze status line: čím plnější, tím víc hrnků na stole, od 75 % se potí. Cena session = výplata.
- **Emoce**: každý má náladu (pohoda a energie), kterou posouvají události. Opakované chyby → 💢 frustrace,
  dlouhé čekání na povolení → ⌛ netrpělivost, plný kontext → 💦 stres, dlouhá práce nebo noc → 💤 únava,
  commit nebo hotový dlouhý úkol → ♪ radost (ruce nahoru), povýšení → ⭐ hrdost, 3+ stážisti → 🌀 zahlcení.
  Je to vidět na výrazu obličeje, ikonce u hlavy, tempu psaní a v hláškách. Nálada řídí i pauzy
  (unavený jde na kafe, frustrovaný kouká z okna) a kdo spolu často klábosí, stanou se kamarády.
- **Kancelář** pobočky vymyšlené firmy *Papírna Svišť*: prosklená kancelář vedoucího (prochází se v ní ředitel – ty –
  s nástěnkou úkolů z Todoistu) a zasedačka s tabulí (porady v plan módu, okno pro frustrované), kuchyňka s automatem,
  recepce u vchodu, open space se dvěma řadami stolů a odpočívárna s kopírkou, televizí a gaučem.
  Když jsou stoly v open space plné, další zaměstnanci pracují s notebookem na gauči.
- **Pohyb**: cesty hledá A* po mřížce (`renderer/src/world/path.js`) s náhodnými cenami polí a občasnou
  zajížďkou, takže nikdo nechodí pořád stejně. Každý má vlastní tempo chůze, klábosí se pokaždé jinde
  a znudění se jen tak procházejí po kanceláři. Kočka i vysavač obcházejí nábytek a stěny.
- **Duchové**: kdo je přes 5 minut bez práce, ale jeho session (terminál) pořád běží, promění se v obláčku mlhy
  v ducha. Ten se vznáší kudy chce, i skrz zdi a stoly, občas straší pracujícího kolegu a v noci slabě svítí.
  Jakmile přijde prompt, žádost o povolení nebo stážista, zase se zhmotní a jde ke stolu. Při stávce se
  duchové nedělají.
- **Život**: kočka Bajt (dá se pohladit), robotický vysavač v prázdné kanceláři, konfety při `git commit`/`push`,
  večer a v noci zhasnuto a svítí jen stoly, lampa a televize.

Hook běží na pozadí (~7 ms), nic nevypisuje a nikdy neblokuje Clauda. Bez spuštěné aplikace tiše selže.

**Jiné AI** (Codex, Gemini CLI, Aider, OpenCode, Cursor Agent) se detekují přes `ps` každých 5 s.
Podle zátěže CPU se odhaduje, jestli pracují nebo mají volno. Konkrétní nástroje u nich vidět nejsou.

## Konfigurace

- `AI_OFFICE_PORT` – port serveru (výchozí 4747), stejná proměnná platí pro hook
- `AI_OFFICE_SCREENSHOT=/cesta.png npm start` – přehraje demo, uloží screenshot a skončí (pro vývoj)
- `AI_OFFICE_DEMO=idle` – demo se čtyřmi nečinnými sessions (flákání, klábosení)
- `AI_OFFICE_EVAL='…'` – JS spuštěný v rendereru 8 s po startu (při screenshotu); moduly jsou dostupné přes `window.__office`
- `AI_OFFICE_CLAUDE_BIN=/cesta` – jiný `claude` pro konverzace (testy používají `scripts/fake-claude.js`)

## Vývoj

```bash
npm test          # ESLint + jednotkové testy (node:test) + smoke test celé aplikace
npm run lint
npm run test:unit
npm run test:smoke   # spustí appku s demem, vynutí stavy (noc, stávka, statistiky), selže při chybě v rendereru
```

```
src/                    hlavní proces (CommonJS)
  main.js               okna, tray, HTTP server, sessions, notifikace
  hook-events.js        převod payloadů hooků na události kanceláře (čistá logika, testovaná)
  store.js              zaměstnanci (týmy projektů, jména, kariéra), vlastníci konverzací, denní statistiky (office-data.json)
  project.js            projekt podle git repozitáře (podsložky, worktrees, chaty bez projektu)
  history.js            jednorázový import historie z ~/.claude/projects (ceník, dedup, testovaný)
  agent.js              sessions spuštěné kanceláří: proces claude na session, stdin/stdout, přerušení, obnova
  conversations.js      seznam všech Claude konverzací z ~/.claude/projects: index, názvy, model, hledání, archiv (testovaný)
  stream-events.js      stream-json / transcript → položky konverzace (čistá logika, testovaná)
  todoist.js            úkoly ředitele: Todoist API v1, token přes safeStorage, polling, zápisy (testovaný)
  focus.js              přepnutí do terminálu podle TTY
renderer/src/           renderer (ES moduly, bez buildu)
  main.js               vstupní bod – IPC, obnova stavu, smyčka
  state.js              sdílený stav (workers, limity, nastavení)
  core/                 canvas a kreslicí primitiva, utility, paleta
  world/layout.js       půdorys kanceláře, místa a trasy
  entities/             zaměstnanci, stážisti, ředitel (director.js), vzhled, nálady (mood.js), flákání a rozhovory
  draw/                 postavy, monitory, nábytek, místnost, nástěnka ředitele (taskboard.js), bubliny
  todo/                 panel ředitele: model úkolů (filtry podle termínu, testovaný), stav, Preact UI
  life/                 kočka, vysavač, konfety, noční osvětlení
  ui/                   spodní lišta, tooltip a klikání, statistiky
  content/texts.js      všechny české texty (hlášky, dialogy, popisky)
  events.js             reakce na události z hlavního procesu
  chat/                 panel: seznam konverzací (list.js), konverzace (panel.js), dialogy Nový úkol a Vrátit sem (Preact + htm, marked, DOMPurify bez buildu)
hooks/                  skripty volané Claude Code (hook + status line)
scripts/fake-claude.js  náhrada claude pro testy (streamuje odpověď, umí přerušení, žádné tokeny)
test/                   jednotkové testy
```
