'use strict';

// Synthetic rows and labels for the evaluation set.
// This file does not import the resolver, the scorer, or the importer.
// Identity truth comes from the recipe. The policy-expected outcome is the
// decision the written policy implies. Neither field is taken from a run.

const SEED = 'synthetic-set-b-v1';

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

const FIRST_B = [
  'Greta', 'Hugo', 'Irene', 'Jules', 'Kira', 'Leona', 'Marcel', 'Nadine',
  'Omar', 'Phoebe', 'Quentin', 'Rosa', 'Selene', 'Tobias', 'Una', 'Victor',
  'Wynn', 'Ximena', 'Yves', 'Zora', 'Adrian', 'Blake', 'Celeste', 'Damon',
  'Esther', 'Flora', 'Gideon', 'Hazel', 'Ines', 'Jonas', 'Keira', 'Lionel',
  'Maren', 'Nils', 'Odette', 'Paolo', 'Quinn', 'Reva', 'Soren', 'Tessa',
  'Ulric', 'Veda', 'Wesley', 'Xenia', 'Yara', 'Zane', 'Anya', 'Bram',
  'Cora', 'Dax', 'Elsa', 'Finn', 'Gia', 'Holt', 'Isla', 'Joss',
  'Kian', 'Lila', 'Milo', 'Noa', 'Orla', 'Pia', 'Remy', 'Sable',
  'Theo', 'Uma', 'Vito', 'Willa', 'Xavi', 'Yael', 'Zeke', 'Amina',
  'Bodhi', 'Cleo', 'Daria', 'Enzo', 'Freya', 'Gael', 'Hana', 'Idris',
];

const LAST_B = [
  'Ashford', 'Bellamy', 'Crowe', 'Drayton', 'Elwood', 'Fairchild', 'Goddard', 'Hargrove',
  'Inwood', 'Jarvis', 'Keating', 'Llewellyn', 'Marchand', 'Northcott', 'Oakley', 'Penrose',
  'Quill', 'Redmond', 'Sheldon', 'Tindall', 'Unwin', 'Vale', 'Whitaker', 'Yardley',
  'Zeller', 'Armitage', 'Blakemore', 'Croft', 'Dalloway', 'Ellsworth', 'Fenwick', 'Gresham',
  'Holbrook', 'Isley', 'Juniper', 'Kestrel', 'Langley', 'Merrick', 'Niles', 'Osborne',
  'Prescott', 'Quimby', 'Ralston', 'Sutter', 'Tolland', 'Ulric', 'Vickers', 'Wainwright',
  'Yarrow', 'Beckett', 'Callahan', 'Drummond', 'Easton', 'Fenton', 'Glover', 'Hartley',
  'Iverson', 'Judd', 'Keene', 'Lawton', 'Maddox', 'Neville', 'Ogden', 'Pruitt',
  'Rourke', 'Stanton', 'Talbot', 'Updike', 'Vernon', 'Winslow', 'Yeager', 'Barlow',
  'Corbett', 'Duvall', 'Elgin', 'Faraday', 'Gilmore', 'Hewitt', 'Irving', 'Jarrell',
];

const FAMILY_FIRST = [
  'Carmen', 'Diego', 'Elena', 'Fabio', 'Gloria', 'Hector', 'Ingrid', 'Jorge',
  'Katia', 'Luis', 'Marta', 'Nico', 'Olga', 'Pablo', 'Rita', 'Sergio',
  'Teresa', 'Ulises',
];

const TYPO_PAIRS = [
  ['Bramley', 'Bramly'],
  ['Ostler', 'Ostlar'],
  ['Quinlan', 'Quinlen'],
  ['Sutcliffe', 'Sutclife'],
];

const MARRIED = ['Alden', 'Briscoe', 'Carver', 'Dewitt'];

const OTHER_LAST = ['Harlow', 'Ingram', 'Jessup', 'Kenway', 'Larkin', 'Minton'];

const CO1_NICKS = [
  ['Robert', 'Bob'],
  ['William', 'Bill'],
  ['Elizabeth', 'Liz'],
  ['James', 'Jim'],
];

