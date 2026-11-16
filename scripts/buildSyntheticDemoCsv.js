'use strict';

// Builds demo/synthetic-customers-200.csv.
// Original people come first. Later rows resemble some of them so the
// existing importer and matcher can open reviews. Nothing here is a real person.

const fs = require('fs');
const path = require('path');
const { parseCustomerRow } = require('../src/modules/customerImport');
const { normalizeIdentifier } = require('../src/modules/normalizer');
const { scoreMatch } = require('../src/modules/probabilisticMatcher');

const FIRST = [
  'Ava', 'Noah', 'Mia', 'Liam', 'Sofia', 'Ethan', 'Amelia', 'Lucas',
  'Harper', 'Mason', 'Ella', 'Logan', 'Aria', 'Jacob', 'Luna', 'Owen',
  'Chloe', 'Caleb', 'Nora', 'Isaac', 'Zoe', 'Nathan', 'Lily', 'Aaron',
  'Hannah', 'Eli', 'Grace', 'Leo', 'Stella', 'Miles', 'Ruby', 'Felix',
  'Iris', 'Hugo', 'Willa', 'Theo', 'Clara', 'Jonah', 'Pearl', 'Simon',
  'Freya', 'Oscar', 'Ada', 'Felix', 'Nina', 'Paul', 'Ruth', 'Seth',
  'Thea', 'Ivan', 'Cora', 'Joel', 'Daphne', 'Reed', 'Margot', 'Silas',
  'Esme', 'August', 'June', 'Beau', 'Opal', 'Arlo', 'Sadie', 'Roman',
  'Vera', 'Milo', 'Eden', 'Kai', 'Noor', 'Ida', 'Remy', 'Lila',
  'Otto', 'Nell', 'Jude', 'Priya', 'Hank', 'Yara', 'Cole', 'Anya',
];

const LAST = [
  'Adler', 'Bennett', 'Castillo', 'Dalton', 'Ellison', 'Foster', 'Garcia', 'Holland',
  'Ibarra', 'Jensen', 'Keller', 'Lang', 'Morales', 'Nash', 'Okada', 'Patel',
  'Quincy', 'Ramirez', 'Sato', 'Tran', 'Upton', 'Vargas', 'Walsh', 'Xu',
  'Young', 'Zimmer', 'Abbott', 'Brooks', 'Cho', 'Diaz', 'Edwards', 'Frost',
  'Gupta', 'Hayes', 'Ito', 'Jordan', 'Khan', 'Lopez', 'Meyer', 'Nguyen',
  'Owens', 'Park', 'Reyes', 'Singh', 'Torres', 'Underwood', 'Voss', 'Weber',
  'Xavier', 'Yamamoto', 'Zimmerman', 'Almeida', 'Bauer', 'Costa', 'Duarte', 'Estrada',
  'Fischer', 'Gomez', 'Hoffman', 'Ivanov', 'Johansson', 'Kowalski', 'Larsson', 'Moreau',
  'Novak', 'Okafor', 'Petrova', 'Rossi', 'Silva', 'Takahashi', 'Usman', 'Volkov',
  'Wright', 'Yilmaz', 'Andersen', 'Berg', 'Carter', 'Doyle', 'Engel', 'Ferreira',
];

const NICKNAMES = [
  ['Robert', 'Bob'],
  ['William', 'Bill'],
  ['Elizabeth', 'Liz'],
  ['James', 'Jim'],
  ['John', 'Jack'],
  ['Robert', 'Bobby'],
  ['William', 'Will'],
  ['Elizabeth', 'Beth'],
  ['James', 'Jamie'],
  ['John', 'Johnny'],
];

const SPELLING = [
  ['John', 'Jon'],
  ['Sarah', 'Sara'],
  ['Catherine', 'Catharine'],
  ['Philip', 'Phillip'],
  ['Ann', 'Anne'],
  ['Lindsey', 'Lindsay'],
  ['Kristen', 'Kristin'],
  ['Zachary', 'Zackary'],
  ['Megan', 'Meghan'],
  ['Eric', 'Erik'],
];

function dobFor(index) {
  const date = new Date(Date.UTC(1972, 0, 15));
  date.setUTCDate(date.getUTCDate() + index * 47);
  return date.toISOString().slice(0, 10);
}

function shiftDob(iso) {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  return date.toISOString().slice(0, 10);
}

function emailFor(first, last, tag) {
  return `${first}.${last}.${tag}`.toLowerCase().replace(/[^a-z0-9.@]/g, '') + '@example.com';
}

function zipFor(index) {
  const zips = ['73101', '10001', '60601', '94105', '02108', '30301', '98101', '80202', '19103', '55401'];
  return zips[index % zips.length];
}

function row(first, last, email, birthday, zip) {
  return { first_name: first, last_name: last, email, birthday, zip, phone: '' };
}

