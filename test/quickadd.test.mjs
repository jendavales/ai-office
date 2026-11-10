import test from 'node:test';
import assert from 'node:assert/strict';
import { fold, hasMacros, parseQuickAdd } from '../renderer/src/todo/quickadd.js';

const TODAY = '2026-11-10'; // a Tuesday
const projects = [
  { id: 'p1', name: 'Inbox', inbox: true }, { id: 'p2', name: 'Škola', inbox: false }, { id: 'p3', name: 'Kancelář', inbox: false },
  { id: 'p4', name: 'Moje škola', inbox: false }, { id: 'p5', name: 'Kamarádi', inbox: false },
];
const parse = (text) => parseQuickAdd(text, { projects, today: TODAY });

test('plain text is just the content', () => {
  const p = parse('  Zavolat   účetní ');
  assert.equal(p.content, 'Zavolat účetní');
  assert.deepEqual([p.priority, p.projectId, p.labels, p.due, p.time, p.description], [null, null, [], null, null, '']);
  assert.equal(hasMacros(p), false);
  assert.equal(parse('').content, '');
});

test('priority: !!1 and p1 are the highest (Todoist 4), !!4 / p4 none (1)', () => {
  assert.equal(parse('Zaplatit daně !!1').priority, 4);
  assert.equal(parse('!!2 Zaplatit daně').priority, 3);
  assert.equal(parse('Zaplatit p3 daně').priority, 2);
  assert.equal(parse('Zaplatit daně P4').priority, 1);
  assert.equal(parse('Zaplatit daně !!1').content, 'Zaplatit daně');
  assert.equal(parse('!!2 Zaplatit daně').content, 'Zaplatit daně');
  assert.equal(parse('Zaplatit p3 daně').content, 'Zaplatit daně');
  // not a shortcut: glued to a word, out of range
  assert.equal(parse('Opravit p1x').priority, null);
  assert.equal(parse('Opravit !!5').priority, null);
  assert.equal(parse('Opravit !!5').content, 'Opravit !!5');
  assert.equal(parse('Vyzvednout top1').content, 'Vyzvednout top1');
});

test('project: #name regardless of case and diacritics, names with spaces, a unique prefix', () => {
  let p = parse('Domácí úkol #skola');
  assert.deepEqual([p.projectId, p.project, p.content], ['p2', 'Škola', 'Domácí úkol']);
  assert.equal(parse('#ŠKOLA úkol').projectId, 'p2');
  assert.equal(parse('#škola úkol').content, 'úkol');
  p = parse('Úkol #moje škola zítra');
  assert.deepEqual([p.projectId, p.content, p.due], ['p4', 'Úkol', '2026-11-11']);
  p = parse('Objednat papír #kanc');
  assert.deepEqual([p.projectId, p.content], ['p3', 'Objednat papír']);
  p = parse('Objednat #Inbox papír');
  assert.deepEqual([p.projectId, p.content], ['p1', 'Objednat papír']);
  // the cut is what was typed: extra spaces, a label in between, punctuation after the name
  p = parse('Úkol #moje  škola zítra');
  assert.deepEqual([p.projectId, p.content, p.due], ['p4', 'Úkol', '2026-11-11']);
  p = parse('Úkol #moje @doma škola');
  assert.deepEqual([p.projectId, p.labels, p.content], ['p4', ['doma'], 'Úkol']);
  p = parse('Koupit #skola, zítra');
  assert.deepEqual([p.projectId, p.content, p.due], ['p2', 'Koupit,', '2026-11-11']);
  p = parse('Úkol #moje škola, zítra');
  assert.deepEqual([p.projectId, p.content], ['p4', 'Úkol,']);
  p = parse('Koupit #kanc. papír'); // a unique prefix, punctuation stays
  assert.deepEqual([p.projectId, p.content], ['p3', 'Koupit. papír']);
  p = parseQuickAdd('Koupit #, zítra', { projects: [projects[1]], today: TODAY }); // no name: not a prefix of every project
  assert.deepEqual([p.projectId, p.unknownProject, p.content], [null, '#,', 'Koupit #,']);
});

test('an unknown or ambiguous #project stays in the text and is reported', () => {
  let p = parse('Koupit #nic zítra');
  assert.deepEqual([p.projectId, p.unknownProject, p.content], [null, '#nic', 'Koupit #nic']);
  p = parse('Koupit #ka'); // Kancelář or Kamarádi
  assert.deepEqual([p.projectId, p.unknownProject, p.content], [null, '#ka', 'Koupit #ka']);
  p = parse('Koupit #nic #skola');
  assert.deepEqual([p.projectId, p.unknownProject, p.content], ['p2', '#nic', 'Koupit #nic']);
  assert.equal(parse('Zavolat na C#').content, 'Zavolat na C#');
  assert.equal(parse('Issue #42').unknownProject, '#42');
  assert.equal(hasMacros(parse('Issue #42')), true);
});