const POLICY = {
  emailDifferentBirthday: 'A review opens only when every stored birthday differs from the inbound birthday.',
  missingBirthdayHard: 'A missing birthday on either side keeps the hard match.',
  sameBirthdayHard: 'The same exact name and the same birthday.',
  emailSameBirthday: 'One stored birthday that matches keeps the hard match, even if another stored birthday on that person differs.',
  blockKeys: 'If the lookup misses, the system searches only people who share an exact email, an exact guardian email, or the same last name and the same birthday.',
  nameReview: 'A review opens only when every stored birthday differs from the inbound birthday.',
  lowScoreReview: 'A name and the same birthday can still open a review when the score is low, unless another person already scores high enough for review.',
  nicknameScored: 'A nickname or a close spelling is scored only when a search key already found that person.',
  phoneIgnored: 'The matcher does not read it, so a phone on a file cannot find a person and cannot be compared with a birthday.',
  phoneSecondWrite: 'A second person cannot store the same phone. The first person is already saved, so the second write fails. That failure is not a review.',
  oneEmail: 'One email, and one phone, still belong to one person in an organization, outside household rows.',
};

const SET_B_PLAN = [
  { id: 'SFE-1', group: 'shared_family_email', cases: 8, truth: 'distinct_person', policy: 'review', path: 'D', flag: null },
  { id: 'SFE-2', group: 'shared_family_email', cases: 6, truth: 'distinct_person', policy: 'hard_match', path: 'A', flag: 'S0' },
  { id: 'SFE-3', group: 'shared_family_email', cases: 3, truth: 'distinct_person', policy: 'hard_match', path: 'A', flag: 'S0' },
  { id: 'RP-1', group: 'recycled_phone', cases: 6, truth: 'distinct_person', policy: 'import_error', path: 'B', flag: 'S1' },
  { id: 'RP-2', group: 'recycled_phone', cases: 4, truth: 'same_person', policy: 'import_error', path: 'D', flag: 'S1' },
  { id: 'MB-1', group: 'missing_birthday', cases: 4, truth: 'same_person', policy: 'hard_match', path: 'A', flag: null },
  { id: 'MB-2', group: 'missing_birthday', cases: 5, truth: 'same_person', policy: 'separate', path: 'B', flag: 'S2' },
  { id: 'MB-3', group: 'missing_birthday', cases: 5, truth: 'distinct_person', policy: 'hard_match', path: 'A', flag: 'S0' },
  { id: 'MB-4', group: 'missing_birthday', cases: 5, truth: 'same_person', policy: 'hard_match', path: 'A', flag: null },
  { id: 'CA-1', group: 'conflicting_attributes', cases: 5, truth: 'same_person', policy: 'review', path: 'D', flag: null },
  { id: 'CA-2', group: 'conflicting_attributes', cases: 4, truth: 'same_person', policy: 'hard_match', path: 'A', flag: null },
  { id: 'CA-3', group: 'conflicting_attributes', cases: 5, truth: 'distinct_person', policy: 'review', path: 'D', flag: null },
  { id: 'CA-4', group: 'conflicting_attributes', cases: 5, truth: 'distinct_person', policy: 'hard_match', path: 'A', flag: 'S0' },
  { id: 'CA-5', group: 'conflicting_attributes', cases: 3, truth: 'distinct_person', policy: 'review', path: 'D', flag: null },
  { id: 'CO-1', group: 'combination', cases: 4, truth: 'same_person', policy: 'separate', path: 'B', flag: 'S2' },
  { id: 'CO-2', group: 'combination', cases: 4, truth: 'same_person', policy: 'separate', path: 'B', flag: 'S2' },
  { id: 'CO-3', group: 'combination', cases: 4, truth: 'same_person', policy: 'review', path: 'C', flag: null },
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

function addYears(iso, years) {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0, 10);
}

function emailFor(first, last, tag) {
  return `${first}.${last}.${tag}`.toLowerCase().replace(/[^a-z0-9.@]/g, '') + '@example.com';
}

function zipFor(index) {
  const zips = ['73101', '10001', '60601', '94105', '02108', '30301', '98101', '80202', '19103', '55401'];
  return zips[index % zips.length];
}

function row(first, last, email, birthday, zip, phone) {
  return {
    first_name: first,
    last_name: last,
    email,
    birthday,
    zip,
    phone: phone || '',
  };
}