function firstNameFor(index) {
  if (index < NICKNAMES.length) return NICKNAMES[index][0];
  if (index < NICKNAMES.length + SPELLING.length) return SPELLING[index - NICKNAMES.length][0];
  return FIRST[index];
}

const originals = [];
for (let i = 0; i < 80; i += 1) {
  const first = firstNameFor(i);
  const last = LAST[i];
  originals.push(row(first, last, emailFor(first, last, '1'), dobFor(i), zipFor(i)));
}

const sameEmail = originals.slice(0, 5).map((person) => row(
  person.first_name,
  person.last_name,
  person.email,
  person.birthday,
  person.zip
));

const reviewByNickname = NICKNAMES.map(([formal, shortName], index) => {
  const person = originals[index];
  return row(shortName, person.last_name, emailFor(shortName, person.last_name, '2'), person.birthday, zipFor(index + 3));
});

const reviewBySpelling = SPELLING.map(([formal, variant], index) => {
  const person = originals[10 + index];
  return row(variant, person.last_name, emailFor(variant, person.last_name, '2'), person.birthday, zipFor(index + 5));
});

const reviewBySameName = originals.slice(20, 40).map((person, index) => row(
  person.first_name,
  person.last_name,
  emailFor(person.first_name, person.last_name, '2'),
  person.birthday,
  zipFor(index + 7)
));

const highScore = originals.slice(40, 55).map((person) => row(
  person.first_name,
  person.last_name,
  '',
  person.birthday,
  person.zip
));

const differentBirthday = originals.slice(0, 60).map((person, index) => row(
  FIRST[(index + 7) % FIRST.length],
  person.last_name,
  emailFor(FIRST[(index + 7) % FIRST.length], person.last_name, '3'),
  shiftDob(person.birthday),
  zipFor(index + 1)
));

const rows = [
  ...originals,
  ...sameEmail,
  ...reviewByNickname,
  ...reviewBySpelling,
  ...reviewBySameName,
  ...highScore,
  ...differentBirthday,
];

if (rows.length !== 200) {
  throw new Error(`expected 200 rows, built ${rows.length}`);
}

for (const [index, built] of rows.entries()) {
  const parsed = parseCustomerRow(built);
  if (!parsed.ok) throw new Error(`row ${index + 1} failed: ${parsed.error}`);
}

const ORG = '00000000-0000-4000-8000-000000000001';

function normalizedPerson(built) {
  const parsed = parseCustomerRow(built);
  return {
    org_id: ORG,
    name: parsed.fields.name || null,
    email: parsed.fields.email || null,
    dob: parsed.fields.dob || null,
    zip: parsed.fields.zip || null,
  };
}

function expectReview(original, lookalike, label) {
  const result = scoreMatch(normalizedPerson(original), { ...normalizedPerson(lookalike), org_id: ORG });
  const signals = result.signals_matched.map((item) => item.signal);
  const review = result.score >= 0.85 || result.score >= 0.60 || signals.includes('name_plus_dob');
  if (!review || result.dob_veto) {
    throw new Error(`${label} did not score as a review: ${result.score} ${signals.join(',')}`);
  }
  return { label, kind: 'review', score: result.score, signals };
}

function expectNoReview(original, other, label) {
  const result = scoreMatch(normalizedPerson(original), { ...normalizedPerson(other), org_id: ORG });
  const signals = result.signals_matched.map((item) => item.signal);
  const review = !result.dob_veto && (result.score >= 0.60 || signals.includes('name_plus_dob'));
  if (review) {
    throw new Error(`${label} scored as a review: ${result.score} ${signals.join(',')}`);
  }
  return { label, kind: 'separate', score: result.score, veto: Boolean(result.dob_veto) };
}

const samples = [
  ...reviewByNickname.map((lookalike, index) => expectReview(originals[index], lookalike, `nickname ${index + 1}`)),
  ...reviewBySpelling.map((lookalike, index) => expectReview(originals[10 + index], lookalike, `spelling ${index + 1}`)),
  ...reviewBySameName.map((lookalike, index) => expectReview(originals[20 + index], lookalike, `same name ${index + 1}`)),
  ...highScore.map((lookalike, index) => expectReview(originals[40 + index], lookalike, `high score ${index + 1}`)),
  ...differentBirthday.map((other, index) => expectNoReview(originals[index], other, `different birthday ${index + 1}`)),
];

const header = 'first_name,last_name,email,birthday,zip,phone';
const lines = rows.map((built) => [built.first_name, built.last_name, built.email, built.birthday, built.zip, built.phone].join(','));
const outPath = path.join(__dirname, '..', 'demo', 'synthetic-customers-200.csv');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${header}\n${lines.join('\n')}\n`);

const reviewSamples = samples.filter((sample) => sample.kind === 'review');
const quietSamples = samples.filter((sample) => sample.kind === 'separate');
console.log(`wrote ${rows.length} rows to ${outPath}`);
console.log(`scored ${reviewSamples.length} lookalikes as reviews and ${quietSamples.length} different-birthday rows as separate people`);