test('labels: @name, several, no duplicates, e-mails untouched, punctuation stays in the text', () => {
  let p = parse('Koupit mléko @nákup @doma @nákup');
  assert.deepEqual(p.labels, ['nákup', 'doma']);
  assert.equal(p.content, 'Koupit mléko');
  const mail = parse('Napsat na jan@firma.cz @práce');
  assert.deepEqual([mail.labels, mail.content], [['práce'], 'Napsat na jan@firma.cz']);
  p = parse('Koupit mléko @nákup, chleba');
  assert.deepEqual([p.labels, p.content], [['nákup'], 'Koupit mléko, chleba']);
  p = parse('Zavolat @doma!');
  assert.deepEqual([p.labels, p.content], [['doma'], 'Zavolat!']);
  assert.deepEqual(parse('Opravit @v1.2').labels, ['v1.2']);
  // duplicates regardless of case and diacritics; the first spelling wins
  assert.deepEqual(parse('@Doma @doma').labels, ['Doma']);
  assert.deepEqual(parse('@nákup @NAKUP').labels, ['nákup']);
  assert.equal(parse('@Doma @doma').content, '');
});

test('description after //', () => {
  const p = parse('Zavolat účetní // kvůli DPH za říjen !!1');
  assert.equal(p.content, 'Zavolat účetní');
  assert.equal(p.description, 'kvůli DPH za říjen !!1'); // shortcuts belong to the task text, not the description
  assert.equal(p.priority, null);
  assert.equal(parse('Projít https://example.com/x // poznámka').content, 'Projít https://example.com/x');
  assert.equal(parse('Projít https://example.com/x').content, 'Projít https://example.com/x');
  assert.equal(parse('Dnes // jen popis').content, '');
});

test('due date words, Czech and English, with or without diacritics', () => {
  const due = (text) => parse(text).due;
  let p;
  assert.equal(due('Zavolat dnes'), '2026-11-10');
  assert.equal(due('Zavolat today'), '2026-11-10');
  assert.equal(due('Zavolat zítra'), '2026-11-11');
  assert.equal(due('Zavolat zitra'), '2026-11-11');
  assert.equal(due('Zavolat tomorrow'), '2026-11-11');
  assert.equal(due('Zavolat pozítří'), '2026-11-12');
  assert.equal(parse('Zavolat zítra účetní').content, 'Zavolat účetní');
  assert.equal(parse('Zavolat zítra').dueText, 'zítra');
  // a weekday: the next one, today counts; "příští" / "next" skips today
  assert.equal(due('Porada úterý'), '2026-11-10');
  assert.equal(due('Porada příští úterý'), '2026-11-17');
  assert.equal(due('Porada next tuesday'), '2026-11-17');
  assert.equal(due('Porada v pátek'), '2026-11-13');
  assert.equal(due('Porada ve středu'), '2026-11-11');
  assert.equal(due('Porada v sobotu'), '2026-11-14');
  assert.equal(due('Porada v neděli'), '2026-11-15');
  assert.equal(due('Porada pondělí'), '2026-11-16');
  assert.equal(due('Porada on monday'), '2026-11-16');
  assert.equal(due('Porada příští pátek'), '2026-11-13');
  assert.equal(parse('Porada ve středu ráno').content, 'Porada ráno');
  assert.equal(parse('Porada ve středu ráno').dueText, 've středu');
  assert.equal(due('Porada příští týden'), '2026-11-16');
  assert.equal(due('Porada next week'), '2026-11-16');
  // relative
  assert.equal(due('Ozvat se za 3 dny'), '2026-11-13');
  assert.equal(due('Ozvat se za 1 den'), '2026-11-11');
  assert.equal(due('Ozvat se za 10 dní'), '2026-11-20');
  assert.equal(due('Ozvat se za týden'), '2026-11-17');
  assert.equal(due('Ozvat se za 2 týdny'), '2026-11-24');
  assert.equal(due('Ozvat se za měsíc'), '2026-12-10');
  assert.equal(due('Ozvat se za 3 měsíce'), '2027-02-10');
  assert.equal(due('Ozvat se in 2 days'), '2026-11-12');
  assert.equal(due('Ozvat se in a week'), '2026-11-17');
  assert.equal(parse('Ozvat se za 3 dny').content, 'Ozvat se');
  assert.equal(due('Zaplatit za elektřinu'), null);
  assert.equal(due('Dárek za 100 Kč'), null);
  // at most three digits: a huge number is plain text instead of a date math overflow
  p = parse('Ozvat se za 100000000 dní');
  assert.deepEqual([p.due, p.content], [null, 'Ozvat se za 100000000 dní']);
  assert.equal(due('Ozvat se za 1000 dní'), null);
  assert.equal(due('Ozvat se za 999 dní'), '2029-08-05');
  assert.equal(due('Ozvat se za 999 měsíců'), '2110-02-10');
  // explicit dates: past ones without a year mean next year
  assert.equal(due('Schůzka 12.11.'), '2026-11-12');
  assert.equal(due('Schůzka 12. 11.'), '2026-11-12');
  assert.equal(due('Schůzka 12. 11. 2027'), '2027-11-12');
  assert.equal(due('Schůzka 12.11.27'), '2027-11-12');
  assert.equal(due('Schůzka 3. 1.'), '2027-01-03');
  assert.equal(due('Schůzka 10. 11.'), '2026-11-10');
  assert.equal(due('Schůzka 2026-12-24'), '2026-12-24');
  assert.equal(due('Schůzka 31. 2.'), null);
  assert.equal(due('Schůzka 5. 13.'), null);
  assert.equal(parse('Schůzka 12. 11. s Petrem').content, 'Schůzka s Petrem');
  assert.equal(parse('Verze 2.0. vydat').due, null);
  // every occurrence is tried: the first one that is a real day counts
  p = parse('Verze 2.0. vydat 12. 11.');
  assert.deepEqual([p.due, p.content], ['2026-11-12', 'Verze 2.0. vydat']);
  // a year is 20xx or two digits glued to the dot – a number after the date is just text
  p = parse('Mikuláš 5. 12. 10 balíčků');
  assert.deepEqual([p.due, p.content], ['2026-12-05', 'Mikuláš 10 balíčků']);
  p = parse('Objednat 5. 12. 1000 kusů');
  assert.deepEqual([p.due, p.content], ['2026-12-05', 'Objednat 1000 kusů']);
  assert.equal(due('Schůzka 12.11.2027'), '2027-11-12');
  // only the first date counts, the rest is text
  const two = parse('Zítra připravit porady na pátek');
  assert.deepEqual([two.due, two.content], ['2026-11-13', 'Zítra připravit porady na']);
});