function firstNameFor(index) {
  if (index < NICKNAMES.length) return NICKNAMES[index][0];
  if (index < NICKNAMES.length + SPELLING.length) return SPELLING[index - NICKNAMES.length][0];
  return FIRST[index];
}

function buildDataset() {
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

  return {
    originals,
    sameEmail,
    reviewByNickname,
    reviewBySpelling,
    reviewBySameName,
    highScore,
    differentBirthday,
    rows,
  };
}

function birthdayForCase(index) {
  const year = 1990 + Math.floor(index / 12);
  const month = (index % 12) + 1;
  let day = ((index + 5) % 12) + 1;
  if (day === month) day = (day % 12) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function swapMonthDay(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  if (day < 1 || day > 12 || day === month) {
    throw new Error(`cannot swap month and day of ${iso}`);
  }
  const swapped = new Date(Date.UTC(year, day - 1, month));
  if (swapped.getUTCMonth() !== day - 1 || swapped.getUTCDate() !== month) {
    throw new Error(`swap of ${iso} is not a real date`);
  }
  const text = swapped.toISOString().slice(0, 10);
  if (text < '1990-01-01' || text > '2005-12-31') {
    throw new Error(`swap of ${iso} left the 1990-2005 range`);
  }
  return text;
}

function zipForCase(index) {
  return String(80000 + index);
}

function otherZip(index) {
  return String(81000 + index);
}

function phoneFor(index) {
  return `405-555-${String(100 + index).padStart(4, '0')}`;
}

function caseList() {
  const cases = [];
  for (const scenario of SET_B_PLAN) {
    for (let index = 0; index < scenario.cases; index += 1) {
      cases.push({ scenario, index, global: cases.length });
    }
  }
  if (cases.length !== 80) throw new Error(`expected 80 Set B cases, built ${cases.length}`);
  return cases;
}

function blank(record) {
  return row(record.first, record.last, record.email, record.birthday, record.zip, record.phone);
}

function buildCasePair(entry, counters) {
  const { scenario, index, global } = entry;
  const caseId = `${scenario.id}-${String(index + 1).padStart(2, '0')}`;
  const slug = caseId.toLowerCase();
  const sharedEmail = `${slug}@example.org`;
  const anchorEmail = `${slug}.a@example.org`;
  const probeEmail = `${slug}.b@example.org`;
  const birthday = birthdayForCase(global);
  const zip = zipForCase(global);
  const altZip = otherZip(global);
  let anchorLast = LAST_B[global];
  let probeLast = anchorLast;
  let anchorFirst = FIRST_B[global];
  let probeFirst = FAMILY_FIRST[index % FAMILY_FIRST.length];
  let anchorBirthday = birthday;
  let probeBirthday = birthday;
  let anchorMail = anchorEmail;
  let probeMail = probeEmail;
  let anchorZip = zip;
  let probeZip = zip;
  let anchorPhone = '';
  let probePhone = '';

  if (scenario.id === 'CO-2') {
    anchorLast = TYPO_PAIRS[index][0];
    probeLast = TYPO_PAIRS[index][1];
    probeFirst = anchorFirst;
  } else if (scenario.id === 'CO-1') {
    anchorFirst = CO1_NICKS[index][0];
    probeFirst = CO1_NICKS[index][1];
  } else if (scenario.id === 'CA-2') {
    probeLast = MARRIED[index];
    probeFirst = anchorFirst;
  } else if (scenario.id === 'RP-1') {
    probeLast = OTHER_LAST[index];
    probeFirst = FAMILY_FIRST[index];
  }

  switch (scenario.id) {
    case 'SFE-1':
      anchorMail = sharedEmail;
      probeMail = sharedEmail;
      probeBirthday = addYears(birthday, 2);
      probeZip = altZip;
      break;
    case 'SFE-2':
      anchorMail = sharedEmail;
      probeMail = sharedEmail;
      probeBirthday = '';
      probeZip = altZip;
      break;
    case 'SFE-3':
      anchorMail = sharedEmail;
      probeMail = sharedEmail;
      probeZip = altZip;
      break;
    case 'RP-1':
      anchorPhone = phoneFor(counters.phone);
      probePhone = anchorPhone;
      counters.phone += 1;
      probeBirthday = addYears(birthday, 3);
      probeZip = altZip;
      break;
    case 'RP-2':
      probeFirst = anchorFirst;
      anchorPhone = phoneFor(counters.phone);
      probePhone = anchorPhone;
      counters.phone += 1;
      probeZip = altZip;
      break;
    case 'MB-1':
      probeFirst = anchorFirst;
      anchorMail = sharedEmail;
      probeMail = sharedEmail;
      probeBirthday = '';
      break;
    case 'MB-2':
      probeFirst = anchorFirst;
      probeBirthday = '';
      probeZip = altZip;
      break;
    case 'MB-3':
      probeFirst = anchorFirst;
      anchorBirthday = '';
      probeMail = '';
      probeBirthday = birthday;
      break;
    case 'MB-4':
      probeFirst = anchorFirst;
      anchorBirthday = '';
      probeMail = '';
      probeBirthday = birthday;
      break;
    case 'CA-1':
      probeFirst = anchorFirst;
      anchorMail = sharedEmail;
      probeMail = sharedEmail;
      probeBirthday = swapMonthDay(birthday);
      break;
    case 'CA-2':
      anchorMail = sharedEmail;
      probeMail = sharedEmail;
      break;
    case 'CA-3':
      probeFirst = anchorFirst;
      probeMail = '';
      probeBirthday = addYears(birthday, 2);
      break;
    case 'CA-4':
      probeFirst = anchorFirst;
      probeMail = '';
      break;
    case 'CA-5':
      probeFirst = anchorFirst;
      probeZip = altZip;
      break;
    case 'CO-1':
      probeBirthday = swapMonthDay(birthday);
      probeZip = altZip;
      break;
    case 'CO-2':
      probeZip = altZip;
      break;
    case 'CO-3':
      probeFirst = anchorFirst;
      anchorMail = '';
      probeMail = probeEmail;
      break;
    default:
      throw new Error(`unknown scenario ${scenario.id}`);
  }

  return {
    caseId,
    scenario,
    global,
    anchor: blank({
      first: anchorFirst,
      last: anchorLast,
      email: anchorMail,
      birthday: anchorBirthday,
      zip: anchorZip,
      phone: anchorPhone,
    }),
    probe: blank({
      first: probeFirst,
      last: probeLast,
      email: probeMail,
      birthday: probeBirthday,
      zip: probeZip,
      phone: probePhone,
    }),
  };
}

function blockKeys(record) {
  const keys = [];
  if (record.email) keys.push(`email:${record.email.toLowerCase()}`);
  if (record.phone) keys.push(`phone:${record.phone}`);
  if (record.first_name && record.last_name) {
    keys.push(`name:${record.first_name} ${record.last_name}`.toLowerCase());
  }
  if (record.last_name && record.birthday) {
    keys.push(`last_dob:${record.last_name.toLowerCase()}|${record.birthday}`);
  }
  return keys;
}

function assertSetBIsolated(setARows, pairs) {
  const holders = new Map();
  function claim(caseId, record) {
    for (const key of blockKeys(record)) {
      if (!holders.has(key)) holders.set(key, new Set());
      holders.get(key).add(caseId);
    }
  }
  setARows.forEach((record, index) => claim(`set-a-${index}`, record));
  for (const pair of pairs) {
    claim(pair.caseId, pair.anchor);
    claim(pair.caseId, pair.probe);
  }
  for (const pair of pairs) {
    for (const key of blockKeys(pair.probe)) {
      const owners = [...holders.get(key)];
      const outside = owners.filter((owner) => owner !== pair.caseId);
      if (outside.length > 0) {
        throw new Error(`${pair.caseId} probe shares ${key} with ${outside.join(', ')}`);
      }
    }
  }
}

function assertNamePools() {
  if (LAST_B.length !== 80) throw new Error(`LAST_B has ${LAST_B.length} names`);
  if (FIRST_B.length !== 80) throw new Error(`FIRST_B has ${FIRST_B.length} names`);
  const setALast = new Set(LAST.map((name) => name.toLowerCase()));
  const used = [];
  for (const name of [...LAST_B, ...TYPO_PAIRS.flat(), ...MARRIED, ...OTHER_LAST]) {
    if (setALast.has(name.toLowerCase())) throw new Error(`Set B last name overlaps Set A: ${name}`);
    used.push(name.toLowerCase());
  }
  if (new Set(used).size !== used.length) throw new Error('Set B last names are not unique');
}

function buildExtension() {
  assertNamePools();
  const pairs = [];
  const counters = { phone: 0 };
  for (const entry of caseList()) pairs.push(buildCasePair(entry, counters));
  if (counters.phone !== 10) throw new Error(`expected 10 phone cases, built ${counters.phone}`);
  const setARows = buildDataset().rows;
  assertSetBIsolated(setARows, pairs);
  const anchors = pairs.map((pair) => pair.anchor);
  const probes = pairs.map((pair) => pair.probe);
  return { pairs, rows: [...anchors, ...probes] };
}

function disagreement(truth, policy) {
  if (truth === 'distinct_person' && policy === 'hard_match') return 'S0';
  if (truth === 'same_person' && policy === 'separate') return 'S2';
  return null;
}

function makeLabel(fields) {
  const computed = disagreement(fields.identity_truth, fields.policy_expected);
  let flag = computed;
  if (fields.plannedFlag === 'S1') {
    if (computed) throw new Error(`${fields.case_id} is both S1 and ${computed}`);
    flag = 'S1';
  } else if (computed !== fields.plannedFlag) {
    throw new Error(`${fields.case_id} flag ${fields.plannedFlag} does not match ${computed}`);
  }
  return {
    row: fields.row,
    set: fields.set,
    scenario_id: fields.scenario_id,
    case_group: fields.case_group,
    case_id: fields.case_id,
    role: fields.role,
    person_key: fields.person_key,
    anchor_row: fields.anchor_row,
    identity_truth: fields.identity_truth,
    truth_basis: 'recipe',
    indistinguishable: fields.indistinguishable === true,
    policy_expected: fields.policy_expected,
    expected_path: fields.expected_path,
    policy_basis: fields.policy_basis,
    severity_if_auto_merged: fields.identity_truth === 'distinct_person' ? 'S0' : null,
    flag,
    truth_policy_disagreement: computed !== null,
    notes: fields.notes,
  };
}

function labelSetA(dataset) {
  const labels = [];
  dataset.originals.forEach((_, index) => {
    const rowNumber = index + 1;
    labels.push(makeLabel({
      row: rowNumber,
      set: 'A',
      scenario_id: 'A-ORIGINAL',
      case_group: 'first_seen',
      case_id: `A-ORIGINAL-${String(rowNumber).padStart(2, '0')}`,
      role: 'first_seen',
      person_key: `original-${rowNumber}`,
      anchor_row: null,
      identity_truth: 'first_seen',
      policy_expected: 'separate',
      expected_path: 'B',
      plannedFlag: null,
      policy_basis: POLICY.blockKeys,
      notes: 'First row of this person. No earlier row shares a block key, so the block is empty.',
    }));
  });

  function probe(list, scenarioId, group, startRow, anchorIndex, truth, policy, path, basis, notes, plannedFlag) {
    list.forEach((_, index) => {
      const source = anchorIndex(index);
      const same = truth === 'same_person';
      labels.push(makeLabel({
        row: startRow + index,
        set: 'A',
        scenario_id: scenarioId,
        case_group: group,
        case_id: `${scenarioId}-${String(index + 1).padStart(2, '0')}`,
        role: 'probe',
        person_key: same ? `original-${source + 1}` : `distinct-${scenarioId}-${index + 1}`,
        anchor_row: source + 1,
        identity_truth: truth,
        policy_expected: policy,
        expected_path: path,
        plannedFlag,
        policy_basis: basis,
        notes,
      }));
    });
  }

  probe(
    dataset.sameEmail, 'A-SAME-EMAIL', 'idempotency', 81, (index) => index,
    'same_person', 'import_replay', 'B', POLICY.oneEmail,
    'Byte-identical copy of the anchor. The import row key matches, so the resolver is not called and the stored path stays the anchor path B.',
    null
  );
  probe(
    dataset.reviewByNickname, 'A-NICKNAME', 'floor_review', 86, (index) => index,
    'same_person', 'review', 'D', POLICY.nicknameScored,
    'Same person, nickname, different email and ZIP, same birthday. The name and birthday keep a low score in review.',
    null
  );
  probe(
    dataset.reviewBySpelling, 'A-SPELLING', 'floor_review', 96, (index) => 10 + index,
    'same_person', 'review', 'D', POLICY.nicknameScored,
    'Same person, first-name spelling variant, different email and ZIP, same birthday. The name and birthday keep a low score in review.',
    null
  );
  probe(
    dataset.reviewBySameName, 'A-SAME-NAME', 'floor_review', 106, (index) => 20 + index,
    'same_person', 'review', 'D', POLICY.lowScoreReview,
    'Same person, same name and birthday, different email and ZIP. The name and birthday keep a low score in review.',
    null
  );
  probe(
    dataset.highScore, 'A-NO-EMAIL', 'exact_name', 126, (index) => 40 + index,
    'same_person', 'hard_match', 'A', POLICY.sameBirthdayHard,
    'Same person. The probe has no email, so the name is the singular identifier, and the birthday matches.',
    null
  );
  probe(
    dataset.differentBirthday, 'A-DIFF-DOB', 'easy_negative', 141, (index) => index,
    'distinct_person', 'separate', 'B', POLICY.blockKeys,
    'Different person. Different first name and a birthday one year later, so no block key hits. Never scored.',
    null
  );

  if (labels.length !== 200) throw new Error(`Set A labels ${labels.length}`);
  return labels;
}

function policyBasisFor(scenario) {
  switch (scenario.id) {
    case 'SFE-1':
    case 'CA-1':
      return POLICY.emailDifferentBirthday;
    case 'SFE-2':
    case 'MB-1':
    case 'MB-3':
    case 'MB-4':
      return POLICY.missingBirthdayHard;
    case 'SFE-3':
    case 'CA-2':
      return POLICY.emailSameBirthday;
    case 'RP-1':
    case 'RP-2':
      return POLICY.phoneSecondWrite;
    case 'MB-2':
    case 'CO-1':
    case 'CO-2':
      return POLICY.blockKeys;
    case 'CA-3':
      return POLICY.nameReview;
    case 'CA-4':
      return POLICY.sameBirthdayHard;
    case 'CA-5':
    case 'CO-3':
      return POLICY.lowScoreReview;
    default:
      throw new Error(`no policy basis for ${scenario.id}`);
  }
}

function notesFor(scenario) {
  switch (scenario.id) {
    case 'SFE-1':
      return 'Distinct family member, shared email, both birthdays present and different. The email birthday review opens. The original person keeps the email.';
    case 'SFE-2':
      return 'Distinct family member, shared email, probe birthday missing. A missing birthday keeps the email hard match.';
    case 'SFE-3':
      return 'Distinct twins, shared email, same birthday. The matching birthday keeps the email hard match.';
    case 'RP-1':
      return 'Distinct person, same phone, nothing else shared. The matcher does not read the phone, so the row is new. The second phone write then fails.';
    case 'RP-2':
      return 'Same person, same phone, new email, different ZIP, same name and birthday. The name and birthday keep a low score in review. The second phone write then fails.';
    case 'MB-1':
      return 'Same person, same email, probe birthday missing. A missing birthday keeps the hard match.';
    case 'MB-2':
      return 'Same person, new email, probe birthday missing. The email misses and there is no birthday to block on, so the row is new.';
    case 'MB-3':
      return 'Distinct namesake. The anchor has an email and no birthday. The probe has the same name, no email, and a birthday. A missing stored birthday keeps the name hard match.';
    case 'MB-4':
      return 'Same person. The anchor has an email and no birthday. The probe has the same name, no email, and a birthday. A missing stored birthday keeps the name hard match.';
    case 'CA-1':
      return 'Same person, same email and name, birthday month and day swapped. Both birthdays are present and different, so the email review opens.';
    case 'CA-2':
      return 'Same person, same email and birthday, married last name. The matching birthday keeps the email hard match.';
    case 'CA-3':
      return 'Distinct namesake, same name, different birthday, probe has no email. The name birthday review opens.';
    case 'CA-4':
      return 'Distinct namesake, same name and birthday, probe has no email. Exact name plus the same birthday is a hard match. The fields on the probe do not separate the two people.';
    case 'CA-5':
      return 'Distinct namesake, same name and birthday, new email, different ZIP. The name and birthday keep a low score in review.';
    case 'CO-1':
      return 'Same person, nickname, birthday month and day swapped, new email. The birthday no longer matches, and the email misses, so the row is new.';
    case 'CO-2':
      return 'Same person, last-name typo, same birthday, new email. The block uses the exact last word, and the email misses, so the row is new.';
    case 'CO-3':
      return 'Same person. The anchor has no email. The probe adds an email and repeats the name, birthday, and ZIP. The email misses, the name and birthday are found, and the agreeing fields score at the top of the scale.';
    default:
      throw new Error(`no notes for ${scenario.id}`);
  }
}

function labelSetB(pairs) {
  const labels = [];
  pairs.forEach((pair, index) => {
    const same = pair.scenario.truth === 'same_person';
    const personKey = same ? pair.caseId : `${pair.caseId}#anchor`;
    labels.push(makeLabel({
      row: 201 + index,
      set: 'B',
      scenario_id: pair.scenario.id,
      case_group: pair.scenario.group,
      case_id: pair.caseId,
      role: 'anchor',
      person_key: personKey,
      anchor_row: null,
      identity_truth: 'first_seen',
      policy_expected: 'separate',
      expected_path: 'B',
      plannedFlag: null,
      policy_basis: POLICY.blockKeys,
      notes: 'Anchor for this case. Imported before its probe. No earlier Set B row shares its block keys.',
    }));
  });
  pairs.forEach((pair, index) => {
    const same = pair.scenario.truth === 'same_person';
    labels.push(makeLabel({
      row: 281 + index,
      set: 'B',
      scenario_id: pair.scenario.id,
      case_group: pair.scenario.group,
      case_id: pair.caseId,
      role: 'probe',
      person_key: same ? pair.caseId : `${pair.caseId}#probe`,
      anchor_row: 201 + index,
      identity_truth: pair.scenario.truth,
      indistinguishable: pair.scenario.id === 'CA-4',
      policy_expected: pair.scenario.policy,
      expected_path: pair.scenario.path,
      plannedFlag: pair.scenario.flag,
      policy_basis: policyBasisFor(pair.scenario),
      notes: notesFor(pair.scenario),
    }));
  });
  return labels;
}

function tally(labels, key) {
  const totals = {};
  for (const label of labels) totals[label[key]] = (totals[label[key]] || 0) + 1;
  return totals;
}

function buildGroundTruth() {
  const dataset = buildDataset();
  const extension = buildExtension();
  const labels = [...labelSetA(dataset), ...labelSetB(extension.pairs)];
  if (labels.length !== 360) throw new Error(`expected 360 labels, built ${labels.length}`);
  labels.forEach((label, index) => {
    if (label.row !== index + 1) throw new Error(`row ${label.row} is out of order`);
  });
  const disagreements = labels.filter((label) => label.truth_policy_disagreement).length;
  return {
    version: 2,
    seed: SEED,
    description: 'Ground truth for Set A (the original 200 rows) and Set B (80 anchor and probe cases). Identity truth comes from the recipe. The policy-expected outcome is what the written matching policy implies. Assigned before any resolver or import run.',
    row_count: labels.length,
    set_a_rows: 200,
    set_b_rows: 160,
    disagreement_count: disagreements,
    scenario_counts: tally(labels, 'scenario_id'),
    labels,
  };
}

function csvText(rows) {
  const header = 'first_name,last_name,email,birthday,zip,phone';
  const lines = rows.map((built) => [
    built.first_name, built.last_name, built.email, built.birthday, built.zip, built.phone,
  ].join(','));
  return `${header}\n${lines.join('\n')}\n`;
}

function serializeDocument(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

module.exports = {
  SEED,
  SET_B_PLAN,
  POLICY,
  buildDataset,
  buildExtension,
  buildGroundTruth,
  csvText,
  serializeDocument,
  blockKeys,
};
