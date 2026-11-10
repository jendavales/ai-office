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

- **Klik na zaměstnance** → přepne do jeho terminálu (Terminal.app a iTerm2 i na konkrétní záložku, ostatní aplikace
  jako Warp, PhpStorm a VS Code se jen aktivují). Hook kvůli tomu posílá TTY procesu Claude.
- **Notifikace macOS** (když okno kanceláře není v popředí): žádost o povolení, hotový úkol delší než 20 s, chyba API,
  povýšení. Klik na notifikaci přepne do terminálu. Vypínají se v menu ikony.
- **Zaměstnanci a kariéra**: každá session dostane náhodné jméno a vzhled. Kariéru má projekt (XP: +1 za nástroj,
  +10 za úkol; Junior → Medior → Senior → Lead → Ředitel) – s úrovní přibývají brýle, kravata, sluchátka a oblek.
  Worktrees (`.claude/worktrees/…`, `.worktrees/…`) patří k projektu repozitáře, chaty bez projektu mají jeden společný.
- **Historie** (jako ccusage): při prvním startu se jednorázově načtou minulé konverzace z `~/.claude/projects`
  a doplní projektům kariéru (XP), úkoly, odpracovaný čas a výplatu (cena tokenů podle ceníku API) za všechno, co se
  stalo před začátkem živého sledování. Úkol = dokončená odpověď (Stop), nástroje včetně subagentů, obnovené sessions
  se nepočítají dvakrát, běhy v `/tmp` se přeskočí. Vše lokálně; před zápisem vznikne `office-data.json.bak-before-history`.
  Náhled: `npm run backfill`. Vypnout: `AI_OFFICE_NO_HISTORY=1`.
- **Statistiky** (klik na tabuli nebo portrét, nebo menu ikony): úkoly, odpracovaný čas, výplata a nástroje za dnešek
  a 7 dní po projektech. Na zdi visí portrét **projektu týdne**. Data jsou v `~/Library/Application Support/ai-office/office-data.json`.
- **Plan mód** → porada u tabule s diagramem.
- **Chyba nástroje** → zaměstnanec se chytá za hlavu a z monitoru se kouří. **Došly tokeny** (`StopFailure`
  rate_limit nebo 0 % v limitech) → stávka s transparenty až do resetu.
- **Kontext** ze status line: čím plnější, tím víc hrnků na stole, od 75 % se potí. Cena session = výplata.
- **Emoce**: každý má náladu (pohoda a energie), kterou posouvají události. Opakované chyby → 💢 frustrace,
  dlouhé čekání na povolení → ⌛ netrpělivost, plný kontext → 💦 stres, dlouhá práce nebo noc → 💤 únava,
  commit nebo hotový dlouhý úkol → ♪ radost (ruce nahoru), povýšení → ⭐ hrdost, 3+ stážisti → 🌀 zahlcení.
  Je to vidět na výrazu obličeje, ikonce u hlavy, tempu psaní a v hláškách. Nálada řídí i pauzy
  (unavený jde na kafe, frustrovaný kouká z okna) a kdo spolu často klábosí, stanou se kamarády.
- **Kancelář** pobočky vymyšlené firmy *Papírna Svišť*: prosklená kancelář vedoucího (sedí v ní zaměstnanec
  s úrovní Lead a výš, jinak až když je plný open space) a zasedačka s tabulí (porady v plan módu, okno pro
  frustrované), kuchyňka s automatem, recepce u vchodu, open space se dvěma řadami stolů a odpočívárna
  s kopírkou, televizí a gaučem.
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
  store.js              kariéra projektů (XP), náhodná jména, denní statistiky (office-data.json)
  history.js            jednorázový import historie z ~/.claude/projects (ceník, dedup, testovaný)
  focus.js              přepnutí do terminálu podle TTY
renderer/src/           renderer (ES moduly, bez buildu)
  main.js               vstupní bod – IPC, obnova stavu, smyčka
  state.js              sdílený stav (workers, limity, nastavení)
  core/                 canvas a kreslicí primitiva, utility, paleta
  world/layout.js       půdorys kanceláře, místa a trasy
  entities/             zaměstnanci, stážisti, vzhled, nálady (mood.js), flákání a rozhovory
  draw/                 postavy, monitory, nábytek, místnost, bubliny
  life/                 kočka, vysavač, konfety, noční osvětlení
  ui/                   spodní lišta, tooltip a klikání, statistiky
  content/texts.js      všechny české texty (hlášky, dialogy, popisky)
  events.js             reakce na události z hlavního procesu
hooks/                  skripty volané Claude Code (hook + status line)
test/                   jednotkové testy
```