test('a time: 14:00 or v 14:00, alone it leaves the day to the caller', () => {
  let p = parse('Zubař zítra v 14:30');
  assert.deepEqual([p.due, p.time, p.content], ['2026-11-11', '14:30', 'Zubař']);
  p = parse('Zubař 9:05');
  assert.deepEqual([p.due, p.time, p.content], [null, '09:05', 'Zubař']);
  assert.equal(hasMacros(p), true);
  p = parse('Zubař pátek at 16:00');
  assert.deepEqual([p.due, p.time], ['2026-11-13', '16:00']);
  assert.equal(parse('Skóre 30:70').time, null);
  assert.equal(parse('Skóre 30:70').content, 'Skóre 30:70');
  assert.equal(parse('Poměr 12:99').time, null);
  // every occurrence is tried: the first real clock time counts
  p = parse('Skóre 30:70 zítra v 14:00');
  assert.deepEqual([p.due, p.time, p.content], ['2026-11-11', '14:00', 'Skóre 30:70']);
});

test('everything at once, in any order', () => {
  const p = parse('!!1 Domácí úkol z matiky #skola @doma zítra v 18:00 // strana 42, cvičení 3');
  assert.deepEqual(p, {
    content: 'Domácí úkol z matiky', description: 'strana 42, cvičení 3', priority: 4, projectId: 'p2', project: 'Škola', unknownProject: null,
    labels: ['doma'], due: '2026-11-11', dueText: 'zítra', time: '18:00',
  });
  assert.equal(hasMacros(p), true);
  assert.equal(parse('zítra #skola !!2').content, '');
});

test('folding drops diacritics and case but keeps the length, in any script', () => {
  assert.equal(fold('Škola Žďár'), 'skola zdar');
  for (const s of ['Příliš žluťoučký kůň', 'Koupit がっこう zítra ráno', 'Napsat 김민수 zítra ráno', 'Spin\u0308al Tap', 'İstanbul 😀']) {
    assert.equal(fold(s).length, s.normalize('NFC').length, s);
  }
  assert.equal(fold('Napsat 김민수 Zítra'), 'napsat 김민수 zitra'); // what can't be folded in place stays as it is
  let p = parse('Napsat 김민수 zítra ráno');
  assert.deepEqual([p.due, p.content], ['2026-11-11', 'Napsat 김민수 ráno']);
  p = parse('Koupit がっこう zítra ráno');
  assert.deepEqual([p.due, p.content], ['2026-11-11', 'Koupit がっこう ráno']);
  p = parse('Spin\u0308al Tap zítra ráno'); // n with a combining diaeresis – no precomposed form
  assert.deepEqual([p.due, p.content], ['2026-11-11', 'Spin\u0308al Tap ráno']);
});
