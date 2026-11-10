/** All user-facing Czech texts: greetings, small talk, labels. */

export const GREETINGS = ['Dobré ráno!', 'Ahoj všichni!', 'Jdu na to.', 'Čau!', 'Tak co dneska?'];


export const IDLE_LINES = {
  coffee: ['Mmm, kafe ☕', 'Třetí dnes…', 'Espresso ☕', 'Kdo zase nedoplnil vodu?'],
  sofa: ['Góól! ⚽', 'Haha 😂', 'Přepni to…', 'Ještě jeden díl', 'Psst!', 'Tohle už jsem viděl'],
  browse: ['lol 😂', 'Kočičí videa 🐱', 'Hmm…', 'To je dobrý', 'Jen jeden článek…'],
  nap: ['Z z z…'],
  window: ['Musím si vyčistit hlavu…', 'Pěkný výhled.', 'Nádech… výdech…'],
  stroll: ['Protáhnout nohy…', 'Co je novýho?', 'Hmm, kam jsem to šel?', 'Jen se projdu', 'Kdo zase zabral tiskárnu?'],
};

/** Ghosts: employees whose terminal is open but who have had no work for a while. */
export const GHOST_LINES = ['Búúú… 👻', 'Nikdo mi nedává práci…', 'Jsem jen stín sebe sama', 'Úúú…', 'Kde je ten prompt?', 'Straším, dokud nepřijde úkol'];

/** Said when an employee switches into a mood (rate-limited, see entities/mood.js). */
export const MOOD_LINES = {
  frustrated: ['Proč to nejde?!', 'Zase chyba…', 'Grr 😤', 'To snad není možný'],
  stressed: ['Moc věcí najednou…', 'Kontext mi přetéká 😰', 'Hlavně klid…'],
  impatient: ['Haló? Potřebuju povolení…', 'Čekám a čekám ⌛', 'Šéfe? Šéééfe!'],
  tired: ['Potřebuju kafe…', '*zív*', 'Už nemůžu…'],
  bored: ['Nuda…', 'Nemáte pro mě něco?', 'Tak co dneska?'],
  happy: ['Jde to jak po másle!', 'Paráda ✨', 'Dneska mi to jde!'],
  content: ['S tebou je sranda 😄', 'Jsi dobrej parťák'],
  proud: ['Kdo je tady šéf? 😎', 'Zasloužil jsem si to.'],
  worried: ['Docházejí tokeny…', 'Snad to stihnu 😟'],
  overwhelmed: ['Tolik stážistů…', 'Pomoc 🌀', 'Kdo z vás co dělá?'],
  sad: ['Nic se nedaří ☁', 'Dneska to není ono…'],
};


/** The director (you) and the to-do list. */
export const DIRECTOR_LINES = {
  overdue: ['Tohle už mělo být hotové…', 'Termíny hoří 🔥', 'To nestíháme!'],
  today: ['Dneska toho je dost.', 'Jdeme na to 📋', 'Další do seznamu…'],
  clear: ['Všechno stíháme 😎', 'Čistý stůl!', 'Dneska hotovo ✓'],
  added: ['Zapsáno 📝', 'Mám to v seznamu.'],
  done: ['Odškrtnuto ✓', 'Jeden dole!', 'Hotovo, další!'],
};


export const DIALOGS = [
  ['Viděls ten nový framework?', 'Zase další? 🙄'],
  ['Kdo rozbil build?', 'Já ne!', 'Git blame říká, že ty 😅'],
  ['Jdeme na oběd?', 'Jasně, kam?', 'Vietnamské bistro?', 'Beru! 🍜'],
  ['Deploy v pátek?', 'Nikdy. 😱'],
  ['Tabs nebo spaces?', 'Spaces.', 'Tak to se nebavíme.'],
  ['Došlo kafe…', 'To je krize! ☕'],
  ['Kolik ti zbývá tokenů?', 'Radši se neptej.'],
  ['Máš ten ticket hotový?', 'Skoro…', 'Takže ne. 😄'],
  ['Viděls včera zápas?', 'Jo, bída.', 'Příště to bude lepší ⚽'],
  ['Code review?', 'Až po kafi.'],
  ['Kdo vypil moje mlíko?', '…', '🤐'],
  ['Zítra home office?', 'Jasně 🏠'],
  ['Ten bug v produkci…', 'To je feature!'],
  ['Refaktor?', 'Někdy příště.', 'Jako vždycky 😄'],
  ['Šéf dneska nic nezadává.', 'Psst, ať to nezakřikneš!'],
  ['Kdo napsal ty testy?', 'Nikdo, proto padaj.'],
];


export const ACTIVITY_CZ = {
  typing: 'píše kód', terminal: 'v terminálu', reading: 'čte / hledá', web: 'na webu', planning: 'plánuje',
  phone: 'volá (MCP)', thinking: 'přemýšlí', waiting: 'čeká na povolení', sleeping: 'dřímá', idle: 'volno',
  surfing: 'surfuje po internetu',
};

/** What the director is up to (entities/director.js beats), for the tooltip. */
export const DIRECTOR_CZ = { stroll: 'prochází se po kanceláři', phone: 'telefonuje', cabinet: 'hrabe se v kartotéce', board: 'stojí u nástěnky s úkoly', idle: 'rozhlíží se' };

export const IDLE_CZ = { coffee: 'pije kafe', sofa: 'kouká na televizi', chat: 'klábosí', browse: 'surfuje po internetu', nap: 'dřímá', sit: 'odpočívá', window: 'kouká z okna', stroll: 'prochází se po kanceláři' };


export const TOOL_CZ = {
  terminal: '⌨️ terminál', reading: '📖 čtení', editing: '✏️ psaní', web: '🌐 web',
  mcp: '☎️ MCP', planning: '📋 plán', agents: '🧑‍🎓 agenti', other: '🔧 ostatní',
};
